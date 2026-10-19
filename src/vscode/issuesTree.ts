import * as path from 'path';
import * as vscode from 'vscode';
import type { AnalysisIssue, AnalysisResult, IssueKind } from '../core/types';
import { relativePath } from './endpointTree';

export type IssueTreeNode = { type: 'section'; kind: IssueKind; issues: AnalysisIssue[] } | { type: 'issue'; issue: AnalysisIssue; index: number };

const SECTIONS: { kind: IssueKind; label: string; icon: string }[] = [
  { kind: 'unreachable', label: 'Unreachable routes', icon: 'error' },
  { kind: 'broken-call', label: 'Calls to missing routes', icon: 'debug-disconnect' },
  { kind: 'duplicate', label: 'Potential duplicate routes', icon: 'warning' },
  { kind: 'no-auth', label: 'Endpoints without detected auth', icon: 'unlock' },
  { kind: 'no-validation', label: 'Request bodies without validation', icon: 'circle-slash' },
  { kind: 'uncalled', label: 'Endpoints nothing calls', icon: 'eye-closed' },
  { kind: 'parse-error', label: 'Parse errors', icon: 'error' },
  { kind: 'limitation', label: 'Analysis limitations', icon: 'info' },
  { kind: 'skipped', label: 'Skipped files', icon: 'circle-slash' },
];

export class IssuesTreeProvider implements vscode.TreeDataProvider<IssueTreeNode> {
  private readonly emitter = new vscode.EventEmitter<IssueTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private issues: AnalysisIssue[] = [];

  setResult(result: AnalysisResult): void {
    this.issues = result.issues;
    this.emitter.fire(undefined);
  }

  count(): number {
    return this.issues.length;
  }

  getChildren(node?: IssueTreeNode): IssueTreeNode[] {
    if (!node) {
      return SECTIONS.map((s) => ({ type: 'section' as const, kind: s.kind, issues: this.issues.filter((i) => i.kind === s.kind) })).filter((s) => s.issues.length > 0);
    }
    if (node.type === 'section') return node.issues.map((issue, index) => ({ type: 'issue', issue, index }));
    return [];
  }

  getTreeItem(node: IssueTreeNode): vscode.TreeItem {
    if (node.type === 'section') {
      const meta = SECTIONS.find((s) => s.kind === node.kind)!;
      // Bugs open by default; review lists (auth, validation, uncalled) stay collapsed.
      const expanded = node.kind === 'duplicate' || node.kind === 'unreachable' || node.kind === 'broken-call' || node.kind === 'parse-error';
      const item = new vscode.TreeItem(meta.label, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `section:${node.kind}`;
      item.description = String(node.issues.length);
      item.iconPath = new vscode.ThemeIcon(meta.icon);
      item.accessibilityInformation = { label: `${meta.label}, ${node.issues.length}` };
      return item;
    }
    const { issue } = node;
    const item = new vscode.TreeItem(issue.message, vscode.TreeItemCollapsibleState.None);
    item.id = `issue:${issue.kind}:${node.index}:${issue.location?.file ?? ''}:${issue.location?.line ?? 0}`;
    item.iconPath = new vscode.ThemeIcon(issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'info');
    if (issue.location) {
      item.description = `${path.basename(issue.location.file)}:${issue.location.line}`;
      item.command = { command: 'apiShadow.openLocation', title: 'Open', arguments: [issue.location, true] };
    }
    const tooltip = new vscode.MarkdownString();
    tooltip.appendText(issue.message);
    if (issue.location) tooltip.appendMarkdown('\n\n').appendText(`${relativePath(issue.location.file)}:${issue.location.line}`);
    item.tooltip = tooltip;
    item.accessibilityInformation = { label: `${issue.severity}: ${issue.message}${issue.location ? `, ${path.basename(issue.location.file)} line ${issue.location.line}` : ''}` };
    return item;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
