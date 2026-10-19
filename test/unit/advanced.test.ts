import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { matchScore, parseClientUrl, parseRoute, shadows } from '../../src/core/routeMatch';
import type { AnalysisResult } from '../../src/core/types';
import { analyzeFiles, find, routes } from '../helpers/memoryHost';

const issues = (r: AnalysisResult, kind: string): string[] => r.issues.filter((i) => i.kind === kind).map((i) => i.message);
const express = (body: string): string => `const express = require('express');\nconst router = express.Router();\n${body}\nmodule.exports = router;`;

describe('Route matching', () => {
  const r = (p: string, fw: 'express' | 'spring' = 'express') => parseRoute(p, fw)!;
  it('knows when an earlier route catches every request of a later one', () => {
    expect(shadows(r('/users/:id'), r('/users/me'), 'express')).toBe(true);
    expect(shadows(r('/users/:id(\\d+)'), r('/users/me'), 'express')).toBe(false);
    expect(shadows(r('/users/:id(\\d+)'), r('/users/42'), 'express')).toBe(true);
    expect(shadows(r('/files/*'), r('/files/a/b'), 'express')).toBe(true);
    expect(shadows(r('*'), r('/anything'), 'express')).toBe(true);
    expect(shadows(r('/users/:id'), r('/users/:userId'), 'express')).toBe(false); // duplicate, not shadowing
    expect(shadows(r('/users/me'), r('/users/:id'), 'express')).toBe(false);
    expect(shadows(r('/a/:x/c'), r('/a/b/d'), 'express')).toBe(false);
    expect(shadows(r('/Users/:id'), r('/users/me'), 'express')).toBe(true); // Express is case-insensitive
  });

  it('matches client URLs, with unknown values and unknown base URLs', () => {
    const url = (u: string, base = false) => parseClientUrl(u, base)!;
    expect(matchScore(url('/users/${id}'), r('/users/:id'), 'express')).toBeGreaterThan(matchScore(url('/users/${id}'), r('/users/me'), 'express')!);
    expect(matchScore(url('/users/42?expand=1'), r('/users/:id'), 'express')).toBeDefined();
    expect(matchScore(url('http://localhost:3000/users'), r('/users'), 'express')).toBeDefined();
    expect(matchScore(url('${API_URL}/users'), r('/api/v1/users'), 'express')).toBeDefined();
    expect(matchScore(url('/users', true), r('/api/users'), 'express')).toBeDefined();
    expect(matchScore(url('/users'), r('/api/users'), 'express')).toBeUndefined();
    expect(matchScore(url('/products/${id}'), r('/products/{id}', 'spring'), 'spring')).toBeDefined();
    expect(parseClientUrl('https://api.stripe.com/v1/charges')!.external).toBe(true);
  });
});

describe('Unreachable routes', () => {
  it('flags a route declared after a parameter route that catches it', async () => {
    const { result } = await analyzeFiles({
      'src/app.js': `const express = require('express');\nconst app = express();\napp.use('/users', require('./users'));`,
      'src/users.js': express(`router.get('/:id', (req, res) => res.end());\nrouter.get('/me', (req, res) => res.end());\nrouter.get('/stats', getStats);\nrouter.post('/me', (req, res) => res.end());`),
    });
    expect(issues(result, 'unreachable')).toEqual([
      'GET /users/me is unreachable: GET /users/:id (users.js:3) is registered first and matches every request it would get. Declare it before that route.',
      'GET /users/stats is unreachable: GET /users/:id (users.js:3) is registered first and matches every request it would get. Declare it before that route.',
    ]);
    const issue = result.issues.find((i) => i.kind === 'unreachable')!;
    expect(issue.related?.[0].location.line).toBe(3);
  });

  it('does not flag routes declared first, handlers that call next(), or separate routers', async () => {
    const { result } = await analyzeFiles({
      'src/app.js': `const express = require('express');\nconst app = express();\napp.get('/a/me', (req, res) => res.end());\napp.get('/a/:id', (req, res) => res.end());\napp.get('/b/:id', (req, res, next) => (req.params.id === 'me' ? next() : res.end()));\napp.get('/b/me', (req, res) => res.end());\napp.use('/c', require('./c1'));\napp.use('/d', require('./c2'));`,
      'src/c1.js': express(`router.get('/:id', (req, res) => res.end());`),
      'src/c2.js': express(`router.get('/me', (req, res) => res.end());`),
    });
    expect(issues(result, 'unreachable')).toEqual([]);
  });

  it('flags a catch-all registered before other routes, across mounts', async () => {
    const { result } = await analyzeFiles({
      'src/app.js': `const express = require('express');\nconst app = express();\napp.get('*', (req, res) => res.sendFile('index.html'));\napp.use('/api', require('./api'));`,
      'src/api.js': express(`router.get('/users', (req, res) => res.end());`),
    });
    expect(issues(result, 'unreachable')).toEqual([expect.stringMatching(/^GET \/api\/users is unreachable: GET \/\* \(app\.js:3\)/)]);
  });

  it('flags NestJS methods in declaration order', async () => {
    const { result } = await analyzeFiles({
      'src/users.controller.ts': `import { Controller, Get } from '@nestjs/common';\n@Controller('users')\nexport class UsersController {\n  @Get(':id') one() {}\n  @Get('me') me() {}\n}`,
    });
    expect(issues(result, 'unreachable')).toEqual([expect.stringMatching(/^GET \/users\/me is unreachable: GET \/users\/:id/)]);
  });

  it('does not apply to Spring, which picks the most specific mapping', async () => {
    const { result } = await analyzeFiles({
      'pom.xml': '<project/>',
      'src/main/java/a/U.java': `package a;\nimport org.springframework.web.bind.annotation.*;\n@RestController @RequestMapping("/users")\npublic class U {\n  @GetMapping("/{id}") public String one() { return ""; }\n  @GetMapping("/me") public String me() { return ""; }\n}`,
    });
    expect(issues(result, 'unreachable')).toEqual([]);
  });
});

