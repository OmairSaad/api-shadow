import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { findDuplicates } from '../../src/core/duplicates';
import type { Endpoint, HttpMethod } from '../../src/core/types';
import { analyzeFiles, find, routes } from '../helpers/memoryHost';

const express = (body: string): string => `const express = require('express');\nconst router = express.Router();\n${body}\nmodule.exports = router;`;
const dupMessages = (r: { issues: { kind: string; message: string }[] }): string[] => r.issues.filter((i) => i.kind === 'duplicate').map((i) => i.message);

describe('Duplicate routes: no false positives', () => {
  it('keeps routes that share a base path apart', async () => {
    const { result } = await analyzeFiles({
      'src/routes.js': express(`router.get('/api/call/shopify', (req, res) => res.end());\nrouter.get("/api/call/internalroute", (req, res) => res.end());\nrouter.get(\`/api/call/stripe\`, (req, res) => res.end());`),
    });
    expect(routes(result.endpoints)).toEqual(['GET /api/call/internalroute', 'GET /api/call/shopify', 'GET /api/call/stripe']);
    expect(dupMessages(result)).toEqual([]);
  });

  it('does not equate different unresolved expressions', async () => {
    const { result } = await analyzeFiles({
      'src/routes.js': express(`router.get(config.shopifyPath, (req, res) => res.end());\nrouter.get(config.internalPath, (req, res) => res.end());\nrouter.get(getPath('a'), (req, res) => res.end());\nrouter.get(getPath('b'), (req, res) => res.end());`),
    });
    expect(dupMessages(result)).toEqual([]);
  });

  it('still reports the same unresolved expression twice', async () => {
    const { result } = await analyzeFiles({ 'src/routes.js': express(`router.get(config.path, (req, res) => res.end());\nrouter.get(config.path, (req, res) => res.end());`) });
    expect(dupMessages(result)).toEqual([expect.stringContaining('GET /${config.path} declared 2 times')]);
  });

  it('separates regex-constrained parameters', async () => {
    const { result } = await analyzeFiles({ 'src/routes.js': express(`router.get('/p/:id(\\\\d+)', (req, res) => res.end());\nrouter.get('/p/:slug', (req, res) => res.end());`) });
    expect(dupMessages(result)).toEqual([]);
  });

  it('ignores one declaration reached twice', () => {
    const e = (id: string): Endpoint => ({ id, framework: 'express', method: 'GET' as HttpMethod, path: '/x', pathIsStatic: true, location: { file: '/p/r.js', line: 3, column: 1 }, middleware: [], services: [], parameters: [], notes: [], projectRoot: '/p' });
    expect(findDuplicates([e('a'), e('b')]).groups).toEqual([]);
  });

  it('separates NestJS routes that differ only in header-selected version', async () => {
    const { result } = await analyzeFiles({
      'src/main.ts': `import { NestFactory } from '@nestjs/core'; import { VersioningType } from '@nestjs/common';\nasync function b() { const app = await NestFactory.create({}); app.enableVersioning({ type: VersioningType.HEADER, header: 'X-API-Version' }); }`,
      'src/cats.controller.ts': `import { Controller, Get, Version } from '@nestjs/common';\n@Controller('cats')\nexport class CatsController {\n  @Version('1') @Get() v1() {}\n  @Version('2') @Get() v2() {}\n}`,
    });
    expect(result.endpoints.map((e) => e.version).sort()).toEqual(['1', '2']);
    expect(dupMessages(result)).toEqual([]);
  });

  it('separates Spring mappings with different request conditions, and treats ":" as literal', async () => {
    const { result } = await analyzeFiles({
      'pom.xml': '<project/>',
      'src/main/java/a/C.java': `package a;\nimport org.springframework.web.bind.annotation.*;\n@RestController @RequestMapping("/items")\npublic class C {\n  @GetMapping(params = "type=a") public String a() { return ""; }\n  @GetMapping(params = "type=b") public String b() { return ""; }\n  @PostMapping(value = "/x", consumes = "application/json") public void j() {}\n  @PostMapping(value = "/x", consumes = "text/csv") public void csv() {}\n  @PostMapping("/v1:batchGet") public void g() {}\n  @PostMapping("/v1:batchDelete") public void d() {}\n}`,
    });
    expect(find(result.endpoints, 'GET', '/items').conditions).toBeDefined();
    expect(result.endpoints.filter((e) => e.path === '/items').map((e) => e.conditions)).toEqual([['params = "type=a"'], ['params = "type=b"']]);
    expect(dupMessages(result)).toEqual([]);
  });
});

