import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'out/**', 'node_modules/**', '.vscode-test/**', 'test/fixtures/**', 'test-results/**', 'playwright-report/**', '*.vsix'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
      curly: ['error', 'multi-line'],
    },
  },
  {
    files: ['test/**/*.ts', 'scripts/**'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.mjs', '**/*.cjs', '**/*.js'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', __dirname: 'readonly' } },
  },
  {
    // The dashboard webview script runs in the browser sandbox of a VS Code webview.
    files: ['resources/webview/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { acquireVsCodeApi: 'readonly', window: 'readonly', document: 'readonly', Node: 'readonly', CSS: 'readonly', setTimeout: 'readonly' },
    },
    rules: { eqeqeq: ['error', 'always'], 'no-console': 'error' },
  },
);
