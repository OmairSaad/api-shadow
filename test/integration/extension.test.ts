import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ApiShadowApi } from '../../src/extension';
import type { AnalysisResult } from '../../src/core/types';

// Compiled to out/test/integration/, so the manifest is three levels up.
const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as { publisher: string; name: string };
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'a workspace folder must be open');
  return folder.uri.fsPath;
}

function waitForResult(api: ApiShadowApi, predicate: (r: AnalysisResult) => boolean, timeoutMs = 20000): Promise<AnalysisResult> {
  return new Promise((resolve, reject) => {
    const current = api.getResult();
    if (current && predicate(current)) return resolve(current);
    const timer = setTimeout(() => {
      sub.dispose();
      reject(new Error('Timed out waiting for analysis result'));
    }, timeoutMs);
    const sub = api.onDidChangeResult((r) => {
      if (predicate(r)) {
        clearTimeout(timer);
        sub.dispose();
        resolve(r);
      }
    });
  });
}

function labels(api: ApiShadowApi): string[] {
  const out: string[] = [];
  for (const root of api.getTreeChildren()) {
    if (root.type === 'endpoint') out.push(String(api.getTreeItem(root).label && (api.getTreeItem(root).label as vscode.TreeItemLabel).label));
    for (const child of api.getTreeChildren(root)) {
      if (child.type === 'endpoint') out.push((api.getTreeItem(child).label as vscode.TreeItemLabel).label);
    }
  }
  return out;
}

