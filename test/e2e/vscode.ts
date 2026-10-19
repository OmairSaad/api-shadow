import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const EXTENSION_ROOT = path.resolve(__dirname, '../..');

export interface VSCodeSession {
  app: ElectronApplication;
  page: Page;
  workspace: string;
  close(): Promise<void>;
}

export interface LaunchOptions {
  /** Name of the workspace folder (shown in the window title). */
  workspaceName?: string;
  /** Mutates the copied fixture workspace before VS Code opens it. */
  prepareWorkspace?: (workspace: string) => void;
  /** User settings merged over the test defaults. */
  settings?: Record<string, unknown>;
  /** Window content size in CSS pixels, or 'maximized' to fill the screen's work area. */
  windowSize?: { width: number; height: number } | 'maximized';
  /** Device scale factor, e.g. 2 for crisp screenshots. */
  deviceScaleFactor?: number;
  /** VSIX to install instead of loading the development build. Defaults to $API_SHADOW_VSIX. */
  vsix?: string;
}

/** Launches VS Code with the extension under development and a fresh copy of the fixtures. */
export async function launchVSCode(options: LaunchOptions = {}): Promise<VSCodeSession> {
  const executablePath = await downloadAndUnzipVSCode({ version: process.env.VSCODE_TEST_VERSION ?? 'stable', cachePath: path.join(EXTENSION_ROOT, '.vscode-test') });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-shadow-e2e-'));
  const workspace = path.join(tmp, options.workspaceName ?? 'workspace');
  for (const name of ['express-app', 'nest-app', 'spring-app', 'web-app']) {
    fs.cpSync(path.join(EXTENSION_ROOT, 'test/fixtures', name), path.join(workspace, name), { recursive: true });
  }
  options.prepareWorkspace?.(workspace);
  const userData = path.join(tmp, 'user-data');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify({
      'workbench.startupEditor': 'none',
      'workbench.tips.enabled': false,
      'workbench.enableExperiments': false,
      'files.simpleDialog.enable': true,
      'security.workspace.trust.enabled': false,
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
      'extensions.ignoreRecommendations': true,
      'chat.disableAIFeatures': true,
      'window.restoreWindows': 'none',
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      ...options.settings,
    }),
  );
  const extensionsDir = path.join(tmp, 'extensions');
  // API_SHADOW_VSIX=path/to.vsix tests the packaged (minified) extension instead of the dev build.
  const vsixOption = options.vsix ?? process.env.API_SHADOW_VSIX;
  const vsix = vsixOption ? path.resolve(EXTENSION_ROOT, vsixOption) : undefined;
  if (vsix) {
    const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executablePath);
    const install = spawnSync(cli, [...cliArgs, `--extensions-dir=${extensionsDir}`, `--user-data-dir=${userData}`, '--install-extension', vsix], { encoding: 'utf8', env: cleanEnv() });
    if (install.status !== 0) throw new Error(`Installing ${vsix} failed:\n${install.stdout}\n${install.stderr}`);
  }
  const app = await electron.launch({
    executablePath,
    args: [
      workspace,
      ...(vsix ? [] : [`--extensionDevelopmentPath=${EXTENSION_ROOT}`, '--disable-extensions']),
      `--user-data-dir=${userData}`,
      `--extensions-dir=${extensionsDir}`,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-gpu',
      '--new-window',
      ...(options.deviceScaleFactor ? [`--force-device-scale-factor=${options.deviceScaleFactor}`] : []),
    ],
    env: cleanEnv(),
  });
  const page = await app.firstWindow();
  await page.locator('.monaco-workbench').waitFor({ state: 'visible', timeout: 60_000 });
  if (options.windowSize) {
    await app.evaluate(({ BrowserWindow }, size) => {
      type Win = { isVisible(): boolean; isMaximized(): boolean; maximize(): void; unmaximize(): void; isFullScreen(): boolean; setFullScreen(v: boolean): void; setContentSize(w: number, h: number): void; center(): void };
      const windows = BrowserWindow.getAllWindows() as Win[];
      const win = windows.find((w) => w.isVisible()) ?? windows[0];
      if (win.isFullScreen()) win.setFullScreen(false);
      if (size === 'maximized') {
        win.maximize();
        return;
      }
      if (win.isMaximized()) win.unmaximize();
      win.setContentSize(size.width, size.height);
      win.center();
    }, options.windowSize);
    if (options.windowSize === 'maximized') {
      // Wait for the window manager to apply the new size and the workbench to lay out again.
      let last = '';
      await expect.poll(async () => {
        const now = await page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`);
        const stable = now === last;
        last = now;
        return stable;
      }, { intervals: [300] }).toBe(true);
    } else {
      const size = options.windowSize;
      await page.waitForFunction((s) => window.innerWidth === s.width && window.innerHeight === s.height, size);
    }
  }
  return {
    app,
    page,
    workspace,
    close: async () => {
      await app.close().catch(() => undefined);
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Runs a command through the Command Palette, like a user would. */
export async function runCommand(page: Page, title: string): Promise<void> {
  const widget = page.locator('.quick-input-widget');
  const input = widget.locator('input.input');
  await widget.waitFor({ state: 'hidden' }).catch(() => undefined);
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.keyboard.press('F1');
    try {
      await input.waitFor({ state: 'visible', timeout: 2000 });
      break;
    } catch {
      // The workbench may still be closing a previous quick input; try again.
    }
  }
  await input.fill(`>${title}`);
  const rows = page.locator('.quick-input-list .monaco-list-row');
  await rows.filter({ hasText: title }).first().waitFor({ state: 'visible' });
  // Fuzzy matching can rank a similar command first (e.g. "Markdown: Open as Preview"), so prefer
  // the entry whose label is exactly the title.
  const exact = rows.filter({ has: page.locator('.label-name').getByText(title, { exact: true }) });
  if ((await exact.count()) > 0) await exact.first().click();
  else await page.keyboard.press('Enter');
}

/**
 * Environment for the VS Code process. When tests are started from a terminal inside VS Code,
 * ELECTRON_RUN_AS_NODE (and other VSCODE_* variables) are inherited and would make the Electron
 * binary behave like plain Node.
 */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('VSCODE_')) continue;
    env[k] = v;
  }
  return env;
}

/** Waits until the quick input with the given title is showing (e.g. after a command opened it). */
export async function waitForQuickInput(page: Page, title: string | RegExp): Promise<void> {
  await page.locator('.quick-input-widget .quick-input-title').filter({ hasText: title }).waitFor({ state: 'visible' });
}
