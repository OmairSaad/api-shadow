import * as vscode from 'vscode';
import type { Endpoint } from '../core/types';

/** Endpoints in Go to Symbol in Workspace (Ctrl+T): type `GET /users` or `users`. */
export class EndpointSymbols implements vscode.WorkspaceSymbolProvider {
  constructor(private readonly endpoints: () => Endpoint[]) {}

  provideWorkspaceSymbols(query: string): vscode.SymbolInformation[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.endpoints()
      .filter((e) => {
        const text = `${e.method} ${e.path} ${e.controller ?? ''} ${e.handler ?? ''}`.toLowerCase();
        return terms.every((t) => text.includes(t));
      })
      .slice(0, 500)
      .map((e) => {
        const p = new vscode.Position(Math.max(0, e.location.line - 1), Math.max(0, e.location.column - 1));
        return new vscode.SymbolInformation(`${e.method} ${e.path}`, vscode.SymbolKind.Method, [e.controller, e.handler].filter(Boolean).join('.') || 'API Shadow', new vscode.Location(vscode.Uri.file(e.location.file), p));
      });
  }
}
