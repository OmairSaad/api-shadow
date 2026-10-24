import * as vscode from 'vscode';
import { authLabel } from '../core/auth';
import type { AnalysisIssue, AnalysisResult, ClientCall, Endpoint } from '../core/types';

/** How far (in lines) to look for an endpoint's declaration after unsaved edits moved it. */
const ANCHOR_SEARCH_LINES = 200;

/**
 * Shows each endpoint above its declaration: method and path, auth, duplicate warnings and
 * request actions. Results come from the last analysis, which runs on save; while a document has
 * unsaved edits, each lens follows the text of its original line, and is hidden if that line is
 * gone.
 */
export class EndpointCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private byFile = new Map<string, Endpoint[]>();
  private duplicateIds = new Set<string>();
  private noAuthIds = new Set<string>();
  private noValidationIds = new Set<string>();
  private unreachable = new Map<string, AnalysisIssue>();
  private callsByFile = new Map<string, ClientCall[]>();
  private endpointById = new Map<string, Endpoint>();
  private hasCalls = false;
  /** endpoint id -> text of its declaration line in the saved file */
  private readonly anchors = new Map<string, string>();

  constructor(private readonly isEnabled: () => boolean) {}

  setResult(result: AnalysisResult): void {
    this.byFile = new Map();
    for (const e of result.endpoints) {
      const list = this.byFile.get(e.location.file) ?? [];
      list.push(e);
      this.byFile.set(e.location.file, list);
    }
    this.duplicateIds = new Set(result.duplicates.flatMap((d) => d.endpointIds));
    this.noAuthIds = new Set(result.issues.filter((i) => i.kind === 'no-auth').flatMap((i) => i.endpointIds ?? []));
    this.noValidationIds = new Set(result.issues.filter((i) => i.kind === 'no-validation').flatMap((i) => i.endpointIds ?? []));
    this.unreachable = new Map(result.issues.filter((i) => i.kind === 'unreachable').map((i) => [i.endpointIds![0], i]));
    this.callsByFile = new Map();
    for (const c of result.clientCalls) this.callsByFile.set(c.location.file, [...(this.callsByFile.get(c.location.file) ?? []), c]);
    this.endpointById = new Map(result.endpoints.map((e) => [e.id, e]));
    this.hasCalls = result.clientCalls.length > 0;
    this.anchors.clear();
    this.emitter.fire();
  }

  /** Re-queries the lenses, e.g. after `apiShadow.codeLens.enabled` changed. */
  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.isEnabled() || document.uri.scheme !== 'file') return [];
    const lenses: vscode.CodeLens[] = this.clientCallLenses(document);
    const endpoints = this.byFile.get(document.uri.fsPath) ?? [];
    // Resource declarations (`Route::apiResource(...)`) put many endpoints on one line: summarize them.
    const perLine = new Map<number, Endpoint[]>();
    for (const e of endpoints) {
      const line = this.lineFor(document, e);
      if (line !== undefined) perLine.set(line, [...(perLine.get(line) ?? []), e]);
    }
    for (const [line, group] of perLine) {
      if (group.length <= 2) continue;
      const range = new vscode.Range(line, 0, line, 0);
      const methods = [...new Set(group.map((e) => e.method))].join(', ');
      lenses.push(new vscode.CodeLens(range, { title: `$(list-unordered) ${group.length} routes: ${methods}`, tooltip: group.map((e) => `${e.method} ${e.path}`).join('\n'), command: 'apiShadow.endpointActions', arguments: [group] }));
      const auth = new Set(group.map((e) => e.auth?.status ?? 'none'));
      if (auth.size === 1 && auth.has('protected')) lenses.push(new vscode.CodeLens(range, { title: `$(shield) ${authLabel(group[0].auth!)}`, tooltip: `Auth: ${group[0].auth!.via.join(', ')}`, command: '' }));
      else if (group.some((e) => this.noAuthIds.has(e.id))) lenses.push(new vscode.CodeLens(range, { title: '$(warning) No auth found', tooltip: 'Some of these routes have no auth middleware, guard or annotation.', command: 'apiShadow.issues.focus' }));
      const flagged = group.filter((e) => this.unreachable.has(e.id) || this.duplicateIds.has(e.id) || this.noValidationIds.has(e.id)).length;
      if (flagged) lenses.push(new vscode.CodeLens(range, { title: `$(warning) ${plural(flagged, 'route')} with issues`, tooltip: 'Unreachable, duplicate or unvalidated routes. See the Issues view.', command: 'apiShadow.issues.focus' }));
      const calls = group.reduce((n, e) => n + (e.usage?.calls ?? 0), 0);
      const tests = group.reduce((n, e) => n + (e.usage?.tests ?? 0), 0);
      if (this.hasCalls || calls + tests > 0) lenses.push(new vscode.CodeLens(range, { title: calls + tests ? `$(references) ${[calls ? plural(calls, 'caller') : '', tests ? plural(tests, 'test') : ''].filter(Boolean).join(' · ')}` : '$(circle-slash) No callers', command: '' }));
    }
    for (const e of endpoints) {
      const line = this.lineFor(document, e);
      if (line === undefined || (perLine.get(line)?.length ?? 0) > 2) continue;
      const range = new vscode.Range(line, 0, line, 0);
      const add = (title: string, tooltip: string, command = '', args: unknown[] = []): void => {
        lenses.push(new vscode.CodeLens(range, { title, tooltip, command, arguments: args }));
      };
      add(`${e.method} ${e.path}`, 'API Shadow: actions for this endpoint', 'apiShadow.endpointActions', [e]);
      if (e.auth?.status === 'protected') add(`$(shield) ${authLabel(e.auth)}`, `Auth: ${e.auth.via.join(', ')}`);
      else if (e.auth?.status === 'public') add(`$(unlock) Public`, `Explicitly public: ${e.auth.via.join(', ')}`);
      else if (e.auth?.status === 'central') add(`$(shield) ${e.auth.via[0]}`, 'Security is configured centrally; per-path rules are not analyzed. Click to open.', 'apiShadow.openLocation', [e.auth.location]);
      else if (this.noAuthIds.has(e.id)) add('$(warning) No auth found', 'No auth middleware, guard or annotation was found, but other endpoints in this project have one.', 'apiShadow.issues.focus');
      const unreachable = this.unreachable.get(e.id);
      if (unreachable) add('$(error) Unreachable', unreachable.message + ' Click to open that route.', 'apiShadow.openLocation', [unreachable.related?.[0]?.location]);
      if (this.duplicateIds.has(e.id)) add('$(warning) Duplicate route', 'Another endpoint in this project matches the same method and path. See the Issues view.', 'apiShadow.issues.focus');
      if (this.noValidationIds.has(e.id)) add('$(circle-slash) Body not validated', 'The request body is not validated, but other endpoints in this project validate theirs.', 'apiShadow.issues.focus');
      if (e.usage && (this.hasCalls || e.usage.calls + e.usage.tests > 0)) {
        const n = e.usage.calls + e.usage.tests;
        const parts = [e.usage.calls ? plural(e.usage.calls, 'caller') : '', e.usage.tests ? plural(e.usage.tests, 'test') : ''].filter(Boolean);
        const text = n === 0 ? '$(circle-slash) No callers' : `$(references) ${parts.join(' · ')}`;
        add(text, n === 0 ? 'Nothing in the workspace calls this endpoint' : 'Show the code and tests that call this endpoint', n === 0 ? '' : 'apiShadow.showCallers', [e]);
      }
      add('$(play) Try it', 'Open a ready-to-send request for this endpoint (.http)', 'apiShadow.openRequest', [e]);
      add('$(copy) cURL', 'Copy as a cURL command', 'apiShadow.copyCurl', [e]);
    }
    return lenses;
  }

  /** Above each HTTP call in frontend and test code: the endpoint it reaches. */
  private clientCallLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.isDirty) return [];
    const out: vscode.CodeLens[] = [];
    for (const call of this.callsByFile.get(document.uri.fsPath) ?? []) {
      const line = call.location.line - 1;
      if (line >= document.lineCount) continue;
      const range = new vscode.Range(line, 0, line, 0);
      const targets = call.endpointIds.map((id) => this.endpointById.get(id)).filter((e): e is Endpoint => !!e);
      // Calls to missing routes are underlined in the editor (Problems panel) instead.
      if (targets.length === 0) continue;
      for (const e of targets.slice(0, 2)) {
        const handler = e.controller && e.handler && !e.handler.startsWith('(') ? ` · ${e.controller}.${e.handler}` : '';
        out.push(new vscode.CodeLens(range, { title: `$(arrow-right) ${e.method} ${e.path}${handler}`, tooltip: 'API Shadow: go to the route handler', command: 'apiShadow.openLocation', arguments: [e.handlerLocation ?? e.location] }));
      }
      if (targets.length > 2) out.push(new vscode.CodeLens(range, { title: `+${targets.length - 2} more`, command: '' }));
    }
    return out;
  }

  private lineFor(document: vscode.TextDocument, e: Endpoint): number | undefined {
    const line = e.location.line - 1;
    if (!document.isDirty) {
      if (line >= document.lineCount) return undefined;
      this.anchors.set(e.id, document.lineAt(line).text);
      return line;
    }
    const anchor = this.anchors.get(e.id);
    if (anchor === undefined) return undefined;
    for (let d = 0; d <= ANCHOR_SEARCH_LINES; d++) {
      for (const candidate of d === 0 ? [line] : [line - d, line + d]) {
        if (candidate >= 0 && candidate < document.lineCount && document.lineAt(candidate).text === anchor) return candidate;
      }
    }
    return undefined;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