describe('Fastify', () => {
  it('finds routes, route objects, plugins with prefixes, hooks and body schemas', async () => {
    const { result } = await analyzeFiles({
      'src/server.ts': `import Fastify from 'fastify';\nimport users from './users';\nconst app = Fastify({ logger: true });\napp.get('/health', async () => ({ ok: true }));\napp.register(users, { prefix: '/api/users' });\napp.register(async (instance) => {\n  instance.get('/ping', async () => 'pong');\n}, { prefix: '/inline' });\napp.listen({ port: 4000 });`,
      'src/users.ts': `import { FastifyInstance } from 'fastify';\nexport default async function users(fastify: FastifyInstance) {\n  fastify.get('/:id', { preHandler: [fastify.authenticate] }, async (req) => ({}));\n  fastify.route({ method: ['POST', 'PUT'], url: '/', schema: { body: { type: 'object' } }, handler: async () => ({}) });\n}`,
    });
    expect(routes(result.endpoints)).toEqual(['GET /api/users/:id', 'GET /health', 'GET /inline/ping', 'POST /api/users', 'PUT /api/users']);
    expect(result.endpoints.every((e) => e.framework === 'fastify')).toBe(true);
    const one = find(result.endpoints, 'GET', '/api/users/:id');
    expect(one.middleware).toEqual(['fastify.authenticate']);
    expect(one.auth?.status).toBe('protected');
    expect(one.notes[0]).toMatch(/Registered as a plugin with prefix "\/api\/users"/);
    expect(find(result.endpoints, 'POST', '/api/users').validation).toEqual({ status: 'validated', via: ['route schema'] });
    expect(result.servers.map((s) => s.port)).toEqual([4000]);
  });

  it('follows fastify-plugin wrappers and CommonJS plugins', async () => {
    const { result } = await analyzeFiles({
      'src/app.js': `const fastify = require('fastify')();\nconst fp = require('fastify-plugin');\nfastify.register(require('./routes'), { prefix: '/v1' });\nfastify.register(fp(async function plugin(f) { f.post('/events', async () => 1); }));`,
      'src/routes.js': `module.exports = async function (fastify, opts) {\n  fastify.delete('/items/:id', async () => 1);\n};`,
    });
    expect(routes(result.endpoints)).toEqual(['DELETE /v1/items/:id', 'POST /events']);
  });
});

describe('Koa', () => {
  it('finds router routes with prefixes, nested routers and named routes', async () => {
    const { result } = await analyzeFiles({
      'src/app.js': `const Koa = require('koa');\nconst Router = require('@koa/router');\nconst app = new Koa();\nconst api = new Router({ prefix: '/api' });\nconst users = new Router();\nusers.get('user', '/:id', (ctx) => { ctx.body = {}; });\nusers.del('/:id', auth, (ctx) => {});\napi.use('/users', users.routes(), users.allowedMethods());\napi.get('/health', (ctx) => {});\napp.use(api.routes()).use(api.allowedMethods());\napp.listen(3001);`,
    });
    expect(routes(result.endpoints)).toEqual(['DELETE /api/users/:id', 'GET /api/health', 'GET /api/users/:id']);
    expect(result.endpoints.every((e) => e.framework === 'koa')).toBe(true);
  });

  it('treats a two-parameter Koa handler as pass-through', async () => {
    const { result } = await analyzeFiles({
      'src/app.js': `import Router from '@koa/router';\nconst router = new Router();\nrouter.get('/:id', async (ctx, next) => next());\nrouter.get('/me', async (ctx) => {});\nexport default router;`,
    });
    expect(issues(result, 'unreachable')).toEqual([]);
  });
});

