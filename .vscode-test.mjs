// Integration tests run inside a real VS Code (Extension Development Host) via @vscode/test-cli.
// The fixture projects are copied to a temporary workspace because the tests modify files.
import { defineConfig } from '@vscode/test-cli';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = path.join(os.tmpdir(), 'api-shadow-integration-workspace');
fs.rmSync(workspace, { recursive: true, force: true });
for (const name of ['express-app', 'nest-app', 'spring-app', 'web-app', 'laravel-app']) {
  fs.cpSync(path.resolve('test/fixtures', name), path.join(workspace, name), {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}node_modules${path.sep}`),
  });
}

export default defineConfig({
  label: 'integration',
  files: 'out/test/integration/**/*.test.js',
  version: process.env.VSCODE_TEST_VERSION ?? 'stable',
  workspaceFolder: workspace,
  launchArgs: ['--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
  mocha: { ui: 'bdd', timeout: 60000, color: true },
});
