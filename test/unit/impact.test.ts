import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { AnalysisEngine } from '../../src/core/engine';
import { defaultExcludeGlobs, PathExcluder } from '../../src/core/exclude';
import { GitFileHost, gitCommit, gitFileAt } from '../../src/core/gitHost';
import { analyzeImpact } from '../../src/core/impact';
import { analyzeFiles } from '../helpers/memoryHost';
import { engineOptions, NodeFileHost } from '../helpers/nodeHost';

const server = (user: string, extra = '') => `const express = require('express'); const app = express();
app.get('/api/users/:id', async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ user: { ${user} } });
});
app.get('/api/products/:id', (req, res) => res.json({ price: 1, stock: 2, name: 'x' }));
${extra}
module.exports = app;`;

const web = {
  'web/package.json': '{}',
  'web/src/services/userService.js': `import axios from 'axios';\nexport async function getUser(id) { const { data } = await axios.get(\`/api/users/\${id}\`); return data; }`,
  'web/src/components/UserProfile.jsx': `import { getUser } from '../services/userService';\nexport async function UserProfile({ id }) {\n  const d = await getUser(id);\n  return <h1>{d.user.name}</h1>;\n}`,
  'web/src/pages/Account.jsx': `import { getUser } from '../services/userService';\nexport async function Account() {\n  const d = await getUser(1);\n  return d.user.id;\n}`,
  'web/src/pages/Product.jsx': `export async function Product() { const p = await (await fetch('/api/products/1')).json(); return p.name; }`,
};

async function impactOf(beforeServer: string, afterServer: string, files: Record<string, string> = web) {
  const before = (await analyzeFiles({ 'server/package.json': '{}', 'server/app.js': beforeServer, ...files })).result;
  const after = (await analyzeFiles({ 'server/package.json': '{}', 'server/app.js': afterServer, ...files })).result;
  return analyzeImpact(before, after, 'HEAD');
}

