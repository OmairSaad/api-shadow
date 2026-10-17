import * as path from 'path';
import * as vscode from 'vscode';
import { describeAuth } from '../core/auth';
import type { AnalysisResult, Endpoint, HttpMethod, SourceLocation } from '../core/types';
import { EMPTY_FILTER, groupEndpoints, isFilterActive, matchesFilter, type EndpointFilter, type GroupBy } from '../core/view';

export type EndpointTreeNode =
  | { type: 'group'; key: string; label: string; description?: string; endpoints: Endpoint[] }
  | { type: 'endpoint'; endpoint: Endpoint; duplicate: boolean; noAuth: boolean }
  | { type: 'detail'; id: string; label: string; description?: string; icon: string; color?: string; tooltip?: string; location?: SourceLocation };

const METHOD_COLORS: Record<HttpMethod, string> = {
  GET: 'charts.green',
  POST: 'charts.yellow',
  PUT: 'charts.blue',
  PATCH: 'charts.purple',
  DELETE: 'charts.red',
  OPTIONS: 'charts.foreground',
  HEAD: 'charts.foreground',
  ALL: 'charts.orange',
};

const FRAMEWORK_LABEL: Record<string, string> = { express: 'Express', nestjs: 'NestJS', spring: 'Spring' };

export function relativePath(file: string): string {
  return vscode.workspace.asRelativePath(file, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
}

export class EndpointTreeProvider implements vscode.TreeDataProvider<EndpointTreeNode> {
  private readonly emitter = new vscode.EventEmitter<EndpointTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private result: AnalysisResult | undefined;
  private duplicateIds = new Set<string>();
  private noAuthIds = new Set<string>();
  private filterState: EndpointFilter = EMPTY_FILTER;
  private groupMode: GroupBy;

  constructor(groupBy: GroupBy) {
    this.groupMode = groupBy;
  }

  get filter(): EndpointFilter {
    return this.filterState;
  }

  get groupBy(): GroupBy {
    return this.groupMode;
  }

  setResult(result: AnalysisResult): void {
    this.result = result;
    this.duplicateIds = new Set(result.duplicates.flatMap((d) => d.endpointIds));
    this.noAuthIds = new Set(result.issues.filter((i) => i.kind === 'no-auth').flatMap((i) => i.endpointIds ?? []));
    this.emitter.fire(undefined);
  }

  setFilter(filter: EndpointFilter): void {
    this.filterState = filter;
    this.emitter.fire(undefined);
  }

  setGroupBy(groupBy: GroupBy): void {
    this.groupMode = groupBy;
    this.emitter.fire(undefined);
  }

  allEndpoints(): Endpoint[] {
    return this.result?.endpoints ?? [];
  }

  visibleEndpoints(): Endpoint[] {
    return this.allEndpoints().filter((e) => matchesFilter(e, this.filterState));
  }

  isFiltered(): boolean {
    return isFilterActive(this.filterState);
  }

  getChildren(node?: EndpointTreeNode): EndpointTreeNode[] {
    if (!node) {
      const visible = this.visibleEndpoints();
      if (this.groupMode === 'none') return visible.map((e) => this.endpointNode(e));
      return groupEndpoints(visible, this.groupMode, relativePath).map((g) => ({
        type: 'group',
        key: g.key,
        label: g.label,
        description: g.description ? FRAMEWORK_LABEL[g.description] ?? g.description : undefined,
        endpoints: g.endpoints,
      }));
    }
    if (node.type === 'group') return node.endpoints.map((e) => this.endpointNode(e));
    if (node.type === 'endpoint') return this.details(node.endpoint, node.duplicate, node.noAuth);
    return [];
  }

  getParent(): undefined {
    return undefined;
  }

  private endpointNode(endpoint: Endpoint): EndpointTreeNode {
    return { type: 'endpoint', endpoint, duplicate: this.duplicateIds.has(endpoint.id), noAuth: this.noAuthIds.has(endpoint.id) };
  }

  private details(e: Endpoint, duplicate: boolean, noAuth: boolean): EndpointTreeNode[] {
    const out: EndpointTreeNode[] = [];
    if (duplicate) {
      out.push({ type: 'detail', id: `${e.id}:dup`, label: 'Potential duplicate route', icon: 'warning', tooltip: 'Another endpoint in this project matches the same method and path. See the Issues view.' });
    }
    if (e.auth) {
      const label = `Auth: ${describeAuth(e.auth)}`;
      out.push({
        type: 'detail',
        id: `${e.id}:auth`,
        label,
        icon: noAuth ? 'warning' : e.auth.status === 'none' || e.auth.status === 'public' ? 'unlock' : 'shield',
        color: noAuth ? 'list.warningForeground' : undefined,
        description: e.auth.location ? `${path.basename(e.auth.location.file)}:${e.auth.location.line}` : undefined,
        tooltip: noAuth
          ? `${label}. Other endpoints in this project use auth middleware, guards or security annotations; this one has none.`
          : e.auth.status === 'central'
            ? `${label}. Per-path rules in the security configuration are not analyzed.`
            : label,
        location: e.auth.location,
      });
    }
    if (e.handlerLocation) {
      out.push({
        type: 'detail',
        id: `${e.id}:handler`,
        label: `Handler: ${e.handler ?? '(unknown)'}`,
        description: `${path.basename(e.handlerLocation.file)}:${e.handlerLocation.line}`,
        icon: 'symbol-function',
        location: e.handlerLocation,
      });
    }
    if (e.middleware.length > 0) {
      out.push({
        type: 'detail',
        id: `${e.id}:mw`,
        label: `Middleware: ${e.middleware.join(', ')}`,
        icon: 'shield',
        tooltip: e.middleware.join('\n'),
      });
    }
    e.services.forEach((s, i) => {
      out.push({
        type: 'detail',
        id: `${e.id}:svc:${i}`,
        label: `→ ${s.name}`,
        description: s.location ? `${path.basename(s.location.file)}:${s.location.line}` : 'not found in workspace',
        icon: 'symbol-interface',
        location: s.location,
      });
    });
    if (e.parameters.length > 0) {
      out.push({
        type: 'detail',
        id: `${e.id}:params`,
        label: `Params: ${e.parameters.map((p) => `${p.name} (${p.in}${p.required ? '' : ', optional'})`).join(', ')}`,
        icon: 'symbol-parameter',
      });
    }
    if (e.requestBodyType) {
      out.push({ type: 'detail', id: `${e.id}:body`, label: `Body: ${e.requestBodyType}`, icon: 'json' });
    }
    e.notes.forEach((n, i) => out.push({ type: 'detail', id: `${e.id}:note:${i}`, label: n, icon: 'info' }));
    return out;
  }

  getTreeItem(node: EndpointTreeNode): vscode.TreeItem {
    switch (node.type) {
      case 'group': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `group:${this.groupMode}:${node.key}`;
        item.description = [node.description, `${node.endpoints.length}`].filter(Boolean).join(' · ');
        item.iconPath = new vscode.ThemeIcon(this.groupMode === 'file' ? 'file-code' : this.groupMode === 'method' ? 'symbol-event' : 'symbol-class');
        item.contextValue = 'apiShadow.group';
        item.accessibilityInformation = { label: `${node.label}, ${node.endpoints.length} endpoints` };
        return item;
      }
      case 'endpoint':
        return this.endpointItem(node.endpoint, node.duplicate, node.noAuth);
      case 'detail': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = node.id;
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon(node.icon, node.color ? new vscode.ThemeColor(node.color) : undefined);
        item.tooltip = node.tooltip ?? node.label;
        item.contextValue = 'apiShadow.detail';
        item.accessibilityInformation = { label: node.description ? `${node.label}, ${node.description}` : node.label };
        if (node.location) {
          item.command = { command: 'apiShadow.openLocation', title: 'Open', arguments: [node.location, true] };
        }
        return item;
      }
    }
  }

  private endpointItem(e: Endpoint, duplicate: boolean, noAuth: boolean): vscode.TreeItem {
    const label = `${e.method} ${e.path}`;
    const hasDetails = e.middleware.length + e.services.length + e.notes.length + e.parameters.length > 0 || !!e.handlerLocation || !!e.requestBodyType || !!e.auth || duplicate;
    const item = new vscode.TreeItem({ label, highlights: [[0, e.method.length]] }, hasDetails ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = `endpoint:${e.id}`;
    const where = `${path.basename(e.location.file)}:${e.location.line}`;
    item.description = [e.handler, where, duplicate ? 'duplicate' : undefined, noAuth ? 'no auth' : undefined, e.pathIsStatic ? undefined : 'dynamic'].filter(Boolean).join(' · ');
    item.iconPath = duplicate
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
      : new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(METHOD_COLORS[e.method]));
    item.contextValue = 'apiShadow.endpoint';
    item.command = { command: 'apiShadow.openLocation', title: 'Go to Endpoint', arguments: [e.location, true] };
    item.tooltip = this.tooltip(e, duplicate, noAuth);
    item.accessibilityInformation = {
      label: `${e.method} ${e.path}, ${FRAMEWORK_LABEL[e.framework]}${e.handler ? `, handler ${e.handler}` : ''}, ${where}${duplicate ? ', potential duplicate' : ''}${noAuth ? ', no auth found' : ''}`,
      role: 'treeitem',
    };
    return item;
  }

  private tooltip(e: Endpoint, duplicate: boolean, noAuth: boolean): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, false);
    md.isTrusted = false;
    md.supportHtml = false;
    md.appendMarkdown(`**${e.method}** `).appendText(e.path).appendMarkdown('\n\n');
    const row = (k: string, v: string): void => {
      md.appendMarkdown(`*${k}:* `).appendText(v).appendMarkdown('  \n');
    };
    row('Framework', FRAMEWORK_LABEL[e.framework]);
    if (e.controller) row('Controller', e.controller);
    if (e.handler) row('Handler', e.handler);
    row('Source', `${relativePath(e.location.file)}:${e.location.line}`);
    if (e.middleware.length) row('Middleware', e.middleware.join(', '));
    if (e.services.length) row('Services', e.services.map((s) => s.name).join(', '));
    if (e.auth) row('Auth', describeAuth(e.auth) ?? '');
    if (duplicate) row('Warning', 'potential duplicate route');
    if (noAuth) row('Warning', 'no auth found, but other endpoints in this project have it');
    for (const n of e.notes) md.appendMarkdown('- ').appendText(n).appendMarkdown('\n');
    return md;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
