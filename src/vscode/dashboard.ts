import * as vscode from 'vscode';
import { buildDashboardModel, refTable, type ContractView, type DashboardInput } from '../core/dashboardModel';
import type { SourceLocation } from '../core/types';
import type { AnalysisController } from './analysisController';
import type { Dismissals } from './dismissals';
import { relativePath } from './endpointTree';
import type { ImpactController } from './impactController';
import type { ChannelLogger } from './logger';

export const DASHBOARD_TABS = ['overview', 'explorer', 'impact', 'security', 'graph', 'contracts', 'tests'] as const;
export type DashboardTab = (typeof DASHBOARD_TABS)[number];

/** Commands the webview may ask for, with the argument check for each. */
const ALLOWED_COMMANDS: Record<string, (args: unknown[]) => boolean> = {
  'apiShadow.refresh': (a) => a.length === 0,
  'apiShadow.analyzeImpact': (a) => a.length === 0,
  'apiShadow.setImpactBaseline': (a) => a.length === 0,
  'apiShadow.compareContracts': (a) => a.length === 0,
  'apiShadow.compareWithRef': (a) => a.length === 0,
  'apiShadow.generateTests': (a) => a.length === 0,
  'apiShadow.exportReport': (a) => a.length === 0,
  'apiShadow.exportGraph': (a) => a.length === 0,
  'apiShadow.runSecurityAnalysis': (a) => a.length === 0,
  'apiShadow.restoreDismissedFindings': (a) => a.length === 0,
  'apiShadow.showLog': (a) => a.length === 0,
  'apiShadow.disableSecurityRule': (a) => a.length === 1 && typeof a[0] === 'string' && /^[a-z-]{3,40}$/.test(a[0]),
  'apiShadow.enableSecurityRule': (a) => a.length === 1 && typeof a[0] === 'string' && /^[a-z-]{3,40}$/.test(a[0]),
};

export interface DashboardDeps {
  extensionUri: vscode.Uri;
  controller: AnalysisController;
  impact: ImpactController;
  dismissals: Dismissals;
  logger: ChannelLogger;
  /** Contract files found in the workspace (absolute paths). */
  contractFiles: () => string[];
  lastContract: () => ContractView | undefined;
  testProjects: () => DashboardInput['testProjects'];
  /** Generates tests for these endpoints (asks before writing). */
  generateTests: (endpointIds: string[], runner?: string) => Promise<unknown>;
  compareContract: (file: string) => Promise<unknown>;
}

/**
 * The API Shadow dashboard: one webview with overview, explorer, impact, security, graph,
 * contracts and test generation. Strict CSP (scripts from the extension only, with a nonce), all
 * values rendered as text, and every message from the webview validated against an allow-list.
 */
