import { expect, test, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { launchVSCode, runCommand, waitForQuickInput, type VSCodeSession } from './vscode';

let session: VSCodeSession;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  session = await launchVSCode();
  page = session.page;
});

test.afterAll(async () => {
  await session?.close();
});

function endpointsTree(): Locator {
  return page.locator('.pane').filter({ has: page.locator('.pane-header', { hasText: /Endpoints/ }) }).locator('.monaco-list[role="tree"]');
}

function endpointRows(): Locator {
  return endpointsTree().locator('.monaco-list-row[aria-level="2"]');
}

/** Narrows the (virtualised) tree so the rows under test are rendered. */
async function filterTo(text: string): Promise<void> {
  await runCommand(page, 'API Shadow: Filter Endpoints by Text');
  await waitForQuickInput(page, 'Filter API Endpoints');
  const input = page.locator('.quick-input-widget input.input');
  await input.fill(text);
  await input.press('Enter');
  await expect(input).toBeHidden();
}

async function clearFilter(): Promise<void> {
  await runCommand(page, 'API Shadow: Clear Filters');
}

async function screenshot(name: string): Promise<void> {
  await page.screenshot({ path: path.join('test-results', 'screenshots', `${name}.png`) });
}

test('opens the API Shadow sidebar from the activity bar and lists endpoints', async () => {
  await page.getByRole('tab', { name: /API Shadow/ }).click();
  await expect(page.getByRole('button', { name: /^Endpoints - \d+ Section/ })).toBeVisible();
  await expect(endpointsTree().getByRole('treeitem', { name: /^admin, 2 endpoints/ })).toBeVisible();
  await expect(endpointsTree().getByRole('treeitem', { name: /^DELETE \/admin\/cache, Express, handler \(anonymous\), admin\.ts:6/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^API Shadow: \d+ endpoint\(s\), 2 potential duplicate/ })).toBeVisible();
  await screenshot('01-sidebar');
  // Spot-check endpoints from the other frameworks.
  await filterTo('users');
  await expect(endpointsTree().getByRole('treeitem', { name: /^UsersController, 5 endpoints/ })).toBeVisible();
  await expect(endpointsTree().getByRole('treeitem', { name: /^POST \/api\/v1\/users, NestJS, handler create/ })).toBeVisible();
  await filterTo('orders spring');
  await expect(endpointsTree().getByRole('treeitem', { name: /^GET \/shop\/api\/orders, Spring/ })).toBeVisible();
  await clearFilter();
});

test('clicking an endpoint navigates to its source line', async () => {
  await filterTo('/api/v1/users');
  await endpointsTree().getByRole('treeitem', { name: /^POST \/api\/v1\/users, NestJS/ }).click();
  await expect(page.locator('.tabs-container .tab.active')).toContainText('users.controller.ts');
  await expect(page.locator('[id="status.editor.selection"]')).toContainText('Ln 22');
  await screenshot('02-navigate');
});

test('expanding an endpoint shows middleware and linked services; service opens its declaration', async () => {
  const row = endpointsTree().getByRole('treeitem', { name: /^GET \/api\/v1\/users\/:id, NestJS/ });
  await row.locator('.monaco-tl-twistie').click();
  await expect(endpointsTree().getByRole('treeitem', { name: /Middleware: UseGuards\(AuthGuard\)/ }).first()).toBeVisible();
  const service = endpointsTree().getByRole('treeitem', { name: /→ UsersService\.findOne/ });
  await expect(service).toBeVisible();
  await service.click();
  await expect(page.locator('.tabs-container .tab.active')).toContainText('users.service.ts');
  await expect(page.locator('[id="status.editor.selection"]')).toContainText('Ln 10');
  await row.locator('.monaco-tl-twistie').click();
  await clearFilter();
});

test('filters by text from the view toolbar', async () => {
  await page.locator('.pane-header', { hasText: 'Endpoints' }).hover();
  await page.getByRole('button', { name: 'Filter Endpoints by Text' }).click();
  await waitForQuickInput(page, 'Filter API Endpoints');
  const input = page.locator('.quick-input-widget input.input');
  await input.fill('orders');
  await input.press('Enter');
  await expect(page.locator('.pane-body .message, .pane-body .tree-explorer-viewlet-tree-view-message').filter({ hasText: /Filtered by text "orders"/ }).first()).toBeVisible();
  await expect
    .poll(async () => {
      const labels = await endpointRows().evaluateAll((rows) => rows.map((r) => r.getAttribute('aria-label') ?? ''));
      return labels.length > 0 && labels.every((l) => l.toLowerCase().includes('orders'));
    })
    .toBe(true);
  await screenshot('03-filter-text');
  await page.locator('.pane-header', { hasText: 'Endpoints' }).hover();
  await page.getByRole('button', { name: 'Clear Filters' }).click();
  await expect(page.locator('.pane-body').filter({ hasText: /Filtered by/ })).toHaveCount(0);
});

test('filters by HTTP method through a multi-select quick pick', async () => {
  await runCommand(page, 'API Shadow: Filter by HTTP Method');
  await waitForQuickInput(page, 'Filter by HTTP Method');
  const option = page.getByRole('checkbox', { name: /^DELETE, \d+ endpoint/ });
  await option.click();
  await expect(option).toBeChecked();
  await page.locator('.quick-input-widget input.input').press('Enter');
  await expect(page.locator('.quick-input-widget')).toBeHidden();
  const rowLabels = () => endpointRows().evaluateAll((rows) => rows.map((r) => r.getAttribute('aria-label') ?? ''));
  await expect.poll(async () => (await rowLabels()).every((l) => l.startsWith('DELETE ')) && (await rowLabels()).length > 2).toBe(true);
  await expect(page.locator('.pane-body').filter({ hasText: /Filtered by methods DELETE/ }).first()).toBeVisible();
  await screenshot('04-filter-method');
  await runCommand(page, 'API Shadow: Clear Filters');
});

