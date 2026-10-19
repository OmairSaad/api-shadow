import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { diffApis, diffToMarkdown } from '../../src/core/apiDiff';
import { AnalysisEngine } from '../../src/core/engine';
import { defaultExcludeGlobs, PathExcluder } from '../../src/core/exclude';
import { GitFileHost, gitRefs, gitRepoRoot } from '../../src/core/gitHost';
import { engineOptions, NodeFileHost } from '../helpers/nodeHost';

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

describe('API diff against a git revision', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'api-shadow-git-')));
  write(root, {
    'package.json': '{}',
    'src/app.js': `const express = require('express');\nconst app = express();\nconst auth = require('./auth');\napp.get('/users', auth.requireAuth, (req, res) => res.end());\napp.get('/users/:id', (req, res) => res.end());\napp.delete('/users/:id', auth.requireAuth, (req, res) => res.end());\napp.get('/legacy', (req, res) => res.end());\nmodule.exports = app;`,
  });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'v1');
  git(root, 'tag', 'v1.0');
  // Working tree: one endpoint removed, one added, auth dropped from DELETE, param renamed.
  write(root, {
    'src/app.js': `const express = require('express');\nconst app = express();\nconst auth = require('./auth');\napp.get('/users', auth.requireAuth, (req, res) => res.end());\napp.get('/users/:userId', (req, res) => res.end());\napp.delete('/users/:id', (req, res) => res.end());\napp.post('/users', (req, res) => res.end());\nmodule.exports = app;`,
    'src/new.test.js': `it('x', () => {});`,
  });

  const excluder = new PathExcluder(defaultExcludeGlobs('read', []));
  const base = await new AnalysisEngine(await GitFileHost.create(root, 'main', excluder, [root]), engineOptions(root)).analyze();
  const head = await new AnalysisEngine(new NodeFileHost(root), engineOptions(root)).analyze();

  it('analyzes the committed version without touching the working tree', () => {
    expect(base.endpoints.map((e) => `${e.method} ${e.path}`).sort()).toEqual(['DELETE /users/:id', 'GET /legacy', 'GET /users', 'GET /users/:id']);
    expect(base.endpoints[0].location.file.startsWith(root)).toBe(true);
  });

  it('classifies added, removed and changed endpoints and flags breaking changes', () => {
    const diff = diffApis(base, head);
    expect(diff.added.map((e) => `${e.method} ${e.path}`)).toEqual(['POST /users']);
    expect(diff.removed.map((e) => `${e.method} ${e.path}`)).toEqual(['GET /legacy']);
    expect(diff.changed.map((c) => [`${c.after.method} ${c.after.path}`, c.changes.map((x) => x.text)])).toEqual([
      ['DELETE /users/:id', ['Auth removed (was auth.requireAuth)', 'Middleware removed: auth.requireAuth']],
      ['GET /users/:userId', ['Path parameters renamed: /users/:id → /users/:userId']],
    ]);
    expect(diff.breaking).toBe(1);
    const md = diffToMarkdown(diff, 'main', 'working tree', (f) => path.relative(root, f));
    expect(md).toContain('**1 added · 1 removed · 2 changed** · ⚠️ **1 breaking**');
    expect(md).toContain('## ⚠️ Removed (breaking)\n\n- **GET** `/legacy` — was in src/app.js:7');
  });

  it('lists refs and the repository root', async () => {
    expect(await gitRepoRoot(path.join(root, 'src'))).toBe(root);
    expect((await gitRefs(root)).map((r) => `${r.kind}:${r.name}`).sort()).toEqual(['branch:main', 'tag:v1.0']);
    await expect(GitFileHost.create(root, '--output=/tmp/x', excluder, [root])).rejects.toThrow(/Invalid revision/);
    await expect(GitFileHost.create(root, 'nope', excluder, [root])).rejects.toThrow();
  });

  it('reports no changes for identical versions', async () => {
    const again = await new AnalysisEngine(await GitFileHost.create(root, 'v1.0', excluder, [root]), engineOptions(root)).analyze();
    expect(diffToMarkdown(diffApis(base, again), 'a', 'b', (f) => f)).toContain('No endpoint changes.');
  });
});
