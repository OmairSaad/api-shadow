import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ApiShadowApi } from '../../src/extension';
import type { AnalysisResult } from '../../src/core/types';

const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as {
  publisher: string;
  name: string;
  contributes: { commands: { command: string }[] };
};
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;

function root(): string {
  return vscode.workspace.workspaceFolders![0].uri.fsPath;
}

function waitFor(api: ApiShadowApi, predicate: (r: AnalysisResult) => boolean, timeoutMs = 20000): Promise<AnalysisResult> {
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

async function until<T>(fn: () => T | undefined, timeoutMs = 15000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Replaces a `vscode.window` function for the duration of `body`. */
async function stubbed<T>(name: 'showInformationMessage' | 'showWarningMessage', answer: string | undefined, body: () => Thenable<T>): Promise<{ value: T; calls: unknown[][] }> {
  const win = vscode.window as unknown as Record<string, unknown>;
  const original = win[name];
  const calls: unknown[][] = [];
  win[name] = (...args: unknown[]) => {
    calls.push(args);
    return Promise.resolve(answer);
  };
  try {
    return { value: await body(), calls };
  } finally {
    win[name] = original;
  }
}

describe('API Shadow intelligence features (Extension Development Host)', function () {
  let api: ApiShadowApi;
  const created: string[] = [];

  before(async function () {
    const ext = vscode.extensions.getExtension<ApiShadowApi>(EXTENSION_ID)!;
    api = await ext.activate();
    await waitFor(api, (r) => r.endpoints.length > 0);
    await api.whenIdle();
  });

  after(async function () {
    for (const f of created) fs.rmSync(f, { recursive: true, force: true });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('registers every contributed command', async function () {
    const commands = new Set(await vscode.commands.getCommands(true));
    const missing = manifest.contributes.commands.map((c) => c.command).filter((c) => !commands.has(c));
    assert.deepStrictEqual(missing, []);
  });

  it('runs the Security Radar on the workspace without leaking secret values', async function () {
    const result = api.getResult()!;
    const secret = result.security.find((f) => f.rule === 'hardcoded-secret' && f.location.file.endsWith('application.properties'));
    assert.ok(secret, JSON.stringify(result.security.map((f) => f.rule)));
    assert.ok(!JSON.stringify(result.security).includes('SUPER_SECRET_DO_NOT_LEAK'));
    const findings = await vscode.commands.executeCommand<unknown[]>('apiShadow.runSecurityAnalysis');
    assert.ok(Array.isArray(findings));
  });

  it('opens the dashboard as a webview', async function () {
    await vscode.commands.executeCommand('apiShadow.showDashboard', 'overview');
    const tab = await until(() => vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('apiShadow.dashboard')));
    assert.strictEqual(tab.label, 'API Shadow');
    await vscode.commands.executeCommand('apiShadow.showGraph');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  it('reports a read of a missing response field and offers a quick fix', async function () {
    const file = path.join(root(), 'web-app', 'src', 'readiness.ts');
    created.push(file);
    fs.writeFileSync(file, `export async function readiness() {\n  const d = await (await fetch('/health/ready')).json();\n  return d.read;\n}\n`);
    await waitFor(api, (r) => r.issues.some((i) => i.kind === 'response-mismatch' && i.location?.file === file));
    const uri = vscode.Uri.file(file);
    const diag = await until(() => vscode.languages.getDiagnostics(uri).find((d) => d.code === 'response-field-missing'));
    assert.match(diag.message, /`read` is read in readiness, but GET \/health\/ready responds with \{ ready \}/);
    const doc = await vscode.workspace.openTextDocument(uri);
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', uri, diag.range);
    const fix = actions.find((a) => a.title === 'Replace `read` with `ready`');
    assert.ok(fix?.edit, actions.map((a) => a.title).join(', '));
    await vscode.workspace.applyEdit(fix.edit);
    assert.strictEqual(doc.lineAt(2).text, '  return d.ready;');
    await doc.save();
    await waitFor(api, (r) => !r.issues.some((i) => i.kind === 'response-mismatch' && i.location?.file === file));
  });

  it('analyzes the impact of a changed response against the session baseline', async function () {
    const health = path.join(root(), 'express-app', 'src', 'routes', 'health.js');
    const reader = path.join(root(), 'web-app', 'src', 'ready-check.ts');
    created.push(reader);
    fs.writeFileSync(reader, `export async function readyCheck() {\n  const d = await (await fetch('/health/ready')).json();\n  return d.ready;\n}\n`);
    await waitFor(api, (r) => r.clientCalls.some((c) => c.location.file === reader));
    await vscode.commands.executeCommand('apiShadow.analyzeImpact');
    const original = fs.readFileSync(health, 'utf8');
    try {
      fs.writeFileSync(health, original.replace('res.json({ ready: true })', 'res.json({ isReady: true })'));
      const report = await until(() => {
        const r = api.getImpactReport();
        return r?.endpoints.some((e) => e.path === '/health/ready') ? r : undefined;
      }, 20000);
      const e = report.endpoints.find((x) => x.path === '/health/ready')!;
      assert.strictEqual(e.risk, 'high');
      assert.match(e.changes[0].text, /`ready` renamed to `isReady`/);
      // readiness.ts (fixed to read `ready` by the previous test) is affected as well.
      assert.deepStrictEqual(e.changes[0].reads.map((r) => path.basename(r.location.file)).sort(), ['readiness.ts', 'ready-check.ts']);
      const diag = await until(() => vscode.languages.getDiagnostics(vscode.Uri.file(reader)).find((d) => d.code === 'breaking-change'));
      assert.match(diag.message, /Potential breaking change since .*: GET \/health\/ready/);
    } finally {
      fs.writeFileSync(health, original);
    }
    await until(() => (api.getImpactReport()?.endpoints.some((x) => x.path === '/health/ready') ? undefined : true), 20000);
  });

  it('generates tests only after confirmation and never overwrites files', async function () {
    const endpoint = api.getResult()!.endpoints.find((e) => e.framework === 'express' && e.method === 'GET' && e.path === '/health')!;
    // The fixture has a test/ folder, so generated files go there.
    const target = path.join(root(), 'express-app', 'test', 'health.api.test.js');
    created.push(target, path.join(root(), 'express-app', 'test', 'health.api.2.test.js'));
    const declined = await stubbed('showInformationMessage', undefined, () => vscode.commands.executeCommand<vscode.Uri[]>('apiShadow.generateTests', [endpoint.id]));
    assert.deepStrictEqual(declined.value, []);
    assert.strictEqual(fs.existsSync(target), false, 'nothing is written without confirmation');
    assert.ok(declined.calls.some((c) => c[0] === 'Create 1 test file(s)?'));

    const accepted = await stubbed('showInformationMessage', 'Create', () => vscode.commands.executeCommand<vscode.Uri[]>('apiShadow.generateTests', [endpoint.id]));
    assert.deepStrictEqual(accepted.value.map((u) => u.fsPath), [target]);
    const content = fs.readFileSync(target, 'utf8');
    assert.match(content, /request\(app\)\.get\('\/health'\)/);
    fs.writeFileSync(target, '// edited by the user\n');

    const again = await stubbed('showInformationMessage', 'Create', () => vscode.commands.executeCommand<vscode.Uri[]>('apiShadow.generateTests', [endpoint.id]));
    assert.deepStrictEqual(again.value.map((u) => path.basename(u.fsPath)), ['health.api.2.test.js']);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '// edited by the user\n');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('compares an OpenAPI contract with the implementation', async function () {
    const spec = path.join(root(), 'express-app', 'openapi.yaml');
    created.push(spec);
    fs.writeFileSync(spec, 'openapi: 3.0.3\ninfo: { title: Express fixture, version: "1" }\npaths:\n  /health:\n    get:\n      responses: { "200": { description: ok } }\n  /not-implemented:\n    get:\n      responses: { "200": { description: ok } }\n');
    const diff = await vscode.commands.executeCommand<{ counts: Record<string, number>; changes: { display: string; severity: string }[] }>('apiShadow.compareContracts', vscode.Uri.file(spec), 'implementation');
    assert.ok(diff);
    assert.ok(diff.changes.some((c) => c.display === 'GET /not-implemented' && c.severity === 'breaking'));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('turns a security rule off only after confirmation, and back on', async function () {
    const config = (): string[] => vscode.workspace.getConfiguration('apiShadow').get<string[]>('security.disabledRules', []);
    await stubbed('showWarningMessage', undefined, () => vscode.commands.executeCommand('apiShadow.disableSecurityRule', 'hardcoded-secret'));
    assert.deepStrictEqual(config(), []);
    await stubbed('showWarningMessage', 'Turn Off', () => vscode.commands.executeCommand('apiShadow.disableSecurityRule', 'hardcoded-secret'));
    assert.deepStrictEqual(config(), ['hardcoded-secret']);
    await waitFor(api, (r) => !r.security.some((f) => f.rule === 'hardcoded-secret'));
    await vscode.commands.executeCommand('apiShadow.enableSecurityRule', 'hardcoded-secret');
    await waitFor(api, (r) => r.security.some((f) => f.rule === 'hardcoded-secret'));
    await vscode.workspace.getConfiguration('apiShadow').update('security.disabledRules', undefined, vscode.ConfigurationTarget.Workspace);
  });

  it('dismisses findings from the Problems panel', async function () {
    await vscode.workspace.getConfiguration('apiShadow').update('diagnostics.security', 'low', vscode.ConfigurationTarget.Workspace);
    try {
      const props = vscode.Uri.file(api.getResult()!.security.find((f) => f.rule === 'hardcoded-secret')!.location.file);
      const diag = await until(() => vscode.languages.getDiagnostics(props).find((d) => d.code === 'security/hardcoded-secret'));
      const id = api.getResult()!.security.find((f) => f.rule === 'hardcoded-secret')!.id;
      await vscode.commands.executeCommand('apiShadow.dismissFinding', id);
      await until(() => (vscode.languages.getDiagnostics(props).some((d) => d.message === diag.message) ? undefined : true));
      await vscode.commands.executeCommand('apiShadow.restoreDismissedFindings');
      await until(() => vscode.languages.getDiagnostics(props).find((d) => d.code === 'security/hardcoded-secret'));
    } finally {
      await vscode.workspace.getConfiguration('apiShadow').update('diagnostics.security', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  it('discovers Laravel routes, opens their controllers and shows CodeLens in routes/api.php', async function () {
    const result = api.getResult()!;
    const show = result.endpoints.find((e) => e.framework === 'laravel' && e.method === 'GET' && e.path === '/api/articles/{article}');
    assert.ok(show, result.endpoints.filter((e) => e.framework === 'laravel').map((e) => `${e.method} ${e.path}`).join('\n'));
    assert.strictEqual(path.basename(show.handlerLocation!.file), 'ArticleController.php');
    assert.strictEqual(result.endpoints.find((e) => e.framework === 'laravel' && e.method === 'POST' && e.path === '/api/logout')?.auth?.status, 'protected');
    const routesFile = vscode.Uri.file(path.join(root(), 'laravel-app', 'routes', 'api.php'));
    await vscode.window.showTextDocument(routesFile);
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', routesFile);
    assert.ok(lenses.some((l) => l.command?.title.includes('GET /api/articles/{article}')), lenses.map((l) => l.command?.title).join('\n'));
  });

  it('generates PHPUnit feature tests for a Laravel controller', async function () {
    const ids = api.getResult()!.endpoints.filter((e) => e.framework === 'laravel' && e.controller === 'EventController').map((e) => e.id);
    const target = path.join(root(), 'laravel-app', 'tests', 'Feature', 'EventControllerApiTest.php');
    created.push(target);
    const accepted = await stubbed('showInformationMessage', 'Create', () => vscode.commands.executeCommand<vscode.Uri[]>('apiShadow.generateTests', ids));
    assert.deepStrictEqual(accepted.value.map((u) => u.fsPath), [target]);
    const content = fs.readFileSync(target, 'utf8');
    assert.match(content, /class EventControllerApiTest extends TestCase/);
    assert.match(content, /\$this->getJson\('\/api\/events'\)/);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('lists where an endpoint is mounted in the sidebar, and opens it on click', async function () {
    await vscode.commands.executeCommand('apiShadow.groupBy', 'none');
    try {
      const node = api.getTreeChildren().find((n) => n.type === 'endpoint' && (n.endpoint.trace?.length ?? 0) > 0 && n.endpoint.framework === 'express');
      assert.ok(node && node.type === 'endpoint', 'an Express endpoint with a mount');
      const step = node.endpoint.trace![0];
      const row = api.getTreeChildren(node).find((d) => d.type === 'detail' && d.label === step.text);
      assert.ok(row, api.getTreeChildren(node).map((d) => (d.type === 'detail' ? d.label : '')).join('\n'));
      const item = api.getTreeItem(row);
      assert.strictEqual(item.command?.command, 'apiShadow.openLocation');
      await vscode.commands.executeCommand(item.command!.command, ...(item.command!.arguments ?? []));
      assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, step.location!.file);
      assert.strictEqual(vscode.window.activeTextEditor?.selection.active.line, step.location!.line - 1);
    } finally {
      await vscode.commands.executeCommand('apiShadow.groupBy', 'controller');
    }
  });

  it('exports the analysis report and the dependency graph', async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-shadow-report-'));
    const report = vscode.Uri.file(path.join(dir, 'report.md'));
    const graph = vscode.Uri.file(path.join(dir, 'graph.md'));
    await vscode.commands.executeCommand('apiShadow.exportReport', report);
    await vscode.commands.executeCommand('apiShadow.exportGraph', graph, 'mermaid');
    const md = fs.readFileSync(report.fsPath, 'utf8');
    assert.match(md, /## Overview/);
    assert.match(md, /## Endpoint inventory/);
    assert.ok(!md.includes('SUPER_SECRET_DO_NOT_LEAK'));
    assert.match(fs.readFileSync(graph.fsPath, 'utf8'), /```mermaid\nflowchart LR/);
  });
});