test('groups endpoints by HTTP method', async () => {
  await runCommand(page, 'API Shadow: Group Endpoints By');
  await waitForQuickInput(page, 'Group Endpoints By');
  await page.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'HTTP method' }).click();
  await expect(endpointsTree().getByRole('treeitem', { name: /^GET, \d+ endpoints/ })).toBeVisible();
  await page.locator('.pane-header', { hasText: 'Endpoints' }).hover();
  await page.getByRole('button', { name: 'Collapse All' }).first().click();
  for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ALL']) {
    await expect(endpointsTree().getByRole('treeitem', { name: new RegExp(`^${m}, \\d+ endpoints`) })).toBeVisible();
  }
  await screenshot('05-group-method');
  await runCommand(page, 'API Shadow: Group Endpoints By');
  await waitForQuickInput(page, 'Group Endpoints By');
  await page.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'Controller / router file' }).click();
  await expect(endpointsTree().getByRole('treeitem', { name: /^admin, 2 endpoints/ })).toBeVisible();
  await expect(endpointsTree().getByRole('treeitem', { name: /^GET, \d+ endpoints/ })).toHaveCount(0);
});

test('search quick pick jumps to the selected endpoint', async () => {
  await runCommand(page, 'API Shadow: Search Endpoints');
  await waitForQuickInput(page, 'Search API Endpoints');
  const input = page.locator('.quick-input-widget input.input');
  await input.fill('orderId');
  await expect(page.locator('.quick-input-list .monaco-list-row').first()).toContainText('/shop/api/orders/{orderId}');
  await page.keyboard.press('Enter');
  await expect(page.locator('.tabs-container .tab.active')).toContainText('OrdersApi.java');
  await screenshot('06-search');
});

test('tree is keyboard accessible', async () => {
  await filterTo('health');
  // Clicking previews the source but keeps focus in the tree, like the Explorer.
  await endpointsTree().getByRole('treeitem', { name: /^GET \/health\/ready, Express/ }).click();
  await expect(page.locator('.tabs-container .tab.active')).toContainText('health.js');
  await page.keyboard.press('ArrowDown'); // HealthController group
  await page.keyboard.press('ArrowDown'); // GET /health (NestJS)
  await expect(endpointsTree().locator('.monaco-list-row.focused')).toHaveAttribute('aria-label', /^GET \/health, NestJS, handler check/);
  await page.keyboard.press('Enter');
  await expect(page.locator('.tabs-container .tab.active')).toContainText('health.controller.ts');
  await expect(page.locator('[id="status.editor.selection"]')).toContainText('Ln 5');
  await clearFilter();
});

test('issues view lists duplicates, parse errors and limitations', async () => {
  const header = page.getByRole('button', { name: /^Issues - \d+ Section/ });
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  const issues = page.locator('.pane').filter({ has: page.locator('.pane-header', { hasText: /Issues/ }) });
  await expect(issues.getByRole('treeitem', { name: /Potential duplicate routes, \d+/ })).toBeVisible();
  await expect(issues.getByRole('treeitem', { name: /Parse errors, \d+/ })).toBeVisible();
  const dup = issues.getByRole('treeitem', { name: /warning: Potential duplicate route GET \/users\/\{\}/ });
  await expect(dup).toBeVisible();
  await dup.click();
  await expect(page.locator('.tabs-container .tab.active')).toContainText('users.js');
  await screenshot('07-issues');
});

test('duplicate routes appear in the Problems panel', async () => {
  await runCommand(page, 'View: Toggle Problems');
  // Fixture files have unrelated TypeScript errors (no node_modules); narrow to our diagnostics.
  const filter = page.getByRole('textbox', { name: 'Filter Problems' });
  await filter.fill('duplicate route');
  const problems = page.getByRole('tree', { name: /Showing \d+ of \d+ problems|Showing \d+ problems/ });
  await expect(problems.getByRole('treeitem', { name: /Potential duplicate route GET \/users\/:id/ }).first()).toBeVisible();
  await expect(problems.getByRole('treeitem', { name: /Potential duplicate route GET \/shop\/api\/v1\/products/ }).first()).toBeVisible();
  await screenshot('08-problems');
  await filter.fill('');
  await runCommand(page, 'View: Toggle Problems');
});

test('exports Markdown through the save dialog', async () => {
  const target = path.join(session.workspace, 'exported-api.md');
  await runCommand(page, 'API Shadow: Export Endpoints to Markdown');
  await waitForQuickInput(page, /Export API Endpoints/);
  const input = page.locator('.quick-input-widget input.input');
  await input.waitFor({ state: 'visible' });
  await input.fill(target);
  await input.press('Enter');
  await expect(page.locator('.notifications-toasts').getByText(/exported exported-api\.md/)).toBeVisible();
  await expect.poll(() => fs.existsSync(target)).toBe(true);
  const md = fs.readFileSync(target, 'utf8');
  expect(md).toContain('| POST | `/api/v1/users` |');
  await screenshot('09-export');
});

test('updates the sidebar when a route file changes on disk', async () => {
  const file = path.join(session.workspace, 'express-app', 'src', 'routes', 'admin.ts');
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original + "\nadminRouter.patch('/flags', (_req, res) => res.end());\n");
  await expect(endpointsTree().getByRole('treeitem', { name: /^PATCH \/admin\/flags, Express/ })).toBeVisible();
  fs.writeFileSync(file, original);
  await expect(endpointsTree().getByRole('treeitem', { name: /^PATCH \/admin\/flags/ })).toHaveCount(0);
});
