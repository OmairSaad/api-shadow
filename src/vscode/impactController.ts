import * as vscode from 'vscode';
import { AnalysisEngine } from '../core/engine';
import { defaultExcludeGlobs, PathExcluder } from '../core/exclude';
import { GitFileHost, gitCommit, gitRepoRoot } from '../core/gitHost';
import { analyzeImpact, type ImpactReport } from '../core/impact';
import { CancelledError, type AnalysisResult } from '../core/types';
import type { AnalysisController } from './analysisController';
import type { ChannelLogger } from './logger';

export type ImpactState =
  | { status: 'off'; reason: string }
  | { status: 'computing'; baseLabel: string }
  | { status: 'ready'; report: ImpactReport; note?: string }
  | { status: 'unavailable'; reason: string };

/** A baseline the user chose: a git revision, or a snapshot of the analysis at that moment. */
type Choice = { kind: 'ref'; ref: string } | { kind: 'snapshot' };

const CHOICE_KEY = 'apiShadow.impactBaseline';

/**
 * Keeps the impact baseline and recomputes the impact report after every analysis.
 *
 * The default baseline is git HEAD (uncommitted changes are the "change"), analyzed from the
 * repository without checking anything out, and re-analyzed only when HEAD moves. Without git,
 * in untrusted workspaces, or with `apiShadow.impact.baseline: session`, the first analysis of
 * the session is the baseline.
 */
export class ImpactController implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ImpactState>();
  readonly onDidChange = this.emitter.event;
  private current: ImpactState = { status: 'off', reason: 'Waiting for the first analysis.' };
  private baseline: { key: string; label: string; result: AnalysisResult } | undefined;
  private session: AnalysisResult | undefined;
  private snapshot: AnalysisResult | undefined;
  private cts: vscode.CancellationTokenSource | undefined;
  private queue: Promise<void> = Promise.resolve();
  private latest: AnalysisResult | undefined;

  constructor(
    private readonly analysis: AnalysisController,
    private readonly context: vscode.ExtensionContext,
    private readonly logger: ChannelLogger,
  ) {}

  get state(): ImpactState {
    return this.current;
  }

  get report(): ImpactReport | undefined {
    return this.current.status === 'ready' ? this.current.report : undefined;
  }

  /** Called with every new analysis result. Runs serially; a newer result supersedes an older one. */
  update(result: AnalysisResult): Promise<void> {
    this.session ??= result;
    this.latest = result;
    this.queue = this.queue.then(() => (this.latest === result ? this.run(result) : undefined)).catch((err) => this.logger.error(err instanceof Error ? err : String(err)));
    return this.queue;
  }

  /** Lets the user choose the baseline: HEAD, a branch or tag, or the current state. */
  async chooseBaseline(): Promise<void> {
    const repo = await this.repo();
    const items: (vscode.QuickPickItem & { choice?: Choice; reset?: boolean })[] = [
      { label: '$(git-commit) Last commit (HEAD)', description: 'default: impact of uncommitted changes', reset: true },
      { label: '$(history) Current state', description: 'impact of changes from now on', choice: { kind: 'snapshot' } },
    ];
    if (repo && vscode.workspace.isTrusted) items.push({ label: '$(git-branch) Branch, tag or commit…', description: 'e.g. main, to review a whole branch' });
    const pick = await vscode.window.showQuickPick(items, { title: 'API Shadow: Impact Baseline', placeHolder: 'Compare the current code with…' });
    if (!pick) return;
    let choice = pick.choice;
    if (!pick.reset && !choice) {
      const ref = await vscode.window.showInputBox({ title: 'Impact Baseline', prompt: 'Branch, tag or commit to compare with', value: 'main', validateInput: (v) => (/^[^\s-][^\s]*$/.test(v) ? undefined : 'Enter a branch, tag or commit') });
      if (!ref) return;
      choice = { kind: 'ref', ref };
    }
    if (choice?.kind === 'snapshot') this.snapshot = this.analysis.current;
    await this.context.workspaceState.update(CHOICE_KEY, choice);
    this.baseline = undefined;
    if (this.analysis.current) await this.update(this.analysis.current);
  }

  private async run(result: AnalysisResult): Promise<void> {
    const settings = this.analysis.settings.impact;
    if (!settings.enabled) return this.set({ status: 'off', reason: 'Impact analysis is turned off (apiShadow.impact.enabled).' });
    const choice = this.context.workspaceState.get<Choice>(CHOICE_KEY);
    if (choice?.kind === 'snapshot') {
      const base = this.snapshot ?? this.session!;
      return this.set({ status: 'ready', report: analyzeImpact(base, result, 'the chosen snapshot') });
    }
    const wantGit = choice?.kind === 'ref' || settings.baseline === 'gitHead';
    let note: string | undefined;
    if (wantGit) {
      const repo = await this.repo();
      if (!vscode.workspace.isTrusted) note = 'Using the session start as baseline: comparing with git needs a trusted workspace.';
      else if (!repo) note = 'Using the session start as baseline: the workspace is not in a git repository.';
      else {
        const ref = choice?.kind === 'ref' ? choice.ref : 'HEAD';
        const commit = await gitCommit(repo, ref);
        if (!commit) note = ref === 'HEAD' ? 'Using the session start as baseline: the repository has no commits yet.' : `"${ref}" is not a known revision; using the session start as baseline.`;
        else {
          const key = `git:${commit}`;
          const label = ref === 'HEAD' ? `HEAD (${commit.slice(0, 7)})` : `${ref} (${commit.slice(0, 7)})`;
          if (this.baseline?.key !== key) {
            const computed = await this.analyzeRevision(repo, commit, label);
            if (!computed) return;
            this.baseline = { key, label, result: computed };
          }
          return this.set({ status: 'ready', report: analyzeImpact(this.baseline.result, result, this.baseline.label) });
        }
      }
    }
    const report = analyzeImpact(this.session!, result, 'session start');
    return this.set({ status: 'ready', report, note });
  }

  private async analyzeRevision(repo: string, commit: string, label: string): Promise<AnalysisResult | undefined> {
    this.cts?.cancel();
    const cts = new vscode.CancellationTokenSource();
    this.cts = cts;
    this.set({ status: 'computing', baseLabel: label });
    const settings = this.analysis.settings;
    const excluder = new PathExcluder(defaultExcludeGlobs(settings.includeTestFiles ? 'include' : 'read', settings.exclude));
    const started = Date.now();
    try {
      const host = await GitFileHost.create(repo, commit, excluder, (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
      const result = await new AnalysisEngine(host, this.analysis.engineOptionsSnapshot(), this.logger).analyze(cts.token);
      this.logger.info(`Impact baseline ${label} analyzed in ${Date.now() - started} ms (${result.endpoints.length} endpoints).`);
      return result;
    } catch (err) {
      if (err instanceof CancelledError) return undefined;
      this.logger.warn(`Could not analyze ${label} for impact analysis: ${err instanceof Error ? err.message : String(err)}`);
      this.set({ status: 'unavailable', reason: `Could not analyze ${label}: ${err instanceof Error ? err.message : String(err)}` });
      return undefined;
    } finally {
      if (this.cts === cts) this.cts = undefined;
      cts.dispose();
    }
  }

  private async repo(): Promise<string | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder && vscode.workspace.isTrusted ? gitRepoRoot(folder.uri.fsPath) : undefined;
  }

  private set(state: ImpactState): void {
    this.current = state;
    this.emitter.fire(state);
  }

  dispose(): void {
    this.cts?.cancel();
    this.emitter.dispose();
  }
}
