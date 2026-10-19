import * as vscode from 'vscode';
import { describeAuth } from '../core/auth';
import type { AnalysisResult, Endpoint, SourceLocation } from '../core/types';
import { relativePath } from './endpointTree';

interface Step {
  kind: 'client' | 'mount' | 'middleware' | 'auth' | 'handler' | 'service' | 'note';
  title: string;
  detail?: string;
  location?: SourceLocation;
  warn?: boolean;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function nonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** The path a request takes through the app: callers → mounts → middleware → handler → services. */
export function flowSteps(e: Endpoint, result: AnalysisResult): Step[] {
  const steps: Step[] = [];
  const callers = result.clientCalls.filter((c) => c.endpointIds.includes(e.id));
  for (const c of callers.slice(0, 6)) {
    steps.push({ kind: 'client', title: `${c.kind === 'test' ? 'Test' : 'Caller'}: ${c.client}`, detail: `${relativePath(c.location.file)}:${c.location.line}`, location: c.location });
  }
  if (callers.length > 6) steps.push({ kind: 'client', title: `…and ${callers.length - 6} more callers` });
  for (const n of e.notes) {
    if (/^(Mounted at|Registered|Global prefix|RouterModule|URI version|Context path)/.test(n)) steps.push({ kind: 'mount', title: n });
  }
  for (const m of e.middleware) {
    const isAuth = e.auth?.via.includes(m);
    steps.push({ kind: isAuth ? 'auth' : 'middleware', title: m, detail: isAuth ? 'auth' : undefined });
  }
  if (e.auth?.status === 'none') steps.push({ kind: 'auth', title: 'No auth found', warn: true });
  if (e.auth?.status === 'central') steps.push({ kind: 'auth', title: `Security configured in ${e.auth.via[0]}`, location: e.auth.location });
  if (e.validation) steps.push({ kind: 'middleware', title: e.validation.status === 'validated' ? `Body validated: ${e.validation.via.join(', ')}` : 'Body not validated', warn: e.validation.status === 'missing' });
  steps.push({
    kind: 'handler',
    title: `${e.method} ${e.path}`,
    detail: [e.controller && e.handler ? `${e.controller}.${e.handler}` : e.handler, `${relativePath((e.handlerLocation ?? e.location).file)}:${(e.handlerLocation ?? e.location).line}`].filter(Boolean).join(' · '),
    location: e.handlerLocation ?? e.location,
  });
  for (const s of e.services) steps.push({ kind: 'service', title: s.name, detail: s.location ? `${relativePath(s.location.file)}:${s.location.line}` : 'not found in workspace', location: s.location });
  return steps;
}

const ICONS: Record<Step['kind'], string> = { client: '◇', mount: '⤷', middleware: '▸', auth: '🛡', handler: '●', service: '◆', note: '·' };

/** A webview showing {@link flowSteps} as a vertical flow; steps with a location open it on click. */
export class FlowView implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private locations: (SourceLocation | undefined)[] = [];

  show(e: Endpoint, result: AnalysisResult): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('apiShadow.flow', 'Request Flow', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: false });
      this.panel.onDidDispose(() => (this.panel = undefined));
      this.panel.webview.onDidReceiveMessage((msg: { open?: number }) => {
        const l = typeof msg.open === 'number' ? this.locations[msg.open] : undefined;
        if (l) void vscode.window.showTextDocument(vscode.Uri.file(l.file), { selection: new vscode.Range(l.line - 1, l.column - 1, l.line - 1, l.column - 1), viewColumn: vscode.ViewColumn.One });
      });
    }
    const steps = flowSteps(e, result);
    this.locations = steps.map((s) => s.location);
    this.panel.title = `Flow: ${e.method} ${e.path}`;
    this.panel.webview.html = this.html(e, steps);
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  private html(e: Endpoint, steps: Step[]): string {
    const n = nonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';`;
    const items = steps
      .map(
        (s, i) => `<li class="step ${s.kind}${s.warn ? ' warn' : ''}${s.location ? ' link' : ''}" ${s.location ? `data-i="${i}" tabindex="0" role="button"` : ''}>
  <span class="icon">${ICONS[s.kind]}</span><span class="title">${escapeHtml(s.title)}</span>${s.detail ? `<span class="detail">${escapeHtml(s.detail)}</span>` : ''}
</li>`,
      )
      .join('\n<li class="arrow" aria-hidden="true">↓</li>\n');
    const summary = [e.framework, describeAuth(e.auth) ? `auth: ${describeAuth(e.auth)}` : '', e.usage ? `${e.usage.calls} callers, ${e.usage.tests} tests` : ''].filter(Boolean).join(' · ');
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px 24px; }
h1 { font-size: 1.3em; margin: 0 0 4px; } .summary { color: var(--vscode-descriptionForeground); margin-bottom: 20px; }
ol { list-style: none; padding: 0; margin: 0; max-width: 560px; }
.step { display: grid; grid-template-columns: 28px 1fr; gap: 2px 8px; padding: 10px 14px; border: 1px solid var(--vscode-panel-border, #4446); border-radius: 8px; background: var(--vscode-sideBar-background); }
.step .icon { grid-row: span 2; font-size: 1.1em; text-align: center; }
.step .detail { color: var(--vscode-descriptionForeground); font-size: 0.9em; grid-column: 2; }
.step.handler { border-color: var(--vscode-focusBorder); border-width: 2px; font-weight: 600; }
.step.auth { border-left: 4px solid var(--vscode-charts-green); } .step.client { border-style: dashed; } .step.service { border-left: 4px solid var(--vscode-charts-purple); }
.step.warn { border-left: 4px solid var(--vscode-editorWarning-foreground); }
.step.link { cursor: pointer; } .step.link:hover, .step.link:focus { background: var(--vscode-list-hoverBackground); outline: none; }
.arrow { text-align: center; color: var(--vscode-descriptionForeground); padding: 2px 0; max-width: 560px; }
</style></head><body>
<h1>${escapeHtml(`${e.method} ${e.path}`)}</h1><div class="summary">${escapeHtml(summary)}</div>
<ol>${items}</ol>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
for (const el of document.querySelectorAll('[data-i]')) {
  const open = () => vscode.postMessage({ open: Number(el.dataset.i) });
  el.addEventListener('click', open);
  el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
}
</script></body></html>`;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
