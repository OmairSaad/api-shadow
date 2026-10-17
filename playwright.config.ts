import { defineConfig } from '@playwright/test';

/**
 * UI tests that drive a real VS Code window (Electron) with the extension loaded from this
 * folder. VS Code is downloaded once into .vscode-test/ by @vscode/test-electron.
 */
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
});
