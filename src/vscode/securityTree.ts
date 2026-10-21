import * as path from 'path';
import * as vscode from 'vscode';
import type { SecurityFinding, Severity } from '../core/security';
import type { AnalysisResult } from '../core/types';
import type { Dismissals } from './dismissals';
import { relativePath } from './endpointTree';

export type SecurityTreeNode = { type: 'severity'; severity: Severity; findings: SecurityFinding[] } | { type: 'finding'; finding: SecurityFinding } | { type: 'dismissed'; findings: SecurityFinding[] };

const SEVERITIES: { severity: Severity; label: string; icon: string; color?: string }[] = [
  { severity: 'high', label: 'High', icon: 'error', color: 'problemsErrorIcon.foreground' },
  { severity: 'medium', label: 'Medium', icon: 'warning', color: 'problemsWarningIcon.foreground' },
  { severity: 'low', label: 'Low', icon: 'info', color: 'problemsInfoIcon.foreground' },
  { severity: 'info', label: 'Informational', icon: 'circle-outline' },
];

/** Security Radar findings by severity, with dismissed findings listed separately. */
export class SecurityTreeProvider implements vscode.TreeDataProvider<SecurityTreeNode> {
  private readonly emitter = new vscode.EventEmitter<SecurityTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private findings: SecurityFinding[] = [];

  constructor(private readonly dismissals: Dismissals) {
    dismissals.onDidChange(() => this.emitter.fire(undefined));
  }

  setResult(result: AnalysisResult): void {
    this.findings = result.security;
    this.emitter.fire(undefined);
  }

  count(): number {
    return this.findings.filter((f) => !this.dismissals.has(f.id)).length;
  }

  getChildren(node?: SecurityTreeNode): SecurityTreeNode[] {
    if (!node) {
      const active = this.findings.filter((f) => !this.dismissals.has(f.id));
      const out: SecurityTreeNode[] = SEVERITIES.map((s) => ({ type: 'severity' as const, severity: s.severity, findings: active.filter((f) => f.severity === s.severity) })).filter((s) => s.findings.length > 0);
      const dismissed = this.findings.filter((f) => this.dismissals.has(f.id));
      if (dismissed.length) out.push({ type: 'dismissed', findings: dismissed });
      return out;
    }
    if (node.type === 'severity' || node.type === 'dismissed') return node.findings.map((finding) => ({ type: 'finding', finding }));
    return [];
  }

  getTreeItem(node: SecurityTreeNode): vscode.TreeItem {
    if (node.type === 'severity') {
      const meta = SEVERITIES.find((s) => s.severity === node.severity)!;
      const item = new vscode.TreeItem(meta.label, node.severity === 'high' || node.severity === 'medium' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `severity:${node.severity}`;
      item.description = String(node.findings.length);
      item.iconPath = new vscode.ThemeIcon(meta.icon, meta.color ? new vscode.ThemeColor(meta.color) : undefined);
      item.accessibilityInformation = { label: `${meta.label} severity, ${node.findings.length} finding(s)` };
      return item;
    }
    if (node.type === 'dismissed') {
      const item = new vscode.TreeItem('Dismissed', vscode.TreeItemCollapsibleState.Collapsed);
      item.id = 'dismissed';
      item.description = String(node.findings.length);
      item.iconPath = new vscode.ThemeIcon('eye-closed');
      item.tooltip = 'Findings dismissed in this workspace. Restore one from its context menu.';
      return item;
    }
    const f = node.finding;
    const dismissed = this.dismissals.has(f.id);
    const item = new vscode.TreeItem(f.endpoint ? `${f.title}: ${f.endpoint}` : f.title, vscode.TreeItemCollapsibleState.None);
    item.id = `finding:${f.id}`;
    item.description = `${path.basename(f.location.file)}:${f.location.line} · ${f.confidence} confidence`;
    item.iconPath = new vscode.ThemeIcon('shield');
    item.contextValue = dismissed ? 'apiShadow.dismissedFinding' : 'apiShadow.finding';
    item.command = { command: 'apiShadow.openLocation', title: 'Open', arguments: [f.location, true] };
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${escape(f.title)}** · \`${f.rule}\`\n\n`);
    tooltip.appendText(f.message);
    tooltip.appendMarkdown('\n\n');
    tooltip.appendMarkdown(`Severity **${f.severity}**, confidence **${f.confidence}**\n\n`);
    tooltip.appendMarkdown('Evidence: ').appendText(f.evidence);
    tooltip.appendMarkdown('\n\nRecommended: ').appendText(f.mitigation);
    tooltip.appendMarkdown('\n\n').appendText(`${relativePath(f.location.file)}:${f.location.line}`);
    item.tooltip = tooltip;
    item.accessibilityInformation = { label: `${f.severity} severity, ${f.confidence} confidence: ${f.message}` };
    return item;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
