import * as vscode from 'vscode';
import type { ApiDiagnostics } from './diagnostics';

/**
 * Quick fixes for API Shadow diagnostics. Edits are only applied when the user picks the fix;
 * nothing is rewritten automatically.
 */
export class ApiShadowCodeActions implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] };

  constructor(private readonly diagnostics: ApiDiagnostics) {}

  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const out: vscode.CodeAction[] = [];
    for (const diag of context.diagnostics) {
      if (diag.source !== 'API Shadow') continue;
      const payload = this.diagnostics.payloadOf(doc.uri, diag);
      if (!payload) continue;
      if (payload.kind === 'rename') {
        const edit = renameEdit(doc, diag.range.start, payload.from, payload.to);
        if (edit) {
          const action = new vscode.CodeAction(`Replace \`${payload.from}\` with \`${payload.to}\``, vscode.CodeActionKind.QuickFix);
          action.edit = edit;
          action.diagnostics = [diag];
          action.isPreferred = true;
          out.push(action);
        }
      }
      if (payload.kind === 'rename' || payload.kind === 'impact') {
        if (diag.code === 'breaking-change') out.push(command('Show change impact', 'apiShadow.analyzeImpact', [], diag));
        if (payload.dismissId) out.push(command('Dismiss this warning', 'apiShadow.dismissFinding', [payload.dismissId], diag));
      }
      if (payload.kind === 'security') {
        out.push(command(`Show "${payload.finding.title}" in Security Radar`, 'apiShadow.showDashboard', ['security', payload.finding.id], diag));
        out.push(command('Dismiss this finding (false positive or accepted risk)', 'apiShadow.dismissFinding', [payload.finding.id], diag));
        out.push(command(`Turn off rule ${payload.finding.rule} for this workspace…`, 'apiShadow.disableSecurityRule', [payload.finding.rule], diag));
      }
    }
    return out;
  }
}

function command(title: string, id: string, args: unknown[], diag: vscode.Diagnostic): vscode.CodeAction {
  const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  action.command = { command: id, title, arguments: args };
  action.diagnostics = [diag];
  return action;
}

/**
 * Replaces the first `.from` / `?.from` / `['from']` at or after `at` on its line. Destructuring
 * (`const { name } = user`) is left alone: renaming it would also rename the local variable.
 */
export function renameEdit(doc: vscode.TextDocument, at: vscode.Position, from: string, to: string): vscode.WorkspaceEdit | undefined {
  if (at.line >= doc.lineCount || !/^[A-Za-z_$][\w$]*$/.test(to)) return undefined;
  const text = doc.lineAt(at.line).text;
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(\\?\\.|\\.)\\s*(${escaped})\\b|\\[\\s*(['"])(${escaped})\\3\\s*\\]`, 'g');
  re.lastIndex = Math.max(0, at.character);
  const m = re.exec(text);
  if (!m) return undefined;
  const name = m[2] ?? m[4];
  const offset = m.index + m[0].indexOf(name, m[1] ? m[1].length : 0);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(at.line, offset, at.line, offset + name.length), to);
  return edit;
}
