import * as vscode from 'vscode';
import { AnalysisEngine, type EngineOptions } from '../core/engine';
import { CONFIG_GLOB, MARKER_GLOB, PathExcluder, SOURCE_GLOB, TSCONFIG_GLOB } from '../core/exclude';
import { CancelledError, type AnalysisResult } from '../core/types';
import { readConfig, type ApiShadowConfig } from './config';
import { VscodeFileHost } from './host';
import type { ChannelLogger } from './logger';

const CACHE_FILE = 'facts-cache.json';

/**
 * Owns the analysis engine: schedules (debounced) runs on file changes, cancels superseded runs,
 * serialises runs, persists the facts cache and publishes results.
 */
export class AnalysisController implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<AnalysisResult>();
  readonly onDidChangeResult = this.emitter.event;
  private readonly stateEmitter = new vscode.EventEmitter<boolean>();
  readonly onDidChangeAnalyzing = this.stateEmitter.event;

  private config: ApiShadowConfig;
  private readonly host: VscodeFileHost;
  private readonly engine: AnalysisEngine;
  private result: AnalysisResult | undefined;
  private running: Promise<void> = Promise.resolve();
  private cts: vscode.CancellationTokenSource | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private pendingFull = false;
  private analyzing = false;
  private readonly disposables: vscode.Disposable[] = [];
  private cacheLoaded = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: ChannelLogger,
  ) {
    this.config = readConfig();
    this.host = new VscodeFileHost(this.config);
    this.engine = new AnalysisEngine(this.host, this.engineOptions(), logger);
    this.setupWatchers();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('apiShadow') || e.affectsConfiguration('files.exclude')) {
          this.config = readConfig();
          this.host.updateConfig(this.config);
          this.engine.updateOptions(this.engineOptions());
          void this.refresh(false);
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.engine.updateOptions(this.engineOptions());
        void this.refresh(true);
      }),
    );
  }

  get current(): AnalysisResult | undefined {
    return this.result;
  }

  get isAnalyzing(): boolean {
    return this.analyzing;
  }

  get settings(): ApiShadowConfig {
    return this.config;
  }

  /** Options for a separate engine (e.g. analyzing a git revision) with the current settings. */
  engineOptionsSnapshot(): EngineOptions {
    return this.engineOptions();
  }

  private engineOptions(): EngineOptions {
    return {
      frameworks: this.config.frameworks,
      maxFiles: this.config.maxFiles,
      maxFileSizeBytes: this.config.maxFileSizeKB * 1024,
      springApplyContextPath: this.config.springApplyContextPath,
      auth: this.config.auth,
      includeTestFiles: this.config.includeTestFiles,
      clientCalls: { enabled: this.config.clientCalls, reportUncalled: this.config.reportUncalled },
      validation: this.config.validation,
      unreachable: this.config.unreachable,
      responseChecks: this.config.responseChecks,
      security: {
        enabled: this.config.security.enabled,
        disabledRules: this.config.security.disabledRules,
        isExcluded: securityExcluder(this.config.security.exclude),
      },
      workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    };
  }

  /** Modules exporting an app, for test generation. */
  appModules(): ReturnType<AnalysisEngine['appModules']> {
    return this.engine.appModules();
  }

  javaClass(file: string, name: string): ReturnType<AnalysisEngine['javaClass']> {
    return this.engine.javaClass(file, name);
  }

  hasSpringSecurity(root: string): boolean {
    return this.engine.hasSpringSecurity(root);
  }

  private setupWatchers(): void {
    for (const glob of [SOURCE_GLOB, CONFIG_GLOB, MARKER_GLOB, TSCONFIG_GLOB]) {
      const watcher = vscode.workspace.createFileSystemWatcher(glob);
      const isMarker = glob === MARKER_GLOB;
      watcher.onDidChange((uri) => this.onFileEvent(uri, 'change', isMarker));
      watcher.onDidCreate((uri) => this.onFileEvent(uri, 'create', isMarker));
      watcher.onDidDelete((uri) => this.onFileEvent(uri, 'delete', isMarker));
      this.disposables.push(watcher);
    }
  }

  private onFileEvent(uri: vscode.Uri, kind: 'change' | 'create' | 'delete', isMarker: boolean): void {
    if (uri.scheme !== 'file' || this.host.isExcluded(uri)) return;
    if (isMarker) {
      if (kind === 'change') return; // contents of package.json/pom.xml do not affect analysis
      this.engine.markStructureChanged();
    } else if (kind === 'change') {
      this.engine.markChanged([uri.fsPath]);
    } else {
      this.engine.markStructureChanged(kind === 'delete' ? [uri.fsPath] : []);
    }
    this.logger.trace(`File ${kind}: ${vscode.workspace.asRelativePath(uri)}`);
    if (this.config.autoRefresh) this.schedule(false);
  }

  /** Debounced refresh used by the file watcher. */
  schedule(full: boolean): void {
    this.pendingFull ||= full;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      const f = this.pendingFull;
      this.pendingFull = false;
      void this.refresh(f);
    }, this.config.refreshDebounceMs);
  }

  /** Cancels any in-flight analysis and starts a new one. Resolves when this run completes. */
  refresh(full: boolean): Promise<void> {
    this.cts?.cancel();
    const cts = new vscode.CancellationTokenSource();
    this.cts = cts;
    const run = this.running.then(() => this.runOnce(cts, full));
    this.running = run.catch(() => undefined);
    return run;
  }

  /** Resolves once no analysis is running or scheduled. */
  async whenIdle(): Promise<void> {
    for (;;) {
      const current = this.running;
      await current;
      if (current === this.running && !this.debounce) return;
      if (this.debounce) await new Promise((r) => setTimeout(r, 50));
    }
  }

  private async runOnce(cts: vscode.CancellationTokenSource, full: boolean): Promise<void> {
    if (cts.token.isCancellationRequested) return;
    if (!vscode.workspace.workspaceFolders?.length) {
      this.publish({ endpoints: [], issues: [], duplicates: [], servers: [], clientCalls: [], security: [], stats: { filesDiscovered: 0, filesAnalyzed: 0, filesFromCache: 0, filesSkipped: 0, durationMs: 0, truncated: false } });
      return;
    }
    await this.loadPersistedCache();
    if (await this.host.loadGitignore()) this.engine.markStructureChanged();
    this.setAnalyzing(true);
    try {
      const result = await vscode.window.withProgress(
        { location: { viewId: 'apiShadow.endpoints' }, title: 'Analyzing API endpoints' },
        () => this.engine.analyze(cts.token, { full }),
      );
      if (cts.token.isCancellationRequested) return;
      this.publish(result);
      this.schedulePersist();
    } catch (err) {
      if (err instanceof CancelledError) {
        this.logger.debug('Analysis cancelled (superseded by a newer run).');
        return;
      }
      this.logger.error(err instanceof Error ? err : String(err));
      void vscode.window.showErrorMessage('API Shadow: analysis failed. See the "API Shadow" output for details.', 'Show Log').then((choice) => {
        if (choice) this.logger.show();
      });
    } finally {
      if (this.cts === cts) this.setAnalyzing(false);
      cts.dispose();
    }
  }

  private setAnalyzing(value: boolean): void {
    if (this.analyzing === value) return;
    this.analyzing = value;
    void vscode.commands.executeCommand('setContext', 'apiShadow.analyzing', value);
    this.stateEmitter.fire(value);
  }

  private publish(result: AnalysisResult): void {
    this.result = result;
    void vscode.commands.executeCommand('setContext', 'apiShadow.ready', true);
    void vscode.commands.executeCommand('setContext', 'apiShadow.hasEndpoints', result.endpoints.length > 0);
    this.emitter.fire(result);
  }

  clearCache(): Promise<void> {
    this.engine.clearCache();
    const uri = this.cacheUri();
    if (uri) void Promise.resolve(vscode.workspace.fs.delete(uri)).catch(() => undefined);
    return this.refresh(true);
  }

  private cacheUri(): vscode.Uri | undefined {
    return this.context.storageUri ? vscode.Uri.joinPath(this.context.storageUri, CACHE_FILE) : undefined;
  }

  private async loadPersistedCache(): Promise<void> {
    if (this.cacheLoaded) return;
    this.cacheLoaded = true;
    const uri = this.cacheUri();
    if (!uri || !this.config.persistCache) return;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const ok = this.engine.loadCache(JSON.parse(new TextDecoder().decode(bytes)));
      this.logger.debug(ok ? 'Loaded persisted analysis cache.' : 'Persisted cache is from an older version; ignoring it.');
    } catch {
      // No cache yet.
    }
  }

  private schedulePersist(): void {
    if (!this.config.persistCache || !this.context.storageUri) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.persist(), 2000);
  }

  private async persist(): Promise<void> {
    const uri = this.cacheUri();
    if (!uri || !this.context.storageUri) return;
    try {
      await vscode.workspace.fs.createDirectory(this.context.storageUri);
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(this.engine.serializeCache())));
    } catch (err) {
      this.logger.warn(`Could not persist cache: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  dispose(): void {
    this.cts?.cancel();
    if (this.debounce) clearTimeout(this.debounce);
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      void this.persist();
    }
    this.emitter.dispose();
    this.stateEmitter.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/** Files matching `apiShadow.security.exclude` (relative to their workspace folder) get no findings. */
function securityExcluder(globs: string[]): ((file: string) => boolean) | undefined {
  if (globs.length === 0) return undefined;
  const excluder = new PathExcluder(globs);
  return (file) => excluder.isExcluded(vscode.workspace.asRelativePath(vscode.Uri.file(file), false));
}
