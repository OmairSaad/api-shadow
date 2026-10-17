import * as assert from 'assert';
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
    for (const id of ['refresh', 'search', 'filter', 'filterByMethod', 'clearFilter', 'groupBy', 'exportMarkdown', 'exportOpenApi', 'clearCache', 'showLog', 'openLocation', 'openHandler', 'copyPath']) {
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

  it('lists analysis limitations', function () {
    const issues = api.getResult()!.issues;
    assert.ok(issues.some((i) => i.kind === 'parse-error'));
    assert.ok(issues.some((i) => /Kotlin/.test(i.message)));
  });
});
