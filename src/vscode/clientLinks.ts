import * as vscode from 'vscode';
import { describeAuth } from '../core/auth';
import type { AnalysisResult, ClientCall, Endpoint, SourceLocation } from '../core/types';
import { relativePath } from './endpointTree';

function pos(l: SourceLocation): vscode.Position {
  return new vscode.Position(Math.max(0, l.line - 1), Math.max(0, l.column - 1));
}

/**
 * Go to Definition and hovers on the URL of a client call (`fetch('/api/users')`): jump from
 * frontend or test code straight to the route handler.
 */
export class ClientCallLinks implements vscode.DefinitionProvider, vscode.HoverProvider {
  private byFile = new Map<string, ClientCall[]>();
  private endpoints = new Map<string, Endpoint>();

  setResult(result: AnalysisResult): void {
    this.byFile = new Map();
    for (const c of result.clientCalls) this.byFile.set(c.location.file, [...(this.byFile.get(c.location.file) ?? []), c]);
    this.endpoints = new Map(result.endpoints.map((e) => [e.id, e]));
  }

  /** Calls in a file, for CodeLens. */
  callsIn(file: string): ClientCall[] {
    return this.byFile.get(file) ?? [];
  }

  endpoint(id: string): Endpoint | undefined {
    return this.endpoints.get(id);
  }

  private callAt(document: vscode.TextDocument, position: vscode.Position): { call: ClientCall; range: vscode.Range } | undefined {
    if (document.isDirty) return undefined;
    for (const call of this.callsIn(document.uri.fsPath)) {
      const range = new vscode.Range(pos(call.range.start), pos(call.range.end));
      if (range.contains(position)) return { call, range };
    }
    return undefined;
  }

  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.LocationLink[] | undefined {
    const hit = this.callAt(document, position);
    if (!hit) return undefined;
    return hit.call.endpointIds
      .map((id) => this.endpoints.get(id))
      .filter((e): e is Endpoint => !!e)
      .map((e) => {
        const target = e.handlerLocation ?? e.location;
        const p = pos(target);
        return { originSelectionRange: hit.range, targetUri: vscode.Uri.file(target.file), targetRange: new vscode.Range(p, p), targetSelectionRange: new vscode.Range(p, p) };
      });
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const hit = this.callAt(document, position);
    if (!hit) return undefined;
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = false;
    const matches = hit.call.endpointIds.map((id) => this.endpoints.get(id)).filter((e): e is Endpoint => !!e);
    if (matches.length === 0) {
      md.appendMarkdown('$(debug-disconnect) **API Shadow:** no endpoint in this workspace matches ').appendText(`${hit.call.method === 'ALL' ? '' : hit.call.method + ' '}${hit.call.url}`);
      return new vscode.Hover(md, hit.range);
    }
    matches.forEach((e, i) => {
      if (i > 0) md.appendMarkdown('\n\n---\n\n');
      md.appendMarkdown(`$(arrow-right) **${e.method}** `).appendText(e.path).appendMarkdown('\n\n');
      const row = (k: string, v: string): void => {
        md.appendMarkdown(`*${k}:* `).appendText(v).appendMarkdown('  \n');
      };
      if (e.controller || e.handler) row('Handler', [e.controller, e.handler].filter(Boolean).join('.'));
      row('Source', `${relativePath(e.location.file)}:${e.location.line}`);
      if (e.auth) row('Auth', describeAuth(e.auth) ?? '');
      if (e.requestBodyType) row('Body', e.requestBodyType);
      if (e.usage) row('Callers', `${e.usage.calls} in code, ${e.usage.tests} in tests`);
    });
    if (matches.length > 1) md.appendMarkdown('\n\n').appendText(`${matches.length} routes match this URL.`);
    md.appendMarkdown('\n\n*Ctrl+click to go to the handler.*');
    return new vscode.Hover(md, hit.range);
  }
}
