import * as path from 'path';
import * as vscode from 'vscode';
import { HTTP_METHODS, type AnalysisResult, type Endpoint, type HttpMethod, type SourceLocation } from '../core/types';
import { GROUP_BY_VALUES, type GroupBy } from '../core/view';
import { toMarkdown } from '../export/markdown';
import { toOpenApi } from '../export/openapi';
import { baseUrlFor, toCurl, toHttpFile } from '../export/requests';
import type { AnalysisController } from './analysisController';
import { relativePath, type EndpointTreeNode, type EndpointTreeProvider } from './endpointTree';
import type { ChannelLogger } from './logger';

/** Extensions that can send requests from `.http` files. */
const HTTP_CLIENT_EXTENSIONS = ['humao.rest-client', 'anweber.vscode-httpyac'];
const REST_CLIENT_URL = 'https://marketplace.visualstudio.com/items?itemName=humao.rest-client';
const HINT_SHOWN_KEY = 'apiShadow.httpClientHintShown';

const GROUP_LABELS: Record<GroupBy, string> = {
  controller: 'Controller / router file',
  file: 'Source file',
  method: 'HTTP method',
  framework: 'Framework',
  path: 'First path segment',
  none: 'No grouping (flat list)',
};

export interface CommandDeps {
  context: vscode.ExtensionContext;
  controller: AnalysisController;
  tree: EndpointTreeProvider;
  logger: ChannelLogger;
  onViewStateChanged: () => void;
}