export class Dashboard implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private refs: SourceLocation[] = [];
  private pending: NodeJS.Timeout | undefined;
  private graphFocus: { query: string; ids: Set<string> } | undefined;
  private tab: DashboardTab = 'overview';
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly deps: DashboardDeps) {}

  get visible(): boolean {
    return !!this.panel?.visible;
  }

  show(tab?: DashboardTab, focus?: string): void {
    if (tab) this.tab = tab;
    if (!this.panel) {
      const root = vscode.Uri.joinPath(this.deps.extensionUri, 'resources', 'webview');
      this.panel = vscode.window.createWebviewPanel('apiShadow.dashboard', 'API Shadow', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [root],
      });
      this.panel.iconPath = vscode.Uri.joinPath(this.deps.extensionUri, 'resources', 'activity.svg');
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        for (const d of this.disposables.splice(0)) d.dispose();
      });
      this.disposables.push(
        this.panel.webview.onDidReceiveMessage((msg: unknown) => void this.onMessage(msg)),
        this.panel.onDidChangeViewState(() => {
          if (this.panel?.visible) this.post();
        }),
      );
      this.panel.webview.html = this.html(this.panel.webview);
    } else {
      this.panel.reveal(undefined, false);
      void this.panel.webview.postMessage({ type: 'focus', tab: this.tab, id: focus });
      this.post();
    }
    if (focus) this.focusAfterLoad = focus;
  }

  private focusAfterLoad: string | undefined;

  /** Re-renders soon (debounced), if the dashboard is open. */
  refresh(): void {
    if (!this.panel) return;
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.post();
    }, 150);
  }

  private post(): void {
    if (!this.panel?.visible) return;
    const { controller, impact, dismissals } = this.deps;
    const state = impact.state;
    const table = refTable();
    const model = buildDashboardModel(
      {
        result: controller.current,
        analyzing: controller.isAnalyzing,
        impact: {
          status: state.status,
          report: state.status === 'ready' ? state.report : undefined,
          baseLabel: state.status === 'computing' ? state.baseLabel : undefined,
          reason: state.status === 'off' || state.status === 'unavailable' ? state.reason : undefined,
          note: state.status === 'ready' ? state.note : undefined,
        },
        dismissed: dismissals.ids,
        disabledRules: controller.settings.security.disabledRules,
        graphMaxEndpoints: controller.settings.graphMaxEndpoints,
        graphFocus: this.graphFocus,
        contracts: { files: this.deps.contractFiles().map(relativePath), last: this.deps.lastContract() },
        testProjects: this.deps.testProjects(),
        relativePath,
        workspace: vscode.workspace.name?.replace(/\s*\(Workspace\)$/, '') ?? 'Workspace',
      },
      table,
    );
    this.refs = table.refs;
    void this.panel.webview.postMessage({ type: 'model', model, tab: this.tab, focus: this.focusAfterLoad });
    this.focusAfterLoad = undefined;
  }

  private async onMessage(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as Record<string, unknown>;
    try {
      switch (msg.type) {
        case 'ready':
          this.post();
          return;
        case 'tab':
          if (typeof msg.tab === 'string' && (DASHBOARD_TABS as readonly string[]).includes(msg.tab)) this.tab = msg.tab as DashboardTab;
          return;
        case 'open': {
          const l = typeof msg.ref === 'number' && Number.isInteger(msg.ref) ? this.refs[msg.ref] : undefined;
          if (l) await vscode.window.showTextDocument(vscode.Uri.file(l.file), { selection: new vscode.Range(l.line - 1, l.column - 1, l.line - 1, l.column - 1), viewColumn: vscode.ViewColumn.Beside, preview: true });
          return;
        }
        case 'dismiss':
        case 'restore':
          if (typeof msg.id !== 'string' || !/^[\w:-]{1,80}$/.test(msg.id)) return;
          if (msg.type === 'dismiss') await this.deps.dismissals.add(msg.id);
          else await this.deps.dismissals.remove(msg.id);
          return;
        case 'command': {
          const id = typeof msg.command === 'string' ? msg.command : '';
          const args = Array.isArray(msg.args) ? (msg.args as unknown[]) : [];
          const check = Object.prototype.hasOwnProperty.call(ALLOWED_COMMANDS, id) ? ALLOWED_COMMANDS[id] : undefined;
          if (check?.(args)) await vscode.commands.executeCommand(id, ...args);
          return;
        }
        case 'graphFocus': {
          const query = typeof msg.query === 'string' ? msg.query.trim().slice(0, 200).toLowerCase() : '';
          const result = this.deps.controller.current;
          if (!query || !result) this.graphFocus = undefined;
          else {
            const terms = query.split(/\s+/);
            const ids = new Set(result.endpoints.filter((e) => terms.every((t) => `${e.method} ${e.path} ${e.controller ?? ''} ${e.handler ?? ''} ${relativePath(e.location.file)}`.toLowerCase().includes(t))).map((e) => e.id));
            this.graphFocus = { query, ids };
          }
          this.post();
          return;
        }
        case 'generateTests': {
          const result = this.deps.controller.current;
          const ids = Array.isArray(msg.endpointIds) ? msg.endpointIds.filter((x): x is string => typeof x === 'string').slice(0, 200) : [];
          const known = new Set(result?.endpoints.map((e) => e.id));
          const runner = typeof msg.runner === 'string' && /^(auto|jest|vitest|mocha|junit)$/.test(msg.runner) ? msg.runner : undefined;
          const valid = ids.filter((id) => known.has(id));
          if (valid.length) await this.deps.generateTests(valid, runner === 'auto' ? undefined : runner);
          return;
        }
        case 'compareContract': {
          const files = this.deps.contractFiles();
          const file = typeof msg.index === 'number' && Number.isInteger(msg.index) ? files[msg.index] : undefined;
          if (file) await this.deps.compareContract(file);
          return;
        }
        default:
          return;
      }
    } catch (err) {
      this.deps.logger.error(err instanceof Error ? err : String(err));
      void vscode.window.showErrorMessage(`API Shadow: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const base = vscode.Uri.joinPath(this.deps.extensionUri, 'resources', 'webview');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(base, 'dashboard.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(base, 'dashboard.css'));
    const csp = [`default-src 'none'`, `img-src ${webview.cspSource} data:`, `style-src ${webview.cspSource}`, `font-src ${webview.cspSource}`, `script-src 'nonce-${nonce}'`].join('; ');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style.toString()}">
<title>API Shadow</title>
</head>
<body>
<div id="app" aria-live="polite"><p class="empty">Loading…</p></div>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.pending) clearTimeout(this.pending);
    this.panel?.dispose();
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
