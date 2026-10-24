import * as path from 'path';
import * as vscode from 'vscode';
import { describeAuth } from '../core/auth';
import type { AnalysisIssue, AnalysisResult, Endpoint, HttpMethod, SourceLocation } from '../core/types';
import { EMPTY_FILTER, groupEndpoints, isFilterActive, matchesFilter, type EndpointFilter, type GroupBy } from '../core/view';

export type EndpointTreeNode =
  | { type: 'group'; key: string; label: string; description?: string; endpoints: Endpoint[] }
  | { type: 'endpoint'; endpoint: Endpoint; duplicate: boolean; noAuth: boolean }
  | { type: 'detail'; id: string; label: string; description?: string; icon: string; color?: string; tooltip?: string; location?: SourceLocation; command?: vscode.Command };

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

export const FRAMEWORK_LABEL: Record<string, string> = { express: 'Express', fastify: 'Fastify', koa: 'Koa', nestjs: 'NestJS', spring: 'Spring', laravel: 'Laravel' };

export function relativePath(file: string): string {
  return vscode.workspace.asRelativePath(file, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
}

export class EndpointTreeProvider implements vscode.TreeDataProvider<EndpointTreeNode> {
  private readonly emitter = new vscode.EventEmitter<EndpointTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private result: AnalysisResult | undefined;
  private duplicateIds = new Set<string>();
  private noAuthIds = new Set<string>();
  /** Unreachable endpoint id -> the issue (which names the route that catches its requests). */
  private unreachable = new Map<string, AnalysisIssue>();
  private hasCalls = false;
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
    this.unreachable = new Map(result.issues.filter((i) => i.kind === 'unreachable').map((i) => [i.endpointIds![0], i]));
    this.hasCalls = result.clientCalls.length > 0;
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
    const unreachable = this.unreachable.get(e.id);
    if (unreachable) {
      const blocker = unreachable.related?.[0];
      out.push({
        type: 'detail',
        id: `${e.id}:unreachable`,
        label: `Unreachable: ${blocker?.message ?? 'an earlier route catches these requests'}`,
        description: blocker ? `${path.basename(blocker.location.file)}:${blocker.location.line}` : undefined,
        icon: 'error',
        color: 'list.errorForeground',
        tooltip: unreachable.message,
        location: blocker?.location,
      });
    }
    // Where the path comes from: each mount, prefix or group opens at its declaration.
    (e.trace ?? []).forEach((t, i) => {
      out.push({
        type: 'detail',
        id: `${e.id}:trace:${i}`,
        label: t.text,
        description: t.location ? `${path.basename(t.location.file)}:${t.location.line}` : undefined,
        icon: i === 0 ? 'debug-start' : 'debug-step-into',
        tooltip: t.location ? `${t.text} — ${relativePath(t.location.file)}:${t.location.line}. Click to open.` : t.text,
        location: t.location,
      });
    });
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
    if (e.validation) {
      const ok = e.validation.status === 'validated';
      out.push({
        type: 'detail',
        id: `${e.id}:validation`,
        label: ok ? `Body validated: ${e.validation.via.join(', ')}` : `Body not validated${e.validation.via.length ? ` (${e.validation.via.join(', ')})` : ''}`,
        icon: ok ? 'pass' : 'circle-slash',
      });
    }
    if (e.usage && (this.hasCalls || e.usage.calls + e.usage.tests > 0)) {
      const n = e.usage.calls + e.usage.tests;
      out.push({
        type: 'detail',
        id: `${e.id}:usage`,
        label: `Callers: ${e.usage.calls} in code · ${e.usage.tests} in tests`,
        icon: n > 0 ? 'references' : 'circle-slash',
        tooltip: n > 0 ? 'Show the code and tests that call this endpoint' : 'Nothing in the workspace calls this endpoint',
        command: n > 0 ? { command: 'apiShadow.showCallers', title: 'Show Callers', arguments: [e] } : undefined,
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
    // Notes already shown as trace rows are left out.
    e.notes.forEach((n, i) => {
      if (!(e.trace ?? []).some((t) => n.startsWith(t.text))) out.push({ type: 'detail', id: `${e.id}:note:${i}`, label: n, icon: 'info' });
    });
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
        if (node.command) item.command = node.command;
        else if (node.location) {
          item.command = { command: 'apiShadow.openLocation', title: 'Open', arguments: [node.location, true] };
        }
        return item;
      }
    }
  }

  private endpointItem(e: Endpoint, duplicate: boolean, noAuth: boolean): vscode.TreeItem {
    const label = `${e.method} ${e.path}`;
    const unreachable = this.unreachable.has(e.id);
    const hasDetails = e.middleware.length + e.services.length + e.notes.length + e.parameters.length + (e.trace?.length ?? 0) > 0 || !!e.handlerLocation || !!e.requestBodyType || !!e.auth || !!e.usage || duplicate;
    const item = new vscode.TreeItem({ label, highlights: [[0, e.method.length]] }, hasDetails ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = `endpoint:${e.id}`;
    const where = `${path.basename(e.location.file)}:${e.location.line}`;
    item.description = [e.handler, where, unreachable ? 'unreachable' : undefined, duplicate ? 'duplicate' : undefined, noAuth ? 'no auth' : undefined, e.pathIsStatic ? undefined : 'dynamic'].filter(Boolean).join(' · ');
    item.iconPath = unreachable
      ? new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'))
      : duplicate
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
      : new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(METHOD_COLORS[e.method]));
    item.contextValue = 'apiShadow.endpoint';
    item.command = { command: 'apiShadow.openLocation', title: 'Go to Endpoint', arguments: [e.location, true] };
    item.tooltip = this.tooltip(e, duplicate, noAuth);
    item.accessibilityInformation = {
      label: `${e.method} ${e.path}, ${FRAMEWORK_LABEL[e.framework]}${e.handler ? `, handler ${e.handler}` : ''}, ${where}${unreachable ? ', unreachable' : ''}${duplicate ? ', potential duplicate' : ''}${noAuth ? ', no auth found' : ''}`,
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
    if (this.unreachable.has(e.id)) row('Error', 'unreachable: an earlier route catches every request');
    if (e.validation) row('Body', e.validation.status === 'validated' ? `validated (${e.validation.via.join(', ')})` : 'not validated');
    if (e.usage) row('Callers', `${e.usage.calls} in code, ${e.usage.tests} in tests`);
    for (const n of e.notes) md.appendMarkdown('- ').appendText(n).appendMarkdown('\n');
    return md;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
