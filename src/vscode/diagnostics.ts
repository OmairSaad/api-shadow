import * as path from 'path';
import * as vscode from 'vscode';
import type { AnalysisResult, Endpoint } from '../core/types';

/** Publishes potential duplicate routes to the Problems panel. */
export class DuplicateDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('api-shadow');

  update(result: AnalysisResult, enabled: boolean): void {
    this.collection.clear();
    if (!enabled) return;
    const byId = new Map(result.endpoints.map((e) => [e.id, e]));
    const perFile = new Map<string, vscode.Diagnostic[]>();
    for (const group of result.duplicates) {
      const members = group.endpointIds.map((id) => byId.get(id)).filter((e): e is Endpoint => !!e);
      for (const e of members) {
        const others = members.filter((o) => o !== e).map((o) => `${path.basename(o.location.file)}:${o.location.line}`);
        const line = Math.max(0, e.location.line - 1);
        const col = Math.max(0, e.location.column - 1);
        const diag = new vscode.Diagnostic(
          new vscode.Range(line, col, line, col + Math.max(1, (e.handler ?? '').length || 1)),
          `Potential duplicate route ${e.method} ${e.path} (also declared at ${others.join(', ')}).`,
          vscode.DiagnosticSeverity.Warning,
        );
        diag.source = 'API Shadow';
        diag.code = 'duplicate-route';
        diag.relatedInformation = members
          .filter((o) => o !== e)
          .map((o) => new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.file(o.location.file), new vscode.Position(Math.max(0, o.location.line - 1), Math.max(0, o.location.column - 1))), `${o.method} ${o.path}`));
        const list = perFile.get(e.location.file) ?? [];
        list.push(diag);
        perFile.set(e.location.file, list);
      }
    }
    for (const [file, diags] of perFile) this.collection.set(vscode.Uri.file(file), diags);
  }

  dispose(): void {
    this.collection.dispose();
  }
}
