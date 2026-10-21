import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { launchVSCode, runCommand, type VSCodeSession } from './vscode';

let session: VSCodeSession;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  session = await launchVSCode({
    windowSize: { width: 1500, height: 950 },
    prepareWorkspace: (ws) => {
      // A component that reads the health response, so the graph and explorer show consumers.
      fs.writeFileSync(path.join(ws, 'web-app', 'src', 'pages', 'Status.tsx'), `export async function Status() {\n  const d = await (await fetch('/health/ready')).json();\n  return d.ready ? 'up' : 'down';\n}\n`);
    },
  });
  page = session.page;
});

test.afterAll(async () => {
  await session?.close();
});

/** The dashboard's content frame (VS Code nests webviews in two iframes). */
function dashboard(): FrameLocator {
  return page.frameLocator('iframe.webview.ready').frameLocator('#active-frame');
}

async function screenshot(name: string): Promise<void> {
  await page.screenshot({ path: path.join('test-results', 'screenshots', `${name}.png`) });
}

test('opens the dashboard with an overview of the analysis', async () => {
  await runCommand(page, 'API Shadow: Open Dashboard');
  const d = dashboard();
  await expect(d.getByRole('heading', { name: /^API Shadow · workspace/ })).toBeVisible();
  await expect(d.getByRole('tab', { name: /Overview/ })).toHaveAttribute('aria-selected', 'true');
  await expect(d.getByRole('button', { name: /^Endpoints: \d+/ })).toBeVisible();
  await expect(d.getByRole('button', { name: /^Unmatched frontend requests: 1/ })).toBeVisible();
  await expect(d.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  await screenshot('dashboard-overview');
});

test('switches tabs with the keyboard', async () => {
  const d = dashboard();
  await d.getByRole('tab', { name: /Overview/ }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(d.getByRole('tab', { name: /API Explorer/ })).toHaveAttribute('aria-selected', 'true');
  await expect(d.getByRole('tab', { name: /API Explorer/ })).toBeFocused();
});

test('explores endpoints with search and shows details with callers', async () => {
  const d = dashboard();
  await d.getByRole('tab', { name: /API Explorer/ }).click();
  await d.getByRole('searchbox', { name: 'Search endpoints' }).fill('health ready');
  await expect(d.getByRole('status').filter({ hasText: /endpoint\(s\)/ })).toHaveText(/^1 of \d+ endpoint\(s\)$/);
  await d.locator('table.grid tbody tr').first().click();
  const details = d.getByRole('complementary', { name: 'Endpoint details' });
  await expect(details.getByRole('heading', { name: /GET \/health\/ready/ })).toBeVisible();
  await expect(details.getByText('{ ready }')).toBeVisible();
  await expect(details.getByRole('heading', { name: 'Frontend callers (1)' })).toBeVisible();
  await expect(details.getByText('reads ready')).toBeVisible();
  await screenshot('dashboard-explorer');
  await d.getByRole('button', { name: /Frontend requests/ }).click();
  await expect(d.locator('table.grid')).toContainText('/api/order');
  await expect(d.locator('table.grid')).toContainText('unmatched');
});

test('lists security findings and dismisses one', async () => {
  const d = dashboard();
  await d.getByRole('tab', { name: /Security/ }).click();
  await expect(d.getByRole('heading', { name: /^High \(\d+\)$/ })).toBeVisible();
  const secret = d.locator('article.finding').filter({ hasText: 'Possible hardcoded credential' }).first();
  await expect(secret).toContainText('spring.datasource.password');
  await expect(secret).not.toContainText('SUPER_SECRET');
  await screenshot('dashboard-security');
  await secret.getByRole('button', { name: 'Dismiss' }).click();
  await expect(d.locator('article.finding').filter({ hasText: 'spring.datasource.password' })).toHaveCount(0);
  await d.getByRole('checkbox').check();
  await d.locator('article.finding').filter({ hasText: 'spring.datasource.password' }).getByRole('button', { name: 'Restore' }).click();
  await d.getByRole('checkbox').uncheck();
  await expect(d.locator('article.finding').filter({ hasText: 'spring.datasource.password' })).toHaveCount(1);
});

test('draws the dependency graph and highlights a node', async () => {
  const d = dashboard();
  await d.getByRole('tab', { name: /Dependency Graph/ }).click();
  const graph = d.getByRole('application', { name: /API dependency graph/ });
  await expect(graph).toBeVisible();
  const endpoint = graph.getByRole('button', { name: 'endpoint: GET /health/ready' });
  await expect(endpoint).toBeAttached();
  await endpoint.focus();
  await page.keyboard.press('Enter');
  const details = d.getByRole('complementary', { name: 'Node details' });
  await expect(details.getByRole('heading', { name: /GET \/health\/ready/ })).toBeVisible();
  await expect(details.getByRole('heading', { name: /Used by \(1\)/ })).toBeVisible();
  await expect(graph.locator('.node.dim').first()).toBeAttached();
  await screenshot('dashboard-graph');
  // Open the source of the selected node.
  await graph.getByRole('button', { name: 'endpoint: GET /health/ready' }).press('o');
  await expect(page.getByRole('tab', { name: /health\.js/ })).toBeVisible();
});

test('shows impact, contracts and the test generator', async () => {
  await runCommand(page, 'API Shadow: Analyze Change Impact');
  const d = dashboard();
  await expect(d.getByRole('tab', { name: /Impact Analysis/ })).toHaveAttribute('aria-selected', 'true');
  await expect(d.getByText(/No endpoint changes since/)).toBeVisible();
  await d.getByRole('tab', { name: /Contracts/ }).click();
  await expect(d.getByRole('heading', { name: 'OpenAPI documents' })).toBeVisible();
  await d.getByRole('tab', { name: /Test Generator/ }).click();
  await expect(d.getByRole('heading', { name: 'Detected test setup' })).toBeVisible();
  await expect(d.getByRole('button', { name: 'Preview and create…' })).toBeDisabled();
  await d.getByRole('group', { name: 'Endpoints to generate tests for' }).getByRole('checkbox').first().check();
  await expect(d.getByRole('button', { name: 'Preview and create…' })).toBeEnabled();
  await screenshot('dashboard-tests');
});

test('shows the impact of a response change on the frontend', async () => {
  const health = path.join(session.workspace, 'express-app', 'src', 'routes', 'health.js');
  fs.writeFileSync(health, fs.readFileSync(health, 'utf8').replace('res.json({ ready: true })', 'res.json({ isReady: true })'));
  const d = dashboard();
  await d.getByRole('tab', { name: /Impact Analysis/ }).click();
  const card = d.locator('article.impact').filter({ hasText: '/health/ready' });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText('HIGH');
  await expect(card).toContainText('Response field ready renamed to isReady');
  await expect(card.locator('code', { hasText: 'isReady' }).first()).toBeVisible();
  await expect(card).toContainText('reads ready in Status');
  await expect(card).toContainText('Suggested fix: use isReady instead of ready');
  await screenshot('dashboard-impact');
});