export function registerCommands(deps: CommandDeps): void {
  const { context, controller, tree, logger } = deps;
  const reg = (id: string, fn: (...args: never[]) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: never[]) => {
        try {
          return await fn(...args);
        } catch (err) {
          logger.error(err instanceof Error ? err : String(err));
          void vscode.window.showErrorMessage(`API Shadow: ${err instanceof Error ? err.message : String(err)}`);
          return undefined;
        }
      }),
    );
  };

  reg('apiShadow.refresh', () => controller.refresh(true));
  reg('apiShadow.clearCache', () => controller.clearCache());
  reg('apiShadow.showLog', () => logger.show());

  // From the tree, keep keyboard focus in the view (like the Explorer) so users can arrow
  // through endpoints while the editor previews each one.
  reg('apiShadow.openLocation', (location: SourceLocation, preserveFocus?: boolean) => openLocation(location, preserveFocus ?? false));

  reg('apiShadow.openHandler', (node?: EndpointTreeNode) => {
    if (node?.type !== 'endpoint') return;
    return openLocation(node.endpoint.handlerLocation ?? node.endpoint.location);
  });

  reg('apiShadow.copyPath', async (node?: EndpointTreeNode) => {
    if (node?.type !== 'endpoint') return;
    await vscode.env.clipboard.writeText(node.endpoint.path);
    void vscode.window.setStatusBarMessage(`Copied ${node.endpoint.path}`, 2500);
  });

  reg('apiShadow.copyMethodAndPath', async (node?: EndpointTreeNode) => {
    if (node?.type !== 'endpoint') return;
    await vscode.env.clipboard.writeText(`${node.endpoint.method} ${node.endpoint.path}`);
  });

  const baseUrl = (e: Endpoint): string => baseUrlFor(e, { baseUrl: controller.settings.requestsBaseUrl, servers: controller.current?.servers ?? [] });

  // Request commands accept a tree node (context menu), an endpoint (CodeLens) or nothing
  // (Command Palette, which asks for one).
  reg('apiShadow.copyCurl', async (target?: EndpointTreeNode | Endpoint) => {
    const e = endpointOf(target) ?? (await pickEndpoint(tree.allEndpoints(), 'Copy as cURL'));
    if (!e) return;
    const { command, warnings } = toCurl(e, baseUrl(e));
    await vscode.env.clipboard.writeText(command);
    if (warnings.length > 0) void vscode.window.showWarningMessage(`API Shadow: copied the cURL command. ${warnings.join(' ')}`);
    else void vscode.window.setStatusBarMessage(`Copied cURL for ${e.method} ${e.path}`, 2500);
    return command;
  });

  reg('apiShadow.openRequest', async (target?: EndpointTreeNode | Endpoint) => {
    const e = endpointOf(target) ?? (await pickEndpoint(tree.allEndpoints(), 'Open as HTTP Request'));
    if (!e) return;
    const hasClient = HTTP_CLIENT_EXTENSIONS.some((id) => vscode.extensions.getExtension(id));
    // The first line names the untitled tab.
    const notes = hasClient ? [] : [`Send it with one click using the REST Client extension: ${REST_CLIENT_URL}`];
    const doc = await openUntitled(toHttpFile([e], { title: `${e.method} ${e.path}`, notes, baseUrl }));
    // Suggest the client once; the note in the file covers later requests.
    if (!hasClient && !context.globalState.get<boolean>(HINT_SHOWN_KEY)) {
      void context.globalState.update(HINT_SHOWN_KEY, true);
      void vscode.window
        .showInformationMessage('API Shadow: install the REST Client extension to send this request with one click.', 'Show REST Client', 'Copy as cURL Instead')
        .then((choice) => {
          if (choice === 'Show REST Client') void vscode.commands.executeCommand('extension.open', HTTP_CLIENT_EXTENSIONS[0]);
          else if (choice) void vscode.commands.executeCommand('apiShadow.copyCurl', e);
        });
    }
    return doc;
  });

  reg('apiShadow.endpointActions', async (target?: EndpointTreeNode | Endpoint) => {
    const e = endpointOf(target);
    if (!e) return;
    const actions: (vscode.QuickPickItem & { run: () => unknown })[] = [
      { label: '$(play) Try It', description: 'open a ready-to-send .http request', run: () => vscode.commands.executeCommand('apiShadow.openRequest', e) },
      { label: '$(copy) Copy as cURL', run: () => vscode.commands.executeCommand('apiShadow.copyCurl', e) },
      { label: '$(clippy) Copy Path', description: e.path, run: () => vscode.env.clipboard.writeText(e.path) },
      { label: '$(clippy) Copy Method and Path', run: () => vscode.env.clipboard.writeText(`${e.method} ${e.path}`) },
    ];
    if (e.handlerLocation && (e.handlerLocation.file !== e.location.file || e.handlerLocation.line !== e.location.line)) {
      actions.unshift({ label: '$(go-to-file) Go to Handler', description: e.handler, run: () => openLocation(e.handlerLocation) });
    }
    const pick = await vscode.window.showQuickPick(actions, { title: `${e.method} ${e.path}` });
    await pick?.run();
  });

  reg('apiShadow.filter', async (text?: string) => {
    let value = typeof text === 'string' ? text : undefined;
    if (value === undefined) {
      value = await vscode.window.showInputBox({
        title: 'Filter API Endpoints',
        prompt: 'Matches method, path, controller, handler, file, middleware and services. Separate terms with spaces.',
        placeHolder: 'e.g. users GET',
        value: tree.filter.text,
      });
      if (value === undefined) return;
    }
    tree.setFilter({ ...tree.filter, text: value });
    deps.onViewStateChanged();
  });

  reg('apiShadow.filterByMethod', async (methods?: string[]) => {
    let selected: HttpMethod[] | undefined;
    if (Array.isArray(methods)) {
      selected = methods.map((m) => m.toUpperCase()).filter((m): m is HttpMethod => (HTTP_METHODS as string[]).includes(m));
    } else {
      const counts = new Map<HttpMethod, number>();
      for (const e of tree.allEndpoints()) counts.set(e.method, (counts.get(e.method) ?? 0) + 1);
      const items = HTTP_METHODS.filter((m) => counts.has(m) || tree.filter.methods.has(m)).map((m) => ({
        label: m,
        description: `${counts.get(m) ?? 0} endpoint(s)`,
        picked: tree.filter.methods.has(m),
      }));
      const picked = await vscode.window.showQuickPick(items, {
        title: 'Filter by HTTP Method',
        placeHolder: 'Select methods to show (none selected shows all)',
        canPickMany: true,
      });
      if (!picked) return;
      selected = picked.map((p) => p.label);
    }
    tree.setFilter({ ...tree.filter, methods: new Set(selected) });
    deps.onViewStateChanged();
  });

  reg('apiShadow.clearFilter', () => {
    tree.setFilter({ text: '', methods: new Set() });
    deps.onViewStateChanged();
  });

  reg('apiShadow.groupBy', async (mode?: string) => {
    let value = typeof mode === 'string' && (GROUP_BY_VALUES as string[]).includes(mode) ? (mode as GroupBy) : undefined;
    if (!value) {
      const pick = await vscode.window.showQuickPick(
        GROUP_BY_VALUES.map((g) => ({ label: GROUP_LABELS[g], value: g, description: g === tree.groupBy ? 'current' : undefined })),
        { title: 'Group Endpoints By' },
      );
      if (!pick) return;
      value = pick.value;
    }
    tree.setGroupBy(value);
    await context.workspaceState.update('apiShadow.groupBy', value);
    deps.onViewStateChanged();
  });

  reg('apiShadow.search', async () => {
    const e = await pickEndpoint(tree.allEndpoints(), 'Search API Endpoints', 'Type to search by method, path, handler or file');
    if (e) await openLocation(e.location);
  });

  reg('apiShadow.exportMarkdown', async (target?: vscode.Uri) => {
    const result = await requireResult(controller);
    if (!result) return;
    const uri = target instanceof vscode.Uri ? target : await saveTarget('api-endpoints.md', { Markdown: ['md'] });
    if (!uri) return;
    const md = toMarkdown(result, { title: `${workspaceTitle()} API Endpoints`, relativePath, includeSourceLocations: controller.settings.exportIncludeSourceLocations });
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(md));
    logger.info(`Exported Markdown to ${uri.fsPath}`);
    await announceExport(uri, target === undefined);
    return uri;
  });

  reg('apiShadow.exportHttp', async (target?: vscode.Uri) => {
    const result = await requireResult(controller);
    if (!result) return;
    const uri = target instanceof vscode.Uri ? target : await saveTarget('api-requests.http', { 'HTTP requests': ['http', 'rest'] });
    if (!uri) return;
    const content = toHttpFile(result.endpoints, {
      title: `${workspaceTitle()} API requests`,
      baseUrl,
      relativePath: controller.settings.exportIncludeSourceLocations ? relativePath : undefined,
    });
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
    logger.info(`Exported ${result.endpoints.length} request(s) to ${uri.fsPath}`);
    await announceExport(uri, target === undefined);
    return uri;
  });

  reg('apiShadow.exportOpenApi', async (target?: vscode.Uri) => {
    const result = await requireResult(controller);
    if (!result) return;
    const uri = target instanceof vscode.Uri ? target : await saveTarget('openapi.json', { JSON: ['json'] });
    if (!uri) return;
    const doc = toOpenApi(result, { title: `${workspaceTitle()} API`, relativePath, includeSourceLocations: controller.settings.exportIncludeSourceLocations });
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(doc, null, 2) + '\n'));
    const skipped = doc['x-api-shadow'].skipped.length;
    logger.info(`Exported OpenAPI to ${uri.fsPath} (${doc['x-api-shadow'].included} operations, ${skipped} skipped)`);
    if (skipped > 0 && target === undefined) {
      void vscode.window.showWarningMessage(`API Shadow: ${skipped} endpoint(s) could not be represented exactly in OpenAPI and were listed under "x-api-shadow.skipped".`);
    }
    await announceExport(uri, target === undefined);
    return uri;
  });
}

