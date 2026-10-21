import * as vscode from 'vscode';
import type { ImpactReport } from './core/impact';
import type { AnalysisResult } from './core/types';
import { GROUP_BY_VALUES, type GroupBy } from './core/view';
import { AnalysisController } from './vscode/analysisController';
import { EndpointCodeLensProvider } from './vscode/codeLens';
import { registerCommands } from './vscode/commands';
import { ClientCallLinks } from './vscode/clientLinks';
import { ApiDiagnostics } from './vscode/diagnostics';
import { FlowView } from './vscode/flowView';
import { EndpointSymbols } from './vscode/symbols';
import { EndpointTreeProvider, type EndpointTreeNode } from './vscode/endpointTree';
import { IssuesTreeProvider } from './vscode/issuesTree';
import { ChannelLogger } from './vscode/logger';
import { ApiShadowCodeActions } from './vscode/codeActions';
import { Dashboard } from './vscode/dashboard';
import { Dismissals } from './vscode/dismissals';
import { ImpactController } from './vscode/impactController';
import { IntelState, registerIntelCommands } from './vscode/intelCommands';
import { SecurityTreeProvider } from './vscode/securityTree';

/** Public API returned from `activate`, used by the integration tests and available to other extensions. */
export interface ApiShadowApi {
  getResult(): AnalysisResult | undefined;
  refresh(full?: boolean): Promise<AnalysisResult | undefined>;
  whenIdle(): Promise<void>;
  onDidChangeResult: vscode.Event<AnalysisResult>;
  /** Root (and child) nodes of the Endpoints view as currently filtered/grouped. */
  getTreeChildren(node?: EndpointTreeNode): EndpointTreeNode[];
  getTreeItem(node: EndpointTreeNode): vscode.TreeItem;
  /** The current change impact report, once a baseline is available. */
  getImpactReport(): ImpactReport | undefined;
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
  const diagnostics = new ApiDiagnostics();
  const clientLinks = new ClientCallLinks();
  const flow = new FlowView();
  const sourceFiles: vscode.DocumentSelector = { scheme: 'file', pattern: '**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx,java}' };
  const codeLens = new EndpointCodeLensProvider(() => controller.settings.codeLens);

  const dismissals = new Dismissals(context.workspaceState);
  const impact = new ImpactController(controller, context, logger);
  const security = new SecurityTreeProvider(dismissals);
  const intel = new IntelState(controller);
  const endpointsView = vscode.window.createTreeView('apiShadow.endpoints', { treeDataProvider: tree, showCollapseAll: true });
  const issuesView = vscode.window.createTreeView('apiShadow.issues', { treeDataProvider: issues, showCollapseAll: true });
  const securityView = vscode.window.createTreeView('apiShadow.security', { treeDataProvider: security, showCollapseAll: true });

  const status = vscode.window.createStatusBarItem('apiShadow.status', vscode.StatusBarAlignment.Left, 50);
  status.name = 'API Shadow';
  status.command = 'apiShadow.showDashboard';

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
    const findings = security.count();
    securityView.description = findings > 0 ? `${findings}` : undefined;
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
      const count = (kind: string): number => result?.issues.filter((i) => i.kind === kind).length ?? 0;
      const dups = result?.duplicates.length ?? 0;
      const noAuth = count('no-auth');
      const problems = dups + count('unreachable') + count('broken-call') + count('no-validation') + count('response-mismatch');
      const breaking = impact.report ? impact.report.summary.high : 0;
      const highSecurity = result?.security.filter((f) => f.severity === 'high' && !dismissals.has(f.id)).length ?? 0;
      status.text = `$(symbol-interface) ${n} endpoint${n === 1 ? '' : 's'}${problems ? ` $(warning) ${problems}` : ''}${breaking ? ` $(git-compare) ${breaking}` : ''}${highSecurity ? ` $(shield) ${highSecurity}` : ''}${noAuth ? ` $(unlock) ${noAuth}` : ''}${controller.isAnalyzing ? ' $(sync~spin)' : ''}`;
      status.tooltip = result
        ? `API Shadow: ${n} endpoint(s), ${dups} potential duplicate route group(s), ${count('unreachable')} unreachable route(s), ${count('broken-call')} call(s) to missing routes, ${count('response-mismatch')} read(s) of missing response fields, ${count('no-validation')} unvalidated request bod(ies), ${noAuth} endpoint(s) without detected auth, ${breaking} high-risk change(s)${impact.report ? ` since ${impact.report.baseLabel}` : ''}, ${highSecurity} high-severity security finding(s). ${result.clientCalls.length} client and test call(s) found. Last analysis ${result.stats.durationMs} ms (${result.stats.filesAnalyzed} parsed, ${result.stats.filesFromCache} cached). Click to open the dashboard.`
        : 'API Shadow';
    }
    status.accessibilityInformation = { label: status.tooltip as string };
    status.show();
  };

  let dashboard: Dashboard | undefined;
  const publishDiagnostics = (): void => {
    const result = controller.current;
    if (!result) return;
    const s = controller.settings;
    diagnostics.update(
      result,
      { duplicates: s.duplicateDiagnostics, unreachable: s.unreachableDiagnostics, brokenCalls: s.brokenCallDiagnostics, responseMismatch: s.responseMismatchDiagnostics, impact: s.impact.diagnostics, security: s.security.diagnostics },
      { impact: impact.report, dismissed: dismissals.ids },
    );
  };

  context.subscriptions.push(
    controller,
    tree,
    issues,
    diagnostics,
    dismissals,
    impact,
    security,
    securityView,
    { dispose: () => dashboard?.dispose() },
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new ApiShadowCodeActions(diagnostics), ApiShadowCodeActions.metadata),
    codeLens,
    flow,
    vscode.languages.registerCodeLensProvider(sourceFiles, codeLens),
    vscode.languages.registerDefinitionProvider(sourceFiles, clientLinks),
    vscode.languages.registerHoverProvider(sourceFiles, clientLinks),
    vscode.languages.registerWorkspaceSymbolProvider(new EndpointSymbols(() => tree.allEndpoints())),
    endpointsView,
    issuesView,
    status,
    controller.onDidChangeResult((result) => {
      tree.setResult(result);
      issues.setResult(result);
      security.setResult(result);
      codeLens.setResult(result);
      clientLinks.setResult(result);
      publishDiagnostics();
      updateViewState();
      updateStatus();
      dashboard?.refresh();
      void impact.update(result);
    }),
    controller.onDidChangeAnalyzing(() => {
      updateStatus();
      dashboard?.refresh();
    }),
    impact.onDidChange(() => {
      publishDiagnostics();
      updateStatus();
      dashboard?.refresh();
    }),
    dismissals.onDidChange(() => {
      publishDiagnostics();
      updateViewState();
      updateStatus();
      dashboard?.refresh();
    }),
  );

  registerCommands({ context, controller, tree, logger, flow, onViewStateChanged: updateViewState });
  const actions = registerIntelCommands({ context, controller, impact, dismissals, tree, logger, dashboard: () => (dashboard ??= createDashboard()) }, intel);
  function createDashboard(): Dashboard {
    return new Dashboard({
      extensionUri: context.extensionUri,
      controller,
      impact,
      dismissals,
      logger,
      contractFiles: () => intel.contractFiles,
      lastContract: () => intel.lastContract,
      testProjects: () => intel.testProjects,
      generateTests: actions.generateTests,
      compareContract: actions.compareContract,
    });
  }
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
    getImpactReport: () => impact.report,
  };
}

export function deactivate(): void {
  // Disposables registered on the context are cleaned up by VS Code.
}
