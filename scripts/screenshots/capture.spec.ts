/**
 * Produces the images shown on the Marketplace details page (media/*.png, media/demo.gif).
 *
 * VS Code is launched with the packaged VSIX installed (no development banner), a demo copy of the
 * fixture workspace, and settings that keep the UI free of unrelated noise. Screenshots are taken
 * at 2x device scale and downscaled with ImageMagick for crisp text; the demo is recorded through
 * the Chrome DevTools screencast as lossless PNG frames and encoded with ffmpeg.
 */
import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchVSCode, runCommand, waitForQuickInput, type VSCodeSession } from '../../test/e2e/vscode';

const ROOT = path.resolve(__dirname, '../..');
const MEDIA = path.join(ROOT, 'media');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { name: string; version: string };
const VSIX = path.join(ROOT, `${manifest.name}-${manifest.version}.vsix`);
// The capture machine's screen is 1920x1080; at 1.6x the maximised window is ~1200x655 CSS px,
// i.e. a comfortable layout rendered with 1920 physical pixels across.
const DEVICE_SCALE = 1.6;
const SIDEBAR_WIDTH = 440;
const OUTPUT_WIDTH = 1600;

const SETTINGS: Record<string, unknown> = {
  'workbench.colorTheme': 'Default Dark Modern',
  'workbench.view.alwaysShowHeaderActions': true,
  'workbench.layoutControl.enabled': false,
  'workbench.tree.renderIndentGuides': 'always',
  'workbench.list.smoothScrolling': false,
  'editor.minimap.enabled': false,
  'editor.cursorBlinking': 'solid',
  'editor.stickyScroll.enabled': false,
  'editor.lightbulb.enabled': 'off',
  'editor.occurrencesHighlight': 'off',
  'editor.selectionHighlight': false,
  'editor.guides.bracketPairs': false,
  // The demo projects have no node_modules; keep TypeScript squiggles out of the pictures.
  'typescript.validate.enable': false,
  'javascript.validate.enable': false,
  'git.enabled': false,
  'markdown.preview.fontSize': 13,
};

/** The fixtures contain deliberately broken files for tests; the demo workspace leaves them out. */
function prepareDemoWorkspace(workspace: string): void {
  fs.rmSync(path.join(workspace, 'express-app/src/routes/broken.js'), { force: true });
  fs.rmSync(path.join(workspace, 'spring-app/src/main/java/com/example/shop/controller/BrokenController.java'), { force: true });
  fs.rmSync(path.join(workspace, 'express-app/node_modules'), { recursive: true, force: true });
}

async function launch(deviceScaleFactor: number): Promise<VSCodeSession> {
  if (!fs.existsSync(VSIX)) throw new Error(`${VSIX} not found. Run \`npm run package\` first (npm run screenshots does this).`);
  return launchVSCode({
    vsix: VSIX,
    workspaceName: 'shop-platform',
    prepareWorkspace: prepareDemoWorkspace,
    settings: SETTINGS,
    windowSize: 'maximized',
    deviceScaleFactor,
  });
}

// ---------------------------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------------------------

function endpointsTree(page: Page): Locator {
  return page.locator('.pane').filter({ has: page.locator('.pane-header', { hasText: /Endpoints/ }) }).locator('.monaco-list[role="tree"]');
}

function endpoint(page: Page, name: RegExp): Locator {
  return endpointsTree(page).getByRole('treeitem', { name });
}

function viewAction(page: Page, name: string): Locator {
  return page.locator('.pane-header', { hasText: 'Endpoints' }).getByRole('button', { name, exact: true });
}

async function setPaneExpanded(page: Page, title: 'Endpoints' | 'Issues', expanded: boolean): Promise<void> {
  const header = page.getByRole('button', { name: new RegExp(`^${title}\\b.*Section`) });
  if (((await header.getAttribute('aria-expanded')) === 'true') !== expanded) {
    await header.click({ position: { x: 40, y: 10 } });
  }
  await expect(header).toHaveAttribute('aria-expanded', String(expanded));
}

async function expandRow(row: Locator): Promise<void> {
  if ((await row.getAttribute('aria-expanded')) === 'false') await row.locator('.monaco-tl-twistie').click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

async function expandAllGroups(page: Page): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const collapsed = endpointsTree(page).locator('.monaco-list-row[aria-level="1"][aria-expanded="false"]').first();
    if ((await collapsed.count()) === 0) return;
    await collapsed.locator('.monaco-tl-twistie').click();
  }
}

