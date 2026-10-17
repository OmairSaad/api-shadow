import * as vscode from 'vscode';
import { authLabel } from '../core/auth';
import type { AnalysisResult, Endpoint } from '../core/types';

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
    this.anchors.clear();
    this.emitter.fire();
  }

  /** Re-queries the lenses, e.g. after `apiShadow.codeLens.enabled` changed. */
  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.isEnabled() || document.uri.scheme !== 'file') return [];
    const endpoints = this.byFile.get(document.uri.fsPath);
    if (!endpoints) return [];
    const lenses: vscode.CodeLens[] = [];
    for (const e of endpoints) {
      const line = this.lineFor(document, e);
      if (line === undefined) continue;
      const range = new vscode.Range(line, 0, line, 0);
      const add = (title: string, tooltip: string, command = '', args: unknown[] = []): void => {
        lenses.push(new vscode.CodeLens(range, { title, tooltip, command, arguments: args }));
      };
      add(`${e.method} ${e.path}`, 'API Shadow: actions for this endpoint', 'apiShadow.endpointActions', [e]);
      if (e.auth?.status === 'protected') add(`$(shield) ${authLabel(e.auth)}`, `Auth: ${e.auth.via.join(', ')}`);
      else if (e.auth?.status === 'public') add(`$(unlock) Public`, `Explicitly public: ${e.auth.via.join(', ')}`);
      else if (e.auth?.status === 'central') add(`$(shield) ${e.auth.via[0]}`, 'Security is configured centrally; per-path rules are not analyzed. Click to open.', 'apiShadow.openLocation', [e.auth.location]);
      else if (this.noAuthIds.has(e.id)) add('$(warning) No auth found', 'No auth middleware, guard or annotation was found, but other endpoints in this project have one.', 'apiShadow.issues.focus');
      if (this.duplicateIds.has(e.id)) add('$(warning) Duplicate route', 'Another endpoint in this project matches the same method and path. See the Issues view.', 'apiShadow.issues.focus');
      add('$(play) Try it', 'Open a ready-to-send request for this endpoint (.http)', 'apiShadow.openRequest', [e]);
      add('$(copy) cURL', 'Copy as a cURL command', 'apiShadow.copyCurl', [e]);
    }
    return lenses;
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
