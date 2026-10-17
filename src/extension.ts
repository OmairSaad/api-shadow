import * as vscode from 'vscode';
import type { AnalysisResult } from './core/types';
import { GROUP_BY_VALUES, type GroupBy } from './core/view';
import { AnalysisController } from './vscode/analysisController';
import { registerCommands } from './vscode/commands';
import { DuplicateDiagnostics } from './vscode/diagnostics';
import { EndpointTreeProvider, type EndpointTreeNode } from './vscode/endpointTree';
import { IssuesTreeProvider } from './vscode/issuesTree';
import { ChannelLogger } from './vscode/logger';

/** Public API returned from `activate`, used by the integration tests and available to other extensions. */
export interface ApiShadowApi {
  getResult(): AnalysisResult | undefined;
  refresh(full?: boolean): Promise<AnalysisResult | undefined>;
  whenIdle(): Promise<void>;
  onDidChangeResult: vscode.Event<AnalysisResult>;
  /** Root (and child) nodes of the Endpoints view as currently filtered/grouped. */
  getTreeChildren(node?: EndpointTreeNode): EndpointTreeNode[];
  getTreeItem(node: EndpointTreeNode): vscode.TreeItem;
}

export function activate(context: vscode.ExtensionContext): ApiShadowApi {
  const logger = new ChannelLogger('API Shadow');
  context.subscriptions.push(logger);
  logger.info(`API Shadow ${context.extension.packageJSON.version as string} activated.`);

  const controller = new AnalysisController(context, logger);
  const storedGroup = context.workspaceState.get<string>('apiShadow.groupBy');
  const groupBy: GroupBy = storedGroup && (GROUP_BY_VALUES as string[]).includes(storedGroup) ? (storedGroup as GroupBy) : controller.settings.groupBy;
  const tree = new EndpointTreeProvider(groupBy);
  const issues = new IssuesTreeProvider();
  const diagnostics = new DuplicateDiagnostics();

  const endpointsView = vscode.window.createTreeView('apiShadow.endpoints', { treeDataProvider: tree, showCollapseAll: true });
  const issuesView = vscode.window.createTreeView('apiShadow.issues', { treeDataProvider: issues, showCollapseAll: true });

  const status = vscode.window.createStatusBarItem('apiShadow.status', vscode.StatusBarAlignment.Left, 50);
  status.name = 'API Shadow';
  status.command = 'apiShadow.endpoints.focus';

  const updateViewState = (): void => {
    const total = tree.allEndpoints().length;
    const visible = tree.visibleEndpoints().length;
    const filtered = tree.isFiltered();
    void vscode.commands.executeCommand('setContext', 'apiShadow.filtered', filtered);
    endpointsView.description = filtered ? `${visible} of ${total}` : total > 0 ? `${total}` : undefined;
    const parts: string[] = [];
    if (tree.filter.text.trim()) parts.push(`text "${tree.filter.text.trim()}"`);
    if (tree.filter.methods.size) parts.push(`methods ${[...tree.filter.methods].join(', ')}`);
    endpointsView.message = filtered ? (visible === 0 ? `No endpoints match: ${parts.join('; ')}.` : `Filtered by ${parts.join('; ')}.`) : undefined;
    const issueCount = issues.count();
    issuesView.description = issueCount > 0 ? `${issueCount}` : undefined;
  };

  const updateStatus = (): void => {
    if (!controller.settings.showStatusBar || !vscode.workspace.workspaceFolders?.length) {
      status.hide();
      return;
    }
    const result = controller.current;
    if (controller.isAnalyzing && !result) {
      status.text = '$(sync~spin) API Shadow';
      status.tooltip = 'API Shadow: analyzing workspace…';
    } else {
      const n = result?.endpoints.length ?? 0;
      const dups = result?.duplicates.length ?? 0;
      status.text = `$(symbol-interface) ${n} endpoint${n === 1 ? '' : 's'}${dups ? ` $(warning) ${dups}` : ''}${controller.isAnalyzing ? ' $(sync~spin)' : ''}`;
      status.tooltip = result
        ? `API Shadow: ${n} endpoint(s), ${dups} potential duplicate route group(s). Last analysis ${result.stats.durationMs} ms (${result.stats.filesAnalyzed} parsed, ${result.stats.filesFromCache} cached).`
        : 'API Shadow';
    }
    status.accessibilityInformation = { label: status.tooltip as string };
    status.show();
  };

  context.subscriptions.push(
    controller,
    tree,
    issues,
    diagnostics,
    endpointsView,
    issuesView,
    status,
    controller.onDidChangeResult((result) => {
      tree.setResult(result);
      issues.setResult(result);
      diagnostics.update(result, controller.settings.duplicateDiagnostics);
      updateViewState();
      updateStatus();
    }),
    controller.onDidChangeAnalyzing(() => updateStatus()),
  );

  registerCommands({ context, controller, tree, logger, onViewStateChanged: updateViewState });
  void vscode.commands.executeCommand('setContext', 'apiShadow.filtered', false);
  updateStatus();

  // Initial analysis runs in the background; the UI shows a progress indicator in the view.
  void controller.refresh(false);

  return {
    getResult: () => controller.current,
    refresh: async (full = true) => {
      await controller.refresh(full);
      return controller.current;
    },
    whenIdle: () => controller.whenIdle(),
    onDidChangeResult: controller.onDidChangeResult,
    getTreeChildren: (node) => tree.getChildren(node),
    getTreeItem: (node) => tree.getTreeItem(node),
  };
}

export function deactivate(): void {
  // Disposables registered on the context are cleaned up by VS Code.
}