describe('Duplicate routes: real duplicates are still found', () => {
  it('reports identical routes, including different parameter names', async () => {
    const { result } = await analyzeFiles({ 'src/routes.js': express(`router.get('/u/:id', (req, res) => res.end());\nrouter.get('/u/:userId', (req, res) => res.end());`) });
    expect(dupMessages(result)).toEqual([expect.stringContaining('GET /u/{} declared 2 times (routes.js:3, routes.js:4)')]);
  });

  it('reports routes made identical through imported constants', async () => {
    const { result } = await analyzeFiles({
      'src/paths.js': `module.exports = { USERS: '/users', MEMBERS: '/users' };`,
      'src/routes.js': express(`const P = require('./paths');\nrouter.get(P.USERS, (req, res) => res.end());\nrouter.get(P.MEMBERS, (req, res) => res.end());`),
    });
    expect(routes(result.endpoints)).toEqual(['GET /users', 'GET /users']);
    expect(dupMessages(result)).toHaveLength(1);
  });
});

describe('Imported path constants', () => {
  it('resolves named, default, namespace, enum and CommonJS imports across files', async () => {
    const { result } = await analyzeFiles({
      'src/constants/routes.ts': `export const API = '/api';\nexport const ROUTES = Object.freeze({ CALL: { SHOPIFY: '/call/shopify', INTERNAL: '/call/internalroute' } });\nexport enum Admin { STATS = '/admin/stats' }\nexport default { HEALTH: '/health' };`,
      'src/constants/legacy.js': `const BASE = '/legacy';\nexports.ORDERS = BASE + '/orders';`,
      'src/constants/index.ts': `export * from './routes';`,
      'src/app.ts': `import express from 'express';\nimport { API, ROUTES } from './constants';\nimport * as C from './constants/routes';\nimport paths from './constants/routes';\nconst { ORDERS } = require('./constants/legacy');\nconst app = express();\napp.get(\`\${API}\${ROUTES.CALL.SHOPIFY}\`, (req, res) => res.end());\napp.get(API + ROUTES.CALL.INTERNAL, (req, res) => res.end());\napp.get(C.Admin.STATS, (req, res) => res.end());\napp.get(paths.HEALTH, (req, res) => res.end());\napp.get(ORDERS, (req, res) => res.end());\nexport default app;`,
    });
    expect(routes(result.endpoints)).toEqual(['GET /admin/stats', 'GET /api/call/internalroute', 'GET /api/call/shopify', 'GET /health', 'GET /legacy/orders']);
    expect(result.endpoints.every((e) => e.pathIsStatic)).toBe(true);
    expect(dupMessages(result)).toEqual([]);
  });

  it('resolves constants in mounts and NestJS decorators', async () => {
    const { result } = await analyzeFiles({
      'src/paths.ts': `export const PATHS = { V1: '/v1', CATS: 'cats', LIST: 'list' };`,
      'src/app.js': `const express = require('express');\nconst { PATHS } = require('./paths');\nconst app = express();\napp.use(PATHS.V1, require('./r'));`,
      'src/r.js': `const r = require('express').Router();\nr.get('/x', (req, res) => res.end());\nmodule.exports = r;`,
      'src/cats.controller.ts': `import { Controller, Get } from '@nestjs/common';\nimport { PATHS } from './paths';\n@Controller(PATHS.CATS)\nexport class CatsController { @Get(PATHS.LIST) list() {} }`,
    });
    expect(routes(result.endpoints)).toEqual(['GET /cats/list', 'GET /v1/x']);
  });

  it('keeps unresolvable references dynamic', async () => {
    const { result } = await analyzeFiles({ 'src/routes.js': express(`const { MISSING } = require('./nowhere');\nrouter.get(MISSING, (req, res) => res.end());`) });
    const e = result.endpoints[0];
    expect(e.path).toBe('/${MISSING}');
    expect(e.pathIsStatic).toBe(false);
    expect(path.basename(e.location.file)).toBe('routes.js');
  });
});

describe('Robustness', () => {
  it('handles code whose names collide with Object.prototype', async () => {
    const { result } = await analyzeFiles({
      'src/routes.js': express(`function constructor() {}\nconst toString = () => 1;\nconstructor();\nhasOwnProperty();\nrouter.toString('/x', () => 1);\nrouter.get('/ok', (req, res) => { constructor(); res.end(); });`),
      'src/svc.service.js': `exports.constructor = () => 1;`,
    });
    expect(routes(result.endpoints)).toEqual(['GET /ok']);
    expect(result.issues.filter((i) => i.kind === 'parse-error')).toEqual([]);
  });
});