describe('API Shadow extension (Extension Development Host)', function () {
  let api: ApiShadowApi;

  before(async function () {
    const ext = vscode.extensions.getExtension<ApiShadowApi>(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} is installed`);
    api = await ext.activate();
    await waitForResult(api, (r) => r.endpoints.length > 0);
    await api.whenIdle();
  });

  afterEach(async function () {
    await vscode.commands.executeCommand('apiShadow.clearFilter');
    await vscode.commands.executeCommand('apiShadow.groupBy', 'controller');
  });

  it('activates automatically and discovers endpoints for all three frameworks', function () {
    const result = api.getResult()!;
    const frameworks = new Set(result.endpoints.map((e) => e.framework));
    assert.deepStrictEqual([...frameworks].sort(), ['express', 'nestjs', 'spring']);
    const paths = result.endpoints.map((e) => `${e.method} ${e.path}`);
    for (const expected of ['GET /users/:id', 'POST /api/v1/users', 'GET /shop/api/orders/{orderId}']) {
      assert.ok(paths.includes(expected), `missing ${expected}`);
    }
    assert.ok(!paths.some((p) => p.includes('should-never-appear')), 'node_modules must not be analysed');
  });

  it('registers all contributed commands', async function () {
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['refresh', 'search', 'filter', 'filterByMethod', 'clearFilter', 'groupBy', 'exportMarkdown', 'exportOpenApi', 'exportHttp', 'clearCache', 'showLog', 'openLocation', 'openHandler', 'copyPath', 'copyCurl', 'openRequest', 'endpointActions', 'showFlow', 'showCallers', 'compareWithRef']) {
      assert.ok(commands.includes(`apiShadow.${id}`), `apiShadow.${id}`);
    }
  });

  it('builds the sidebar tree with groups, endpoints and detail children', function () {
    const roots = api.getTreeChildren();
    assert.ok(roots.length > 3);
    const users = roots.find((r) => r.type === 'group' && r.label === 'UsersController');
    assert.ok(users, 'UsersController group');
    const endpoints = api.getTreeChildren(users);
    const create = endpoints.find((n) => n.type === 'endpoint' && n.endpoint.method === 'POST');
    assert.ok(create);
    const item = api.getTreeItem(create);
    assert.strictEqual((item.label as vscode.TreeItemLabel).label, 'POST /api/v1/users');
    assert.strictEqual(item.command?.command, 'apiShadow.openLocation');
    assert.ok(item.accessibilityInformation?.label.includes('POST /api/v1/users'));
    const details = api.getTreeChildren(create).map((d) => (d.type === 'detail' ? d.label : ''));
    assert.ok(details.some((d) => d.startsWith('Middleware: UseGuards(AuthGuard)')));
    assert.ok(details.includes('→ UsersService.create'));
  });

  it('filters by text and HTTP method, and groups by method', async function () {
    await vscode.commands.executeCommand('apiShadow.filter', 'products');
    let visible = labels(api);
    assert.ok(visible.length > 0 && visible.every((l) => l.toLowerCase().includes('products')), visible.join('\n'));

    await vscode.commands.executeCommand('apiShadow.filterByMethod', ['DELETE']);
    visible = labels(api);
    assert.ok(visible.length > 0 && visible.every((l) => l.startsWith('DELETE ') && l.includes('products')), visible.join('\n'));

    await vscode.commands.executeCommand('apiShadow.clearFilter');
    await vscode.commands.executeCommand('apiShadow.groupBy', 'method');
    const groups = api.getTreeChildren().map((g) => (g.type === 'group' ? g.label : ''));
    assert.deepStrictEqual(groups.slice(0, 3), ['GET', 'POST', 'PUT']);
  });

  it('navigates to the endpoint source line', async function () {
    const target = api.getResult()!.endpoints.find((e) => e.method === 'POST' && e.path === '/users')!;
    await vscode.commands.executeCommand('apiShadow.openLocation', target.location);
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor);
    assert.strictEqual(editor.document.uri.fsPath, target.location.file);
    assert.strictEqual(editor.selection.active.line, target.location.line - 1);
    assert.match(editor.document.lineAt(editor.selection.active.line).text, /router\.post/);
  });

  it('reports duplicate routes in the Problems panel', function () {
    const users = path.join(workspaceRoot(), 'express-app', 'src', 'routes', 'users.js');
    const diags = vscode.languages.getDiagnostics(vscode.Uri.file(users));
    assert.ok(diags.some((d) => d.source === 'API Shadow' && /Potential duplicate route GET/.test(d.message)), JSON.stringify(diags.map((d) => d.message)));
  });

  it('exports Markdown and OpenAPI files', async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-shadow-export-'));
    const md = vscode.Uri.file(path.join(dir, 'api.md'));
    const oas = vscode.Uri.file(path.join(dir, 'openapi.json'));
    await vscode.commands.executeCommand('apiShadow.exportMarkdown', md);
    await vscode.commands.executeCommand('apiShadow.exportOpenApi', oas);
    const mdText = fs.readFileSync(md.fsPath, 'utf8');
    assert.match(mdText, /\| POST \| `\/api\/v1\/users` \|/);
    const doc = JSON.parse(fs.readFileSync(oas.fsPath, 'utf8'));
    assert.strictEqual(doc.openapi, '3.0.3');
    assert.ok(doc.paths['/api/v1/users/{id}'].get);
    assert.ok(!fs.readFileSync(oas.fsPath, 'utf8').includes('SUPER_SECRET_DO_NOT_LEAK'));
  });

  it('re-analyses incrementally when a route file is created, changed and deleted', async function () {
    const file = path.join(workspaceRoot(), 'express-app', 'src', 'routes', 'live.js');
    const app = path.join(workspaceRoot(), 'express-app', 'src', 'app.js');
    const original = fs.readFileSync(app, 'utf8');
    try {
      fs.writeFileSync(file, "const r = require('express').Router();\nr.get('/ping', (req, res) => res.end());\nmodule.exports = r;\n");
      fs.writeFileSync(app, original.replace("registerHealth(app);", "registerHealth(app);\napp.use('/live', require('./routes/live'));"));
      await waitForResult(api, (r) => r.endpoints.some((e) => e.path === '/live/ping'));

      fs.writeFileSync(file, "const r = require('express').Router();\nr.post('/pong', (req, res) => res.end());\nmodule.exports = r;\n");
      const changed = await waitForResult(api, (r) => r.endpoints.some((e) => e.path === '/live/pong'));
      assert.ok(!changed.endpoints.some((e) => e.path === '/live/ping'));
    } finally {
      fs.rmSync(file, { force: true });
      fs.writeFileSync(app, original);
    }
    await waitForResult(api, (r) => !r.endpoints.some((e) => e.path.startsWith('/live')));
  });

  it('reacts to configuration changes', async function () {
    const config = vscode.workspace.getConfiguration('apiShadow');
    await config.update('frameworks', ['spring'], vscode.ConfigurationTarget.Workspace);
    try {
      const r = await waitForResult(api, (x) => x.endpoints.length > 0 && x.endpoints.every((e) => e.framework === 'spring'));
      assert.ok(r.endpoints.length >= 10);
    } finally {
      await config.update('frameworks', undefined, vscode.ConfigurationTarget.Workspace);
    }
    await waitForResult(api, (x) => new Set(x.endpoints.map((e) => e.framework)).size === 3);
  });

  it('shows CodeLens with method, path, auth and request actions above endpoints', async function () {
    const users = vscode.Uri.file(path.join(workspaceRoot(), 'nest-app', 'src', 'users', 'users.controller.ts'));
    await vscode.window.showTextDocument(users);
    const lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', users)) ?? [];
    const create = api.getResult()!.endpoints.find((e) => e.method === 'POST' && e.path === '/api/v1/users')!;
    const titles = lenses.filter((l) => l.range.start.line === create.location.line - 1).map((l) => l.command?.title);
    assert.deepStrictEqual(titles, ['POST /api/v1/users', '$(shield) AuthGuard, RolesGuard', '$(references) 1 caller', '$(play) Try it', '$(copy) cURL'], JSON.stringify(titles));
    const commands = lenses.filter((l) => l.range.start.line === create.location.line - 1).map((l) => l.command?.command);
    assert.deepStrictEqual(commands, ['apiShadow.endpointActions', '', 'apiShadow.showCallers', 'apiShadow.openRequest', 'apiShadow.copyCurl']);

    const admin = vscode.Uri.file(path.join(workspaceRoot(), 'nest-app', 'src', 'admin', 'admin.controller.ts'));
    await vscode.workspace.openTextDocument(admin);
    const adminLenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', admin)) ?? [];
    assert.ok(adminLenses.some((l) => l.command?.title === '$(warning) No auth found'));

    await vscode.workspace.getConfiguration('apiShadow').update('codeLens.enabled', false, vscode.ConfigurationTarget.Workspace);
    try {
      await api.whenIdle();
      const none = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', users)) ?? [];
      assert.ok(!none.some((l) => l.command?.title === '$(play) Try it'));
    } finally {
      await vscode.workspace.getConfiguration('apiShadow').update('codeLens.enabled', undefined, vscode.ConfigurationTarget.Workspace);
    }
    await api.whenIdle();
  });

  it('copies cURL commands and opens .http requests', async function () {
    const create = api.getResult()!.endpoints.find((e) => e.method === 'POST' && e.path === '/api/v1/users')!;
    await vscode.commands.executeCommand('apiShadow.copyCurl', create);
    const curl = await vscode.env.clipboard.readText();
    assert.ok(curl.startsWith("curl -X POST 'http://localhost:3000/api/v1/users'"), curl);
    assert.ok(curl.includes('Authorization: Bearer $TOKEN'), curl);

    const doc = await vscode.commands.executeCommand<vscode.TextDocument>('apiShadow.openRequest', create);
    assert.ok(doc?.isUntitled);
    assert.match(doc.getText(), /^@baseUrl = http:\/\/localhost:3000$/m);
    assert.match(doc.getText(), /^POST \{\{baseUrl\}\}\/api\/v1\/users$/m);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  it('exports every endpoint as .http requests', async function () {
    const target = vscode.Uri.file(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'api-shadow-http-')), 'api.http'));
    await vscode.commands.executeCommand('apiShadow.exportHttp', target);
    const text = fs.readFileSync(target.fsPath, 'utf8');
    assert.match(text, /^@baseUrl = http:\/\/localhost:\d+$/m);
    assert.strictEqual((text.match(/^### /gm) ?? []).length, api.getResult()!.endpoints.length);
    assert.ok(text.includes('GET {{baseUrl2}}/shop/api/orders/{{orderId}}') || text.includes('GET {{baseUrl}}/shop/api/orders/{{orderId}}'), text);
  });

  it('shows auth in the tree and lists endpoints without auth in the Issues view', function () {
    const result = api.getResult()!;
    const noAuth = result.issues.filter((i) => i.kind === 'no-auth');
    assert.ok(noAuth.some((i) => i.message.startsWith('No auth found for POST /api/orders')), JSON.stringify(noAuth.map((i) => i.message)));
    const users = api.getTreeChildren().find((r) => r.type === 'group' && r.label === 'UsersController')!;
    const create = api.getTreeChildren(users).find((n) => n.type === 'endpoint' && n.endpoint.method === 'POST')!;
    const details = api.getTreeChildren(create).map((d) => (d.type === 'detail' ? d.label : ''));
    assert.ok(details.includes('Auth: UseGuards(AuthGuard), UseGuards(RolesGuard)'), details.join('\n'));
  });

  it('jumps from a frontend call to its handler, with a hover', async function () {
    const client = vscode.Uri.file(path.join(workspaceRoot(), 'web-app', 'src', 'api', 'client.ts'));
    const doc = await vscode.workspace.openTextDocument(client);
    const line = doc.getText().split('\n').findIndex((l) => l.includes("axios.post('/api/v1/users'"));
    const at = new vscode.Position(line, doc.lineAt(line).text.indexOf("'/api") + 3);
    const defs = (await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', client, at)) ?? [];
    const targets = defs.map((d) => ('targetUri' in d ? d.targetUri : d.uri).fsPath);
    assert.ok(targets.some((f) => f.endsWith(path.join('users', 'users.controller.ts'))), JSON.stringify(targets));
    const hovers = (await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', client, at)) ?? [];
    const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : ''))).join('\n');
    assert.match(text, /UsersController\.create/);
    const lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', client)) ?? [];
    assert.ok(lenses.some((l) => l.range.start.line === line && l.command?.title === '$(arrow-right) POST /api/v1/users · UsersController.create'), JSON.stringify(lenses.map((l) => l.command?.title)));
  });

  it('finds endpoints with Go to Symbol in Workspace', async function () {
    const symbols = (await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', 'GET /users/me')) ?? [];
    assert.ok(symbols.some((s) => s.name === 'GET /users/me' && s.location.uri.fsPath.endsWith('users.js')), JSON.stringify(symbols.map((s) => s.name)));
  });

  it('reports unreachable routes and calls to missing routes in the Problems panel', function () {
    const users = vscode.languages.getDiagnostics(vscode.Uri.file(path.join(workspaceRoot(), 'express-app', 'src', 'routes', 'users.js')));
    const unreachable = users.find((d) => d.code === 'unreachable-route');
    assert.ok(unreachable && /GET \/users\/me is unreachable/.test(unreachable.message), JSON.stringify(users.map((d) => d.message)));
    assert.strictEqual(unreachable.relatedInformation?.[0].location.range.start.line, 7);
    const orders = vscode.languages.getDiagnostics(vscode.Uri.file(path.join(workspaceRoot(), 'web-app', 'src', 'pages', 'Orders.tsx')));
    assert.deepStrictEqual(orders.filter((d) => d.source === 'API Shadow').map((d) => d.message), ['No route matches GET /api/order (fetch, Orders.tsx:9).']);
  });

  it('shows callers and the request flow of an endpoint', async function () {
    const create = api.getResult()!.endpoints.find((e) => e.method === 'POST' && e.path === '/api/v1/users')!;
    assert.deepStrictEqual(create.usage, { calls: 1, tests: 0 });
    const callers = await vscode.commands.executeCommand<{ location: { file: string } }[]>('apiShadow.showCallers', create);
    assert.ok(callers?.length === 1 && callers[0].location.file.endsWith('client.ts'));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('apiShadow.showFlow', create);
    // The tab model is updated asynchronously after the panel is created.
    let tabs: string[] = [];
    for (let i = 0; i < 50 && !tabs.includes('Flow: POST /api/v1/users'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
    }
    assert.ok(tabs.includes('Flow: POST /api/v1/users'), JSON.stringify(tabs));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('compares the API with a git revision', async function () {
    const root = workspaceRoot();
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const git = (...args: string[]): void => void execFileSync('git', args, { cwd: root, env });
    fs.rmSync(path.join(root, '.git'), { recursive: true, force: true });
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    const health = path.join(root, 'express-app', 'src', 'routes', 'health.js');
    const original = fs.readFileSync(health, 'utf8');
    try {
      fs.writeFileSync(health, original.replace("app.get('/health/ready'", "app.get('/health/live', (req, res) => res.end());\n  app.get('/health/ready'"));
      await waitForResult(api, (r) => r.endpoints.some((e) => e.path === '/health/live'));
      const diff = await vscode.commands.executeCommand<{ added: { path: string }[]; removed: unknown[]; breaking: number }>('apiShadow.compareWithRef', 'main');
      assert.deepStrictEqual(diff?.added.map((e) => e.path), ['/health/live']);
      assert.strictEqual(diff?.removed.length, 0);
      assert.strictEqual(diff?.breaking, 0);
    } finally {
      fs.writeFileSync(health, original);
      fs.rmSync(path.join(root, '.git'), { recursive: true, force: true });
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
    await waitForResult(api, (r) => !r.endpoints.some((e) => e.path === '/health/live'));
  });

  it('lists analysis limitations', function () {
    const issues = api.getResult()!.issues;
    assert.ok(issues.some((i) => i.kind === 'parse-error'));
    assert.ok(issues.some((i) => /Kotlin/.test(i.message)));
  });
});
