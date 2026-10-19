import * as path from 'path';
import * as vscode from 'vscode';
import type { AnalysisResult, Endpoint, SourceLocation } from '../core/types';

export interface DiagnosticSettings {
  duplicates: boolean;
  unreachable: boolean;
  brokenCalls: boolean;
}

function position(l: SourceLocation): vscode.Position {
  return new vscode.Position(Math.max(0, l.line - 1), Math.max(0, l.column - 1));
}

function location(l: SourceLocation): vscode.Location {
  return new vscode.Location(vscode.Uri.file(l.file), position(l));
}

/** Publishes potential duplicate routes, unreachable routes and broken client calls to the Problems panel. */
export class ApiDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('api-shadow');

  update(result: AnalysisResult, settings: DiagnosticSettings): void {
    this.collection.clear();
    const perFile = new Map<string, vscode.Diagnostic[]>();
    const add = (file: string, diag: vscode.Diagnostic): void => {
      diag.source = 'API Shadow';
      perFile.set(file, [...(perFile.get(file) ?? []), diag]);
    };
    const byId = new Map(result.endpoints.map((e) => [e.id, e]));
    const range = (e: Endpoint): vscode.Range => {
      const start = position(e.location);
      return new vscode.Range(start, start.translate(0, Math.max(1, (e.handler ?? '').length || 1)));
    };

    if (settings.duplicates) {
      for (const group of result.duplicates) {
        const members = group.endpointIds.map((id) => byId.get(id)).filter((e): e is Endpoint => !!e);
        for (const e of members) {
          const others = members.filter((o) => o !== e);
          const diag = new vscode.Diagnostic(
            range(e),
            `Potential duplicate route ${e.method} ${e.path} (also declared at ${others.map((o) => `${path.basename(o.location.file)}:${o.location.line}`).join(', ')}).`,
            vscode.DiagnosticSeverity.Warning,
          );
          diag.code = 'duplicate-route';
          diag.relatedInformation = others.map((o) => new vscode.DiagnosticRelatedInformation(location(o.location), `${o.method} ${o.path}`));
          add(e.location.file, diag);
        }
      }
    }

    for (const issue of result.issues) {
      if (!issue.location) continue;
      if (issue.kind === 'unreachable' && settings.unreachable) {
        const e = byId.get(issue.endpointIds?.[0] ?? '');
        const diag = new vscode.Diagnostic(e ? range(e) : new vscode.Range(position(issue.location), position(issue.location)), issue.message, vscode.DiagnosticSeverity.Warning);
        diag.code = 'unreachable-route';
        diag.relatedInformation = (issue.related ?? []).map((r) => new vscode.DiagnosticRelatedInformation(location(r.location), r.message));
        add(issue.location.file, diag);
      } else if (issue.kind === 'broken-call' && settings.brokenCalls) {
        const call = result.clientCalls.find((c) => c.location.file === issue.location!.file && c.location.line === issue.location!.line && c.location.column === issue.location!.column);
        const r = call ? new vscode.Range(position(call.range.start), position(call.range.end)) : new vscode.Range(position(issue.location), position(issue.location));
        const diag = new vscode.Diagnostic(r, issue.message, vscode.DiagnosticSeverity.Warning);
        diag.code = 'no-matching-route';
        diag.relatedInformation = (issue.endpointIds ?? [])
          .map((id) => byId.get(id))
          .filter((e): e is Endpoint => !!e)
          .map((e) => new vscode.DiagnosticRelatedInformation(location(e.location), `${e.method} ${e.path}`));
        add(issue.location.file, diag);
      }
    }
    for (const [file, diags] of perFile) this.collection.set(vscode.Uri.file(file), diags);
  }

  dispose(): void {
    this.collection.dispose();
  }
}