describe('Change impact', () => {
  it('finds the consumers of a renamed response field and suggests the new name', async () => {
    const report = await impactOf(server('id: user.id, name: user.name'), server('id: user.id, fullName: user.name'));
    expect(report.endpoints).toHaveLength(1);
    const [e] = report.endpoints;
    expect(e).toMatchObject({ method: 'GET', path: '/api/users/:id', status: 'changed', risk: 'high' });
    const [change] = e.changes;
    expect(change).toMatchObject({ text: expect.stringContaining('`user.name` renamed to `user.fullName`'), breaking: true, risk: 'high', evidence: 'confirmed' });
    expect(change.reads.map((r) => [path.basename(r.location.file), r.location.line, r.path, r.within, r.suggestion])).toEqual([['UserProfile.jsx', 4, 'user.name', 'UserProfile', { from: 'name', to: 'fullName' }]]);
    // Account.jsx reads `user.id`, which did not change: it is a caller, not an affected read.
    expect(e.callers.flatMap((c) => c.consumers.map((x) => x.within)).sort()).toEqual(['Account', 'UserProfile']);
    expect(report.summary).toEqual({ high: 1, medium: 0, low: 0 });
  });

  it('reports removed fields and type changes, and treats unaffected consumers as heuristic', async () => {
    const report = await impactOf(server('id: user.id, name: user.name'), server('id: user.id, name: user.name').replace("res.json({ price: 1, stock: 2, name: 'x' })", "res.json({ stock: 'many', name: 'x' })"));
    const [e] = report.endpoints;
    expect(e.path).toBe('/api/products/:id');
    const texts = e.changes.map((c) => `${c.risk}/${c.evidence}: ${c.text}`);
    // Product.jsx reads only `name`: the caller exists but does not read the changed fields.
    expect(texts).toEqual(['medium/heuristic: Response field `price` removed', 'medium/heuristic: Response field `stock` changed from number to string']);
    expect(e.changes[0].reason).toMatch(/Callers read other fields/);
  });

  it('marks endpoints without callers as low risk, and removed endpoints with callers as high', async () => {
    const extra = `app.get('/api/legacy', (req, res) => res.json({ a: 1 }));`;
    const files = { ...web, 'web/src/legacy.js': `fetch('/api/legacy');` };
    const removed = await impactOf(server('id: user.id', extra), server('id: user.id'), files);
    expect(removed.endpoints.map((e) => [e.status, e.path, e.risk])).toEqual([['removed', '/api/legacy', 'high']]);
    const lonely = await impactOf(server('id: user.id', `app.get('/api/x', (req, res) => res.json({ a: 1 }));`), server('id: user.id', `app.get('/api/x', (req, res) => res.json({ b: 1 }));`));
    expect(lonely.endpoints[0].risk).toBe('low');
    expect(lonely.endpoints[0].changes[0].reason).toMatch(/No caller found/);
  });

  it('detects a route that moved to another method or path (same handler)', async () => {
    const before = `const app = require('express')(); const c = require('./ctrl');\napp.put('/api/users/:id', c.update);\nmodule.exports = app;`;
    const after = `const app = require('express')(); const c = require('./ctrl');\napp.patch('/api/users/:id', c.update);\nmodule.exports = app;`;
    const files = { 'server/ctrl.js': `exports.update = (req, res) => res.json({ ok: true });`, 'web/a.js': `import axios from 'axios';\naxios.put('/api/users/1', {});` };
    const report = await impactOf(before, after, files);
    expect(report.endpoints.map((e) => [e.status, e.method, e.risk])).toEqual([['moved', 'PATCH', 'high']]);
    expect(report.endpoints[0].changes[0].text).toBe('Route changed: method PUT → PATCH');
    expect(report.endpoints[0].callers).toHaveLength(1);
  });

  it('counts ambiguous calls as callers of every candidate', async () => {
    const before = `const app = require('express')();\napp.get('/a/:x', (req, res) => res.json({ one: 1 }));\napp.get('/:y/b', (req, res) => res.json({ two: 2 }));\nmodule.exports = app;`;
    const after = before.replace('{ one: 1 }', '{ uno: 1 }');
    const report = await impactOf(before, after, { 'web/a.js': `async function A() { const d = await (await fetch('/a/b')).json(); return d.one; }` });
    const [e] = report.endpoints;
    expect(e.path).toBe('/a/:x');
    expect(e.changes[0]).toMatchObject({ risk: 'high', evidence: 'confirmed' });
  });

  it('compares the working tree with git HEAD', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'api-shadow-impact-')));
    const write = (rel: string, content: string): void => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    };
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    write('package.json', '{}');
    write('server/app.js', server('id: user.id, name: user.name'));
    for (const [k, v] of Object.entries(web)) write(k, v);
    write('openapi.yaml', 'openapi: 3.0.3\ninfo: { title: t, version: "1" }\npaths: {}\n');
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-q', '-m', 'v1');
    write('server/app.js', server('id: user.id, fullName: user.name'));
    const commit = await gitCommit(root);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await gitFileAt(root, 'HEAD', path.join(root, 'openapi.yaml'))).toContain('openapi: 3.0.3');
    expect(await gitFileAt(root, 'HEAD', path.join(root, 'missing.yaml'))).toBeUndefined();
    expect(await gitFileAt(root, 'HEAD', path.join(os.tmpdir(), 'outside.yaml'))).toBeUndefined();
    const excluder = new PathExcluder(defaultExcludeGlobs('read', []));
    const base = await new AnalysisEngine(await GitFileHost.create(root, commit!, excluder, [root]), engineOptions(root)).analyze();
    const head = await new AnalysisEngine(new NodeFileHost(root), engineOptions(root)).analyze();
    const report = analyzeImpact(base, head, 'HEAD');
    expect(report.endpoints.map((e) => e.changes[0].reads.map((r) => `${path.basename(r.location.file)}:${r.path}`))).toEqual([['UserProfile.jsx:user.name']]);
  });
});
