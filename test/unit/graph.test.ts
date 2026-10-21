import { describe, expect, it } from 'vitest';
import { buildDashboardModel, refTable } from '../../src/core/dashboardModel';
import { gitignoreToGlobs, PathExcluder } from '../../src/core/exclude';
import { buildGraph, graphToMermaid } from '../../src/core/graph';
import { analyzeImpact } from '../../src/core/impact';
import { toReport } from '../../src/export/report';
import { analyzeFiles, ROOT } from '../helpers/memoryHost';

const files = {
  'server/package.json': '{}',
  'server/app.js': `const express = require('express'); const app = express(); const users = require('./users.controller');
app.get('/api/users/:id', users.show);
app.get('/api/a/:x', (req, res) => res.json({ a: 1 }));
app.get('/api/:y/b', (req, res) => res.json({ b: 1 }));
app.get('/api/unused', (req, res) => res.json({}));
module.exports = app;`,
  'server/users.controller.js': `const userService = require('./services/user.service');\nexports.show = async (req, res) => res.json(await userService.find(req.params.id));`,
  'server/services/user.service.js': `const User = require('../models/User');\nexports.find = async (id) => User.findById(id);`,
  'web/package.json': '{}',
  'web/src/services/users.js': `import axios from 'axios';\nexport async function getUser(id) { const { data } = await axios.get(\`/api/users/\${id}\`); return data; }\nexport async function other() { return axios.get('/api/a/b'); }\nexport async function missing() { return axios.get('/api/nothing/here/at/all'); }`,
  'web/src/Profile.jsx': `import { getUser } from './services/users';\nexport async function Profile() { const u = await getUser(1); return u.name; }`,
};

describe('Dependency graph', async () => {
  const { result } = await analyzeFiles(files);

  it('links components, API functions, requests, endpoints, handlers, services and models', () => {
    const g = buildGraph(result);
    const label = (id: string): string => g.nodes.find((n) => n.id === id)?.label ?? id;
    const chain = g.edges.map((e) => `${label(e.from)} -${e.kind}-> ${label(e.to)}`);
    expect(chain).toEqual(
      expect.arrayContaining([
        'Profile -consumes-> getUser',
        'getUser -calls-> GET /api/users/${id}',
        'GET /api/users/${id} -matches-> GET /api/users/:id',
        'GET /api/users/:id -handles-> users.show',
        'users.show -uses-> userService.find',
        'userService.find -stores-> User',
      ]),
    );
  });

  it('flags unmatched requests, ambiguous matches and uncalled endpoints', () => {
    const g = buildGraph(result);
    const request = (url: string) => g.nodes.find((n) => n.kind === 'request' && n.label.endsWith(url));
    expect(request('/api/nothing/here/at/all')?.unmatched).toBe(true);
    expect(request('/api/a/b')?.ambiguous).toBe(true);
    expect(g.edges.filter((e) => e.kind === 'ambiguous')).toHaveLength(2);
    expect(g.nodes.find((n) => n.label === 'GET /api/unused')?.uncalled).toBe(true);
    expect(g.nodes.find((n) => n.label === 'GET /api/users/:id')?.uncalled).toBeUndefined();
  });

  it('limits large graphs and focuses on selected endpoints', () => {
    const limited = buildGraph(result, { maxEndpoints: 1 });
    expect(limited.endpoints).toEqual({ shown: 1, total: 4 });
    expect(limited.nodes.filter((n) => n.kind === 'endpoint')).toHaveLength(1);
    const unused = result.endpoints.find((e) => e.path === '/api/unused')!;
    const focused = buildGraph(result, { focus: new Set([unused.id]) });
    expect(focused.nodes.map((n) => n.kind).sort()).toEqual(['endpoint', 'handler']);
  });

  it('highlights what a change affects', async () => {
    const after = (await analyzeFiles({ ...files, 'server/users.controller.js': `exports.show = async (req, res) => res.json({ fullName: 1 });` })).result;
    const before = (await analyzeFiles({ ...files, 'server/users.controller.js': `exports.show = async (req, res) => res.json({ name: 1 });` })).result;
    const report = analyzeImpact(before, after, 'HEAD');
    const g = buildGraph(after, { impact: report });
    expect(g.nodes.filter((n) => n.impacted).map((n) => n.kind).sort()).toEqual(['component', 'endpoint', 'request']);
  });

  it('exports Mermaid', () => {
    const mermaid = graphToMermaid(buildGraph(result));
    expect(mermaid.split('\n')[0]).toBe('flowchart LR');
    expect(mermaid).toContain('"GET /api/users/:id"');
    expect(mermaid).toContain('-.->');
  });
});

describe('Dashboard model and report', async () => {
  const { result } = await analyzeFiles({ ...files, 'web/src/config.js': `export const apiKey = "a8f5f167f44f4964e6c998dee827110c";` });

  it('replaces source locations with refs the host resolves', () => {
    const table = refTable();
    const model = buildDashboardModel(
      { result, analyzing: false, impact: { status: 'off', reason: 'off' }, dismissed: new Set(), disabledRules: [], graphMaxEndpoints: 100, contracts: { files: [] }, testProjects: [], relativePath: (f) => f.slice(ROOT.length + 1), workspace: 'w' },
      table,
    );
    const json = JSON.stringify(model);
    expect(json).not.toContain(ROOT);
    expect(model.summary?.endpoints).toBe(4);
    expect(model.summary?.calls).toMatchObject({ matched: 2, unmatched: 1, ambiguous: 1 });
    const e = (model.endpoints as { path: string; ref: number }[]).find((x) => x.path === '/api/users/:id')!;
    expect(table.refs[e.ref].file).toBe(`${ROOT}/server/app.js`);
  });

  it('writes a report with coverage findings, security findings and no secret values', () => {
    const md = toReport(result, { title: 'R', relativePath: (f) => f.slice(ROOT.length + 1) });
    expect(md).toContain('## API coverage findings');
    expect(md).toContain('### Unmatched frontend requests (1)');
    expect(md).toContain('### Potentially unused routes');
    expect(md).toContain('## Security findings');
    expect(md).not.toContain('a8f5f167f44f4964e6c998dee827110c');
    expect(md).toContain('| GET | `/api/users/:id` |');
  });
});

describe('.gitignore', () => {
  it('converts patterns to exclusion globs, skipping negations and allow-list catch-alls', () => {
    const globs = gitignoreToGlobs('# deps\nnode_modules/\n/build\n*.log\nsrc/generated/\n!keep.log\n');
    const ex = new PathExcluder(globs);
    expect(ex.isExcluded('a/node_modules/x.js')).toBe(true);
    expect(ex.isExcluded('build/app.js')).toBe(true);
    expect(ex.isExcluded('src/build/app.js')).toBe(false);
    expect(ex.isExcluded('logs/x.log')).toBe(true);
    expect(ex.isExcluded('src/generated/api.ts')).toBe(true);
    expect(ex.isExcluded('src/routes/users.ts')).toBe(false);
    expect(gitignoreToGlobs('*\n!src/\n')).toEqual([]);
  });
});