describe('Frontend and test calls', () => {
  const backend = {
    'server/package.json': '{}',
    'server/src/app.js': `const express = require('express');\nconst app = express();\napp.use('/api', require('./routes'));\napp.listen(3000);`,
    'server/src/routes.js': express(`router.get('/users', (req, res) => res.end());\nrouter.get('/users/:id', (req, res) => res.end());\nrouter.post('/users', (req, res) => res.end());\nrouter.get('/reports', (req, res) => res.end());`),
  };

  it('links fetch, axios, axios instances and imported clients to endpoints', async () => {
    const { result } = await analyzeFiles({
      ...backend,
      'web/package.json': '{}',
      'web/src/api.ts': `import axios from 'axios';\nexport const api = axios.create({ baseURL: '/api' });\nexport async function load(id: string) {\n  await fetch('/api/users');\n  await fetch(\`/api/users/\${id}\`, { method: 'GET' });\n  await axios.post('/api/users', { name: 'x' });\n  await api.get(\`/users/\${id}\`);\n  await fetch(\`\${process.env.API_URL}/users\`);\n  await fetch('https://api.stripe.com/v1/charges');\n}`,
      'web/src/page.tsx': `import { api } from './api';\nexport const Page = () => { api.get('/users'); return null; };`,
    });
    const mapped = result.clientCalls.map((c) => [c.client, c.method, c.url, c.endpointIds.map((id) => result.endpoints.find((e) => e.id === id)!.path)]);
    expect(mapped).toEqual([
      ['fetch', 'GET', '/api/users', ['/api/users']],
      ['fetch', 'GET', '/api/users/${id}', ['/api/users/:id']],
      ['axios', 'POST', '/api/users', ['/api/users']],
      // `api` is an axios instance with `baseURL: '/api'`.
      ['axios', 'GET', '/api/users/${id}', ['/api/users/:id']],
      ['fetch', 'GET', '${process.env.API_URL}/users', ['/api/users']],
      ['fetch', 'GET', 'https://api.stripe.com/v1/charges', []],
      // Imported client instance: its base URL is in another file, so the path is matched as a suffix.
      ['api', 'GET', '/users', ['/api/users']],
    ]);
    expect(find(result.endpoints, 'GET', '/api/users').usage).toEqual({ calls: 3, tests: 0 });
    expect(find(result.endpoints, 'GET', '/api/reports').usage).toEqual({ calls: 0, tests: 0 });
    expect(issues(result, 'broken-call')).toEqual([]);
    const call = result.clientCalls.find((c) => c.url === '/api/users' && c.method === 'POST')!;
    expect(path.basename(call.location.file)).toBe('api.ts');
    expect(call.range.start.line).toBe(6);
  });

  it('reports calls no route accepts, with a hint for the wrong method', async () => {
    const { result } = await analyzeFiles({
      ...backend,
      'web/package.json': '{}',
      'web/src/a.js': `fetch('/api/userz');\nfetch('/api/users/1', { method: 'DELETE' });\nfetch('/totally/elsewhere');\nfetch(url);`,
    });
    expect(issues(result, 'broken-call')).toEqual([
      'No route matches GET /api/userz (fetch, a.js:1).',
      'No route matches DELETE /api/users/1 (fetch, a.js:2). Routes with this path exist for GET.',
    ]);
  });

  it('counts supertest, Nest e2e and MockMvc requests as tests', async () => {
    const { result } = await analyzeFiles({
      ...backend,
      'server/test/users.test.js': `const request = require('supertest');\nconst app = require('../src/app');\nconst t = require('express')();\nt.get('/only-in-tests', (q, s) => s.end());\nit('lists', () => request(app).get('/api/users').expect(200));\nit('gets', () => request(app).get('/api/users/7'));`,
      'pom.xml': '<project/>',
      'src/main/java/a/C.java': `package a;\nimport org.springframework.web.bind.annotation.*;\n@RestController @RequestMapping("/items")\npublic class C {\n  @GetMapping("/{id}") public String one() { return ""; }\n  @PostMapping public void add(@RequestBody @Valid Item item) {}\n}`,
      'src/test/java/a/CTest.java': `package a;\nimport static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;\nclass CTest {\n  void t() throws Exception { mvc.perform(get("/items/" + 5)).andExpect(status().isOk()); mvc.perform(post("/items").content("{}")); }\n}`,
    });
    expect(routes(result.endpoints)).not.toContain('GET /only-in-tests');
    expect(find(result.endpoints, 'GET', '/api/users').usage).toEqual({ calls: 0, tests: 1 });
    expect(find(result.endpoints, 'GET', '/api/users/:id').usage).toEqual({ calls: 0, tests: 1 });
    expect(find(result.endpoints, 'GET', '/items/{id}').usage?.tests).toBe(1);
    expect(find(result.endpoints, 'POST', '/items').usage?.tests).toBe(1);
    expect(result.clientCalls.filter((c) => c.kind === 'test').map((c) => c.client).sort()).toEqual(['MockMvc', 'MockMvc', 'supertest', 'supertest']);
  });

  it('can report endpoints nothing calls', async () => {
    const { result } = await analyzeFiles({ ...backend, 'web/package.json': '{}', 'web/a.js': `fetch('/api/users');` }, { clientCalls: { enabled: true, reportUncalled: true } });
    expect(issues(result, 'uncalled')).toEqual(['GET /api/users/:id is not called from any code in the workspace.', 'POST /api/users is not called from any code in the workspace.', 'GET /api/reports is not called from any code in the workspace.']);
  });

  it('does not mistake route registrations for client calls', async () => {
    const { result } = await analyzeFiles({
      'src/app.js': `const express = require('express');\nconst app = express();\nconst api = require('./api');\napi.get('/x', handler);\napp.get('/y', (req, res) => res.end());`,
      'src/api.js': express(''),
    });
    expect(result.clientCalls).toEqual([]);
  });
});