/** Drags the sash between the side bar and the editor so labels are not truncated. */
async function setSidebarWidth(page: Page, width: number): Promise<void> {
  const sidebar = await page.locator('.part.sidebar').boundingBox();
  if (!sidebar) throw new Error('side bar not visible');
  const edge = sidebar.x + sidebar.width;
  const sashes = await page.locator('.monaco-sash.vertical').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, h: r.height };
    }),
  );
  const sash = sashes.filter((s) => s.h > 100).sort((a, b) => Math.abs(a.x - edge) - Math.abs(b.x - edge))[0];
  if (!sash || Math.abs(sash.x - edge) > 6) throw new Error('side bar sash not found');
  await page.mouse.move(sash.x, sash.y);
  await page.mouse.down();
  await page.mouse.move(sidebar.x + width, sash.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await page.locator('.part.sidebar').boundingBox())!.width)).toBeGreaterThan(width - 40);
}

async function openApiShadow(page: Page): Promise<void> {
  await page.getByRole('tab', { name: /API Shadow/ }).click();
  await expect(endpoint(page, /^admin, 2 endpoints/)).toBeVisible();
  await setSidebarWidth(page, SIDEBAR_WIDTH);
  await setPaneExpanded(page, 'Issues', false);
}

async function activeTab(page: Page, text: string): Promise<void> {
  await expect(page.locator('.tabs-container .tab.active')).toContainText(text);
}

const RAW = fs.mkdtempSync(path.join(os.tmpdir(), 'api-shadow-shots-'));

async function viewport(page: Page): Promise<{ width: number; height: number }> {
  return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
}

async function shot(page: Page, name: string): Promise<void> {
  // Park the pointer on the empty part of the activity bar so no hover tooltip is visible.
  await page.mouse.move(24, (await viewport(page)).height - 160);
  await page.waitForTimeout(600);
  const raw = path.join(RAW, `${name}.png`);
  await page.screenshot({ path: raw });
  fs.mkdirSync(MEDIA, { recursive: true });
  execFileSync('convert', [raw, '-filter', 'Lanczos', '-resize', `${OUTPUT_WIDTH}x`, '-strip', '-define', 'png:compression-level=9', path.join(MEDIA, `${name}.png`)]);
}

// ---------------------------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------------------------

test.describe.configure({ mode: 'serial' });

