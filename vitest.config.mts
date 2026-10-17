import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/vscode/**'] },
  },
});
