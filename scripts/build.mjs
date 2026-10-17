// Bundles the extension into a single CommonJS file. Runtime dependencies (@babel/parser,
// java-parser, yaml) are pure JavaScript and are bundled, so the VSIX ships without node_modules.
import * as esbuild from 'esbuild';
import * as fs from 'fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  legalComments: 'linked',
  logLevel: 'info',
};

if (production) fs.rmSync('dist', { recursive: true, force: true });

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