test('marketplace screenshots', async () => {
  const session = await launch(DEVICE_SCALE);
  const { page } = session;
  try {
    await openApiShadow(page);

    // 1. Overview: NestJS controller endpoint with guards, service link, body type and prefixes.
    await viewAction(page, 'Collapse All').click();
    await expandRow(endpoint(page, /^UsersController, 5 endpoints/));
    const create = endpoint(page, /^POST \/api\/v1\/users, NestJS/);
    await create.click();
    await activeTab(page, 'users.controller.ts');
    await expandRow(create);
    await expect(endpoint(page, /→ UsersService\.create/)).toBeVisible();
    // Show the file from the top (decorators included); line 22 stays in view.
    const editor = (await page.locator('.editor-group-container .monaco-editor .view-lines').first().boundingBox())!;
    await page.mouse.move(editor.x + editor.width / 2, editor.y + editor.height / 2);
    await page.mouse.wheel(0, -3000);
    await shot(page, 'overview');

    // 2. Express: nested routers, middleware chain, controller module and service, duplicate warning.
    await viewAction(page, 'Collapse All').click();
    await expandRow(endpoint(page, /^userController, \d+ endpoints/));
    const getUser = endpoint(page, /^GET \/users\/:id, Express/);
    await getUser.click();
    await activeTab(page, 'users.js');
    await expandRow(getUser);
    await expect(endpoint(page, /→ userService\.findById/)).toBeVisible();
    await shot(page, 'express');

    // 3. Spring: constants, context path, security annotation, request body, service.
    await viewAction(page, 'Collapse All').click();
    await expandRow(endpoint(page, /^ProductController, \d+ endpoints/));
    const product = endpoint(page, /^POST \/shop\/api\/v1\/products, Spring/);
    await product.click();
    await activeTab(page, 'ProductController.java');
    await expandRow(product);
    await expect(endpoint(page, /→ ProductService\.create/)).toBeVisible();
    await shot(page, 'spring');

    // 4. Search across all endpoints.
    await runCommand(page, 'API Shadow: Search Endpoints');
    await waitForQuickInput(page, 'Search API Endpoints');
    await page.keyboard.type('users');
    await expect(page.locator('.quick-input-list .monaco-list-row').first()).toContainText('/users');
    await shot(page, 'search');
    await page.keyboard.press('Escape');

    // 5. HTTP method filter: show the picker over the filtered tree.
    await runCommand(page, 'API Shadow: Filter by HTTP Method');
    await waitForQuickInput(page, 'Filter by HTTP Method');
    await page.getByRole('checkbox', { name: /^DELETE, \d+ endpoint/ }).click();
    await page.locator('.quick-input-widget input.input').press('Enter');
    await expect(page.locator('.quick-input-widget')).toBeHidden();
    await expandAllGroups(page);
    await runCommand(page, 'API Shadow: Filter by HTTP Method');
    await waitForQuickInput(page, 'Filter by HTTP Method');
    await expect(page.getByRole('checkbox', { name: /^DELETE, \d+ endpoint/ })).toBeChecked();
    await shot(page, 'filter');
    await page.keyboard.press('Escape');
    await runCommand(page, 'API Shadow: Clear Filters');

    // 6. Issues view and Problems panel.
    await setPaneExpanded(page, 'Endpoints', false);
    await setPaneExpanded(page, 'Issues', true);
    const issues = page.locator('.pane').filter({ has: page.locator('.pane-header', { hasText: /Issues/ }) });
    await expandRow(issues.getByRole('treeitem', { name: /^Analysis limitations, \d+/ }));
    await issues.getByRole('treeitem', { name: /Potential duplicate route GET \/users\/\{\}/ }).click();
    await activeTab(page, 'users.js');
    await runCommand(page, 'View: Toggle Problems');
    await expect(page.getByRole('tree', { name: /problems/i }).getByRole('treeitem', { name: /Potential duplicate route/ }).first()).toBeVisible();
    await shot(page, 'issues');
    await runCommand(page, 'View: Toggle Problems');
    await setPaneExpanded(page, 'Issues', false);
    await setPaneExpanded(page, 'Endpoints', true);

    // 7. Markdown export rendered in the built-in preview.
    const target = path.join(session.workspace, 'API-ENDPOINTS.md');
    await runCommand(page, 'API Shadow: Export Endpoints to Markdown');
    await waitForQuickInput(page, /Export API Endpoints/);
    const input = page.locator('.quick-input-widget input.input');
    await input.fill(target);
    await input.press('Enter');
    await page.locator('.notifications-toasts').getByRole('button', { name: 'Open', exact: true }).click();
    await activeTab(page, 'API-ENDPOINTS.md');
    await runCommand(page, 'Markdown: Open Preview');
    await activeTab(page, 'Preview API-ENDPOINTS.md');
    await page.waitForTimeout(2000);
    await shot(page, 'export');
  } finally {
    await session.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Animated demo
// ---------------------------------------------------------------------------------------------

/** Draws a visible pointer (screencasts do not include the OS cursor) and a ripple on clicks. */
async function installPointer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const ns = 'http://www.w3.org/2000/svg';
    const pointer = document.createElement('div');
    Object.assign(pointer.style, { position: 'fixed', left: '0', top: '0', width: '22px', height: '22px', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-100px, -100px)' });
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '22');
    svg.setAttribute('height', '22');
    svg.setAttribute('viewBox', '0 0 22 22');
    const arrow = document.createElementNS(ns, 'path');
    arrow.setAttribute('d', 'M2 1.5 L2 17.5 L6.2 13.4 L9 19.8 L11.8 18.6 L9.1 12.3 L15 12.3 Z');
    arrow.setAttribute('fill', '#ffffff');
    arrow.setAttribute('stroke', '#111111');
    arrow.setAttribute('stroke-width', '1.3');
    arrow.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(arrow);
    pointer.appendChild(svg);
    document.body.appendChild(pointer);
    let x = -100;
    let y = -100;
    document.addEventListener(
      'mousemove',
      (e) => {
        x = e.clientX;
        y = e.clientY;
        pointer.style.transform = `translate(${x - 2}px, ${y - 1}px)`;
      },
      true,
    );
    document.addEventListener(
      'mousedown',
      () => {
        const ring = document.createElement('div');
        Object.assign(ring.style, { position: 'fixed', left: `${x - 16}px`, top: `${y - 16}px`, width: '32px', height: '32px', borderRadius: '50%', border: '3px solid #4fc1ff', zIndex: '2147483646', pointerEvents: 'none' });
        document.body.appendChild(ring);
        const animation = ring.animate([{ transform: 'scale(0.3)', opacity: 1 }, { transform: 'scale(1.3)', opacity: 0 }], { duration: 500, easing: 'ease-out' });
        animation.onfinish = () => ring.remove();
      },
      true,
    );
  });
}

class Screencast {
  private readonly frames: { file: string; time: number }[] = [];
  private pending: Promise<unknown>[] = [];

  constructor(
    private readonly cdp: CDPSession,
    private readonly dir: string,
  ) {}

