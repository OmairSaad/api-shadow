import { defineConfig } from '@playwright/test';

/**
 * Captures the Marketplace screenshots and demo GIF in media/ by driving a real VS Code window
 * with the packaged VSIX installed. Run with `npm run screenshots`.
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'capture.spec.ts',
  timeout: 300_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [['list']],
  outputDir: '../../test-results/screenshots-run',
});
