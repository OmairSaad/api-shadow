import * as path from 'path';
import * as vscode from 'vscode';
import type { ImpactReport } from '../core/impact';
import type { SecurityFinding } from '../core/security';
import type { AnalysisResult, Endpoint, SourceLocation } from '../core/types';
import type { DiagnosticLevel } from './config';
import { impactId } from './dismissals';

export interface DiagnosticSettings {
  duplicates: boolean;
  unreachable: boolean;
  brokenCalls: boolean;
  responseMismatch?: boolean;
  impact?: boolean;
  /** Lowest security severity shown in the Problems panel. */
  security?: DiagnosticLevel;
}

/** What a quick fix needs to know about a diagnostic. */
export type DiagnosticPayload =
  | { kind: 'rename'; from: string; to: string; location: SourceLocation; dismissId?: string }
  | { kind: 'impact'; dismissId: string }
  | { kind: 'security'; finding: SecurityFinding };

function position(l: SourceLocation): vscode.Position {
  return new vscode.Position(Math.max(0, l.line - 1), Math.max(0, l.column - 1));
}

function location(l: SourceLocation): vscode.Location {
  return new vscode.Location(vscode.Uri.file(l.file), position(l));
}

/** Range of a member read: from the start of `user.name` to the end of the line's matching `.name`. */
function readRange(l: SourceLocation, field: string): vscode.Range {
  const start = position(l);
  return new vscode.Range(start, start.translate(0, Math.max(1, field.length + 1)));
}

const SECURITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1, info: 0 };

/** Publishes API Shadow findings to the Problems panel. */
export class ApiDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('api-shadow');
  private readonly payloads = new Map<string, DiagnosticPayload>();

  /** The payload of a diagnostic published by this collection, for code actions. */
  payloadOf(uri: vscode.Uri, d: vscode.Diagnostic): DiagnosticPayload | undefined {
    return this.payloads.get(payloadKey(uri.fsPath, d));
  }

  update(result: AnalysisResult, settings: DiagnosticSettings, extra: { impact?: ImpactReport; dismissed?: ReadonlySet<string> } = {}): void {
    this.collection.clear();
    this.payloads.clear();
    const perFile = new Map<string, vscode.Diagnostic[]>();
    const add = (file: string, diag: vscode.Diagnostic, payload?: DiagnosticPayload): void => {
      diag.source = 'API Shadow';
      perFile.set(file, [...(perFile.get(file) ?? []), diag]);
      if (payload) this.payloads.set(payloadKey(file, diag), payload);
    };
    const dismissed = extra.dismissed ?? new Set<string>();
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
      } else if (issue.kind === 'response-mismatch' && settings.responseMismatch !== false) {
        const field = /`([^`]+)` is read/.exec(issue.message)?.[1] ?? '';
        const missing = /without `([^`]+)`/.exec(issue.message)?.[1];
        const hint = /Did you mean `([^`]+)`/.exec(issue.message)?.[1];
        const diag = new vscode.Diagnostic(readRange(issue.location, field), issue.message, vscode.DiagnosticSeverity.Warning);
        diag.code = 'response-field-missing';
        diag.relatedInformation = (issue.related ?? []).map((r) => new vscode.DiagnosticRelatedInformation(location(r.location), r.message));
        add(issue.location.file, diag, missing && hint && field.endsWith(missing) ? { kind: 'rename', from: missing, to: hint, location: issue.location } : undefined);
      }
    }

    if (settings.impact !== false && extra.impact) {
      for (const e of extra.impact.endpoints) {
        for (const c of e.changes) {
          for (const r of c.reads) {
            const id = impactId(e.key, c.text, r.location.file, r.path);
            if (dismissed.has(id)) continue;
            const suggestion = r.suggestion ? ` \`${r.path}\` may have been replaced by \`${r.path.replace(/[^.]+$/, r.suggestion.to)}\`.` : '';
            const diag = new vscode.Diagnostic(
              readRange(r.location, r.path),
              `Potential breaking change since ${extra.impact.baseLabel}: ${e.method} ${e.path} — ${c.text}.${suggestion} Risk: ${c.risk.toUpperCase()} (${c.evidence}).`,
              c.risk === 'high' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information,
            );
            diag.code = 'breaking-change';
            const at = (e.after ?? e.before).responses?.[0]?.location ?? (e.after ?? e.before).location;
            diag.relatedInformation = [new vscode.DiagnosticRelatedInformation(location(at), `${e.method} ${e.path} (changed here)`)];
            add(r.location.file, diag, r.suggestion ? { kind: 'rename', from: r.suggestion.from, to: r.suggestion.to, location: r.location, dismissId: id } : { kind: 'impact', dismissId: id });
          }
        }
        // On the endpoint itself: who this change may break.
        const reads = e.changes.flatMap((c) => c.reads);
        const target = e.after ?? e.before;
        const id = impactId(e.key, 'endpoint', target.location.file, '');
        if (e.after && e.risk !== 'low' && !dismissed.has(id)) {
          const callers = e.callers.filter((c) => c.kind === 'app');
          const diag = new vscode.Diagnostic(
            range(target),
            `This change may break ${reads.length ? `${reads.length} response read(s)` : `${callers.length} caller(s)`} of ${e.method} ${e.path} (compared with ${extra.impact.baseLabel}): ${e.changes.filter((c) => c.breaking).map((c) => c.text).join('; ')}.`,
            vscode.DiagnosticSeverity.Information,
          );
          diag.code = 'breaking-change';
          diag.relatedInformation = [...reads.map((r) => new vscode.DiagnosticRelatedInformation(location(r.location), `reads ${r.path}${r.within ? ` in ${r.within}` : ''}`)), ...callers.slice(0, 10).map((c) => new vscode.DiagnosticRelatedInformation(location(c.location), `calls ${e.method} ${e.path}`))].slice(0, 20);
          add(target.location.file, diag, { kind: 'impact', dismissId: id });
        }
      }
    }

    const minimum = settings.security && settings.security !== 'off' ? SECURITY_RANK[settings.security] : Infinity;
    for (const f of result.security) {
      if (SECURITY_RANK[f.severity] < minimum || dismissed.has(f.id)) continue;
      const start = position(f.location);
      const diag = new vscode.Diagnostic(
        new vscode.Range(start, start.translate(0, 1)),
        `${f.title}: ${f.message} (severity ${f.severity}, confidence ${f.confidence})`,
        f.severity === 'high' ? vscode.DiagnosticSeverity.Warning : f.severity === 'medium' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Hint,
      );
      diag.code = `security/${f.rule}`;
      add(f.location.file, diag, { kind: 'security', finding: f });
    }
    for (const [file, diags] of perFile) this.collection.set(vscode.Uri.file(file), diags);
  }

  dispose(): void {
    this.collection.dispose();
  }
}

function payloadKey(file: string, d: vscode.Diagnostic): string {
  return `${file}|${d.range.start.line}|${d.range.start.character}|${typeof d.code === 'object' ? d.code.value : d.code}|${d.message}`;
}