describe('Request body validation', () => {
  it('recognises validation middleware, handler schema checks, Nest pipes and @Valid', async () => {
    const { result } = await analyzeFiles({
      'src/app.js': `const express = require('express');\nconst { celebrate } = require('celebrate');\nconst app = express();\napp.post('/a', validate(schemaA), (req, res) => res.end());\napp.post('/b', celebrate({}), h);\napp.post('/c', (req, res) => { const data = schema.parse(req.body); res.json(data); });\napp.put('/d', (req, res) => res.json(req.body));\napp.get('/e', (req, res) => res.end());`,
    });
    expect(find(result.endpoints, 'POST', '/a').validation?.status).toBe('validated');
    expect(find(result.endpoints, 'POST', '/b').validation?.status).toBe('validated');
    expect(find(result.endpoints, 'POST', '/c').validation).toEqual({ status: 'validated', via: ['schema check in handler'] });
    expect(find(result.endpoints, 'PUT', '/d').validation?.status).toBe('missing');
    expect(find(result.endpoints, 'GET', '/e').validation).toBeUndefined();
    expect(issues(result, 'no-validation')).toEqual([expect.stringMatching(/^The request body of PUT \/d \(app\.js:7\) is not validated/)]);
  });

  it('handles NestJS global and parameter pipes, and untyped bodies', async () => {
    const { result } = await analyzeFiles({
      'src/main.ts': `import { NestFactory } from '@nestjs/core';\nimport { ValidationPipe } from '@nestjs/common';\nasync function b() { const app = await NestFactory.create({}); app.useGlobalPipes(new ValidationPipe()); }`,
      'src/cats.controller.ts': `import { Body, Controller, Post, Put } from '@nestjs/common';\n@Controller('cats')\nexport class CatsController {\n  @Post() create(@Body() dto: CreateCatDto) {}\n  @Put() replace(@Body() body: any) {}\n}`,
    });
    expect(find(result.endpoints, 'POST', '/cats').validation?.status).toBe('validated');
    expect(find(result.endpoints, 'POST', '/cats').middleware).toEqual(['useGlobalPipes(ValidationPipe)']);
    expect(issues(result, 'no-validation')).toEqual([expect.stringMatching(/PUT \/cats .* has a ValidationPipe, but its body has no DTO class/)]);
  });

  it('reads @Valid on Spring request bodies', async () => {
    const { result } = await analyzeFiles({
      'pom.xml': '<project/>',
      'src/main/java/a/C.java': `package a;\nimport org.springframework.web.bind.annotation.*;\n@RestController\npublic class C {\n  @PostMapping("/a") public void a(@Valid @RequestBody A a) {}\n  @PostMapping("/b") public void b(@RequestBody B b) {}\n}`,
    });
    expect(find(result.endpoints, 'POST', '/a').validation).toEqual({ status: 'validated', via: ['@Valid'] });
    expect(issues(result, 'no-validation')).toEqual([expect.stringMatching(/^The request body of POST \/b/)]);
  });
});