  async start(size: { width: number; height: number }): Promise<void> {
    this.cdp.on('Page.screencastFrame', (frame) => {
      const file = path.join(this.dir, `frame-${String(this.frames.length).padStart(5, '0')}.png`);
      fs.writeFileSync(file, Buffer.from(frame.data, 'base64'));
      this.frames.push({ file, time: frame.metadata.timestamp ?? Date.now() / 1000 });
      this.pending.push(this.cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined));
    });
    await this.cdp.send('Page.startScreencast', { format: 'png', maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 });
  }

  async stop(): Promise<void> {
    await this.cdp.send('Page.stopScreencast');
    await Promise.all(this.pending);
  }

  /** Encodes the captured frames, keeping their real timing, into an optimised looping GIF. */
  toGif(out: string, holdLastSeconds: number): void {
    if (this.frames.length < 2) throw new Error('screencast captured no frames');
    const lines: string[] = [];
    this.frames.forEach((f, i) => {
      const next = this.frames[i + 1];
      const duration = next ? Math.max(0.02, next.time - f.time) : holdLastSeconds;
      lines.push(`file '${f.file}'`, `duration ${duration.toFixed(3)}`);
    });
    lines.push(`file '${this.frames[this.frames.length - 1].file}'`);
    const list = path.join(this.dir, 'frames.txt');
    fs.writeFileSync(list, lines.join('\n') + '\n');
    const filters = 'fps=15,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle';
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', filters, '-loop', '0', out]);
  }
}

test('marketplace demo gif', async () => {
  const session = await launch(DEVICE_SCALE);
  const { page } = session;
  const pause = (ms: number) => page.waitForTimeout(ms);
  const glide = async (target: Locator): Promise<{ x: number; y: number }> => {
    await target.waitFor({ state: 'visible' });
    const box = (await target.boundingBox())!;
    const point = { x: box.x + Math.min(box.width / 2, 160), y: box.y + box.height / 2 };
    await page.mouse.move(point.x, point.y, { steps: 22 });
    await pause(180);
    return point;
  };
  const click = async (target: Locator): Promise<void> => {
    const { x, y } = await glide(target);
    await page.mouse.click(x, y);
  };
  try {
    await openApiShadow(page);
    // Start from a realistic state (a file open) rather than an empty editor area.
    await page.keyboard.press('Control+P');
    await page.locator('.quick-input-widget input.input').fill('express-app/src/app.js');
    await page.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'app.js' }).first().waitFor();
    await page.keyboard.press('Enter');
    await activeTab(page, 'app.js');
    await installPointer(page);
    const size = await viewport(page);
    await page.mouse.move(size.width * 0.68, size.height * 0.5);
    const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'api-shadow-gif-'));
    const cast = new Screencast(await page.context().newCDPSession(page), frames);
    await cast.start(size);
    await pause(900);

    // Narrow the tree, jump to code, inspect details and follow the service link.
    await click(viewAction(page, 'Filter Endpoints by Text'));
    await waitForQuickInput(page, 'Filter API Endpoints');
    await page.keyboard.type('users', { delay: 120 });
    await pause(300);
    await page.keyboard.press('Enter');
    await pause(900);
    const create = endpoint(page, /^POST \/api\/v1\/users, NestJS/);
    await click(create);
    await activeTab(page, 'users.controller.ts');
    await pause(1100);
    await click(create.locator('.monaco-tl-twistie'));
    await pause(1300);
    await click(endpoint(page, /→ UsersService\.create/));
    await activeTab(page, 'users.service.ts');
    await pause(1400);
    await click(viewAction(page, 'Clear Filters'));
    await pause(900);

    // Filter by HTTP method across all three frameworks.
    await click(viewAction(page, 'Filter by HTTP Method'));
    await waitForQuickInput(page, 'Filter by HTTP Method');
    await pause(500);
    await click(page.getByRole('checkbox', { name: /^DELETE, \d+ endpoint/ }));
    await pause(500);
    await click(page.locator('.quick-input-widget').getByRole('button', { name: 'OK', exact: true }));
    await expect(page.locator('.quick-input-widget')).toBeHidden();
    await pause(1800);
    await click(viewAction(page, 'Clear Filters'));
    await pause(800);

    // Search and jump.
    await click(viewAction(page, 'Search Endpoints'));
    await waitForQuickInput(page, 'Search API Endpoints');
    await page.keyboard.type('orderId', { delay: 120 });
    await pause(800);
    await page.keyboard.press('Enter');
    await activeTab(page, 'OrdersApi.java');
    await pause(1800);

    await cast.stop();
    fs.mkdirSync(MEDIA, { recursive: true });
    cast.toGif(path.join(MEDIA, 'demo.gif'), 2.5);
  } finally {
    await session.close();
  }
});
