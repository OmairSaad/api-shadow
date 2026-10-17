import { describe, expect, it } from 'vitest';
import { AnalysisEngine } from '../../src/core/engine';
import { CancelledError } from '../../src/core/types';
import { MemoryHost, ROOT, analyzeFiles, routes } from '../helpers/memoryHost';
import { engineOptions } from '../helpers/nodeHost';

const APP = `
  const express = require('express');
  const app = express();
  app.use('/users', require('./users'));
`;
const USERS = `
  const router = require('express').Router();
  router.get('/', list);
  module.exports = router;
`;

function setup(files: Record<string, string>) {
  const host = new MemoryHost({ 'package.json': '{}', ...files });
  const engine = new AnalysisEngine(host, engineOptions(ROOT));
  return { host, engine };
}

describe('AnalysisEngine', () => {
  it('re-reads only changed files on incremental runs', async () => {
    const { host, engine } = setup({ 'app.js': APP, 'users.js': USERS, 'unrelated.js': 'export const x = 1;' });
    const first = await engine.analyze();
    expect(routes(first.endpoints)).toEqual(['GET /users']);
    expect(first.stats.filesAnalyzed).toBe(2); // unrelated.js is pre-filtered, not parsed

    host.reads.length = 0;
    const users = host.write('users.js', USERS.replace("router.get('/', list);", "router.get('/', list);\n  router.post('/', create);"));
    engine.markChanged([users]);
    const second = await engine.analyze();
    expect(routes(second.endpoints)).toEqual(['GET /users', 'POST /users']);
    expect(host.reads).toEqual([users]);
    expect(second.stats.filesFromCache).toBeGreaterThanOrEqual(2);
  });

  it('picks up created and deleted files after a structure change', async () => {
    const { host, engine } = setup({ 'app.js': APP, 'users.js': USERS });
    await engine.analyze();
    host.write('orders.js', `const app = require('express')(); app.get('/orders', h);`);
    engine.markStructureChanged();
    expect(routes((await engine.analyze()).endpoints)).toEqual(['GET /orders', 'GET /users']);
    const removed = host.delete('users.js');
    engine.markStructureChanged([removed]);
    const after = await engine.analyze();
    expect(routes(after.endpoints)).toEqual(['GET /orders']);
    expect(after.issues.some((i) => /Could not resolve module/.test(i.message))).toBe(true);
  });

  it('detects external modifications on a full refresh', async () => {
    const { host, engine } = setup({ 'app.js': APP, 'users.js': USERS });
    await engine.analyze();
    host.write('users.js', USERS.replace('router.get', 'router.put'));
    expect(routes((await engine.analyze()).endpoints)).toEqual(['GET /users']); // not told
    expect(routes((await engine.analyze(undefined, { full: true })).endpoints)).toEqual(['PUT /users']);
  });

  it('honours cancellation', async () => {
    const { engine } = setup({ 'app.js': APP, 'users.js': USERS });
    await expect(engine.analyze({ isCancellationRequested: true })).rejects.toBeInstanceOf(CancelledError);
  });

  it('truncates very large workspaces and skips oversized files', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`r${String(i).padStart(2, '0')}.js`] = `const app = require('express')(); app.get('/r${i}', h);`;
    files['zz-big.js'] = `const app = require('express')(); app.get('/big', h);` + ' '.repeat(5000);
    const truncated = await analyzeFiles(files, { maxFiles: 10 });
    expect(truncated.result.stats.truncated).toBe(true);
    expect(truncated.result.endpoints).toHaveLength(10);
    expect(truncated.result.issues.some((i) => i.kind === 'skipped')).toBe(true);

    const big = await analyzeFiles(files, { maxFileSizeBytes: 1024 });
    expect(big.result.endpoints.some((e) => e.path === '/big')).toBe(false);
    expect(big.result.issues.some((i) => /larger than 1 KB/.test(i.message))).toBe(true);
  });

  it('respects the framework selection', async () => {
    const { result } = await analyzeFiles(
      {
        'app.js': `const app = require('express')(); app.get('/e', h);`,
        'C.java': `@RestController class C { @GetMapping("/s") void a(){} }`,
      },
      { frameworks: new Set(['spring']) },
    );
    expect(routes(result.endpoints)).toEqual(['GET /s']);
  });

  it('round-trips its cache and rejects caches from other versions', async () => {
    const { host, engine } = setup({ 'app.js': APP, 'users.js': USERS });
    await engine.analyze();
    const serialized = JSON.parse(JSON.stringify(engine.serializeCache()));
    const fresh = new AnalysisEngine(host, engineOptions(ROOT));
    expect(fresh.loadCache(serialized)).toBe(true);
    host.reads.length = 0;
    const result = await fresh.analyze();
    expect(routes(result.endpoints)).toEqual(['GET /users']);
    expect(host.reads).toEqual([]);
    expect(fresh.loadCache({ ...serialized, version: -1 })).toBe(false);
    expect(fresh.loadCache('garbage')).toBe(false);
  });

  it('survives unreadable files', async () => {
    const host = new MemoryHost({ 'package.json': '{}', 'app.js': APP, 'users.js': USERS });
    host.readFile = async (f: string) => {
      if (f.endsWith('users.js')) throw new Error('EACCES');
      return host.files.get(f)!.content;
    };
    const engine = new AnalysisEngine(host, engineOptions(ROOT));
    const result = await engine.analyze();
    expect(result.endpoints).toEqual([]);
  });

  it('analyses files referenced by routes even when the pre-filter skipped them', async () => {
    const { result } = await analyzeFiles({
      'app.js': `const app = require('express')(); const c = require('./ctrl'); app.get('/a', c.handle);`,
      'ctrl.js': `const svc = require('./services/thing'); exports.handle = (req, res) => svc.doThing();`,
      'services/thing.js': `exports.doThing = () => 1;`,
    });
    const e = result.endpoints[0];
    expect(e.handlerLocation?.file.endsWith('ctrl.js')).toBe(true);
    expect(e.services.map((s) => s.name)).toEqual(['svc.doThing']);
    expect(e.services[0].location?.file.endsWith('thing.js')).toBe(true);
  });
});