function endpointOf(target: EndpointTreeNode | Endpoint | undefined): Endpoint | undefined {
  if (!target || typeof target !== 'object') return undefined;
  if ('type' in target) return target.type === 'endpoint' ? target.endpoint : undefined;
  return typeof target.method === 'string' && typeof target.path === 'string' ? target : undefined;
}

async function pickEndpoint(endpoints: Endpoint[], title: string, placeHolder = 'Choose an endpoint'): Promise<Endpoint | undefined> {
  if (endpoints.length === 0) {
    void vscode.window.showInformationMessage('API Shadow: no endpoints discovered yet.');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    endpoints.map((e) => ({ label: `${e.method} ${e.path}`, description: [e.controller, e.handler].filter(Boolean).join(' · '), detail: `${relativePath(e.location.file)}:${e.location.line}`, endpoint: e })),
    { title, placeHolder, matchOnDescription: true, matchOnDetail: true },
  );
  return pick?.endpoint;
}

/** Opens generated content next to the code, like the Markdown preview. */
async function openUntitled(content: string): Promise<vscode.TextDocument> {
  const language = (await vscode.languages.getLanguages()).includes('http') ? 'http' : 'plaintext';
  const doc = await vscode.workspace.openTextDocument({ language, content });
  await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  return doc;
}

async function requireResult(controller: AnalysisController): Promise<AnalysisResult | undefined> {
  if (!controller.current) await controller.refresh(false);
  if (!controller.current || controller.current.endpoints.length === 0) {
    void vscode.window.showInformationMessage('API Shadow: there are no endpoints to export.');
    return undefined;
  }
  return controller.current;
}

function workspaceTitle(): string {
  return vscode.workspace.name?.replace(/\s*\(Workspace\)$/, '') ?? 'Workspace';
}

async function saveTarget(fileName: string, filters: Record<string, string[]>): Promise<vscode.Uri | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  return vscode.window.showSaveDialog({
    defaultUri: folder ? vscode.Uri.joinPath(folder, fileName) : undefined,
    filters,
    saveLabel: 'Export',
    title: 'Export API Endpoints',
  });
}

async function announceExport(uri: vscode.Uri, interactive: boolean): Promise<void> {
  if (!interactive) return;
  const choice = await vscode.window.showInformationMessage(`API Shadow: exported ${path.basename(uri.fsPath)}.`, 'Open');
  if (choice === 'Open') await vscode.window.showTextDocument(uri);
}

export async function openLocation(location: SourceLocation | undefined, preserveFocus = false): Promise<void> {
  if (!location) return;
  const pos = new vscode.Position(Math.max(0, location.line - 1), Math.max(0, location.column - 1));
  await vscode.window.showTextDocument(vscode.Uri.file(location.file), { selection: new vscode.Range(pos, pos), preserveFocus, preview: true });
}
