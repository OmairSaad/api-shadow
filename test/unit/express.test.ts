import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { analyzeFixture } from '../helpers/nodeHost';
import { analyzeFiles, find, routes } from '../helpers/memoryHost';

describe('Express fixture project', async () => {
  const { root, result } = await analyzeFixture('express-app');
  const express = result.endpoints.filter((e) => e.framework === 'express');

  it('discovers every endpoint with prefixes from nested routers', () => {
    expect(routes(express)).toEqual(
      [
        'GET /',
        'GET /${config.customPath}',
        'GET /broken-but-parsed',
        'DELETE /admin/cache',
        'GET /admin/stats',
        'GET /api/orders',
        'POST /api/orders',
        'GET /api/products',
        'GET /api/products/:productId(\\d+)',
        'GET /api/products ~ /^\\/legacy-.*$/',
        'GET /api/products/featured',
        'GET /api/products/top',
        'GET /health',
        'GET /health/ready',
        'GET /users',
        'POST /users',
        'GET /users/:id',
        'PUT /users/:id/avatar',
        'DELETE /users/:id/avatar',
        'GET /users/:userId',
      ].sort(),
    );
  });

  it('never analyses node_modules', () => {
    expect(express.some((e) => e.location.file.includes('node_modules'))).toBe(false);
  });

  it('records source location of the route declaration', () => {
    const e = find(express, 'POST', '/users');
    expect(path.relative(root, e.location.file)).toBe(path.join('src', 'routes', 'users.js'));
    expect(e.location.line).toBe(9);
  });

  it('accumulates app, mount and route middleware in order', () => {
    expect(find(express, 'POST', '/users').middleware).toEqual(['helmet()', 'express.json()', 'authenticate', 'validate()']);
    expect(find(express, 'GET', '/admin/stats').middleware).toEqual(['helmet()', 'express.json()', 'authenticate', 'requireAdmin']);
  });

  it('resolves controller handlers across files and their service calls', () => {
    const e = find(express, 'GET', '/users/:id');
    expect(e.handler).toBe('userController.getById');
    expect(e.controller).toBe('userController');
    expect(path.basename(e.handlerLocation!.file)).toBe('userController.js');
    expect(e.handlerLocation!.line).toBe(7);
    expect(e.services.map((s) => s.name)).toEqual(['userService.findById']);
    expect(path.basename(e.services[0].location!.file)).toBe('userService.js');
    expect(e.services[0].location!.line).toBe(5);
  });

  it('resolves class-instance services used in inline handlers', () => {
    const e = find(express, 'GET', '/api/products');
    expect(e.services.map((s) => s.name)).toEqual(['ProductService.list']);
    expect(path.basename(e.services[0].location!.file)).toBe('product.service.ts');
  });

  it('follows router factories and router parameters', () => {
    expect(find(express, 'POST', '/api/orders').handler).toBe('createOrder');
    expect(find(express, 'GET', '/health').notes.join(' ')).toMatch(/Registered via function call/);
  });

  it('flags dynamic and regex paths as non-static', () => {
    expect(find(express, 'GET', '/${config.customPath}').pathIsStatic).toBe(false);
    expect(find(express, 'GET', '/api/products ~ /^\\/legacy-.*$/').pathIsStatic).toBe(false);
    expect(find(express, 'GET', '/users').pathIsStatic).toBe(true);
  });

  it('reports duplicate routes and unparsable files', () => {
    const dup = result.duplicates.find((d) => d.method === 'GET' && d.path.startsWith('/users/'));
    expect(dup?.endpointIds).toHaveLength(2);
    const parse = result.issues.find((i) => i.kind === 'parse-error');
    expect(parse && path.basename(parse.location!.file)).toBe('broken.js');
    expect(parse?.message).toMatch(/Ignored line\(s\) 6, 8/);
    // The recovered router is not mounted anywhere, so it is reported and shown relative.
    expect(find(express, 'GET', '/broken-but-parsed').notes.join()).toMatch(/Mount point not found/);
  });
});

describe('Express patterns', () => {
  it('handles ESM named imports, barrel re-exports and typed router parameters', async () => {
    const { result } = await analyzeFiles({
      'src/server.ts': `
        import express from 'express';
        import { v1 } from './routes';
        import registerAdmin from './admin';
        const app = express();
        app.use('/v1', v1);
        registerAdmin(app);
      `,
      'src/routes/index.ts': `export { default as v1 } from './v1';`,
      'src/routes/v1.ts': `
        import { Router } from 'express';
        const r = Router();
        r.get('/items', (req, res) => res.json([]));
        export default r;
      `,
      'src/admin.ts': `
        import type { Express } from 'express';
        export default function (server: Express) {
          server.post('/admin/login', (req, res) => res.end());
        }
      `,
    });
    expect(routes(result.endpoints)).toEqual(['GET /v1/items', 'POST /admin/login']);
  });

  it('supports class-based servers using this.app', async () => {
    const { result } = await analyzeFiles({
      'src/App.ts': `
        import express from 'express';
        import { userRoutes } from './users';
        class App {
          public app = express();
          constructor() { this.routes(); }
          private routes() { this.app.use('/api/users', userRoutes); }
        }
        export default new App().app;
      `,
      'src/users.ts': `
        import { Router } from 'express';
        export const userRoutes = Router();
        userRoutes.get('/:id', (req, res) => res.end());
      `,
    });
    expect(routes(result.endpoints)).toEqual(['GET /api/users/:id']);
  });

  it('resolves string constants, template literals and constant objects', async () => {
    const { result } = await analyzeFiles({
      'app.js': `
        const express = require('express');
        const app = express();
        const BASE = '/api';
        const ROUTES = { USERS: '/users' };
        app.get(BASE + ROUTES.USERS, (req, res) => res.end());
        app.get(\`\${BASE}/health\`, (req, res) => res.end());
      `,
    });
    expect(routes(result.endpoints)).toEqual(['GET /api/health', 'GET /api/users']);
    expect(result.endpoints.every((e) => e.pathIsStatic)).toBe(true);
  });

  it('does not treat HTTP clients or maps as routers', async () => {
    const { result } = await analyzeFiles({
      'client.js': `
        const axios = require('axios');
        const cache = new Map();
        axios.get('/users', { params: {} });
        cache.get('/users', 1);
        fetchWrapper.post('/x', {});
      `,
    });
    expect(result.endpoints).toEqual([]);
  });

  it('reports routers that are never mounted and shows them relative', async () => {
    const { result } = await analyzeFiles({
      'orphan.js': `
        const router = require('express').Router();
        router.get('/lonely', (req, res) => res.end());
        module.exports = router;
      `,
    });
    expect(routes(result.endpoints)).toEqual(['GET /lonely']);
    expect(result.endpoints[0].notes.join()).toMatch(/Mount point not found/);
    expect(result.issues.some((i) => /not mounted/.test(i.message))).toBe(true);
  });

  it('detects circular mounts without hanging', async () => {
    const { result } = await analyzeFiles({
      'app.js': `
        const express = require('express');
        const app = express();
        const a = express.Router();
        const b = express.Router();
        a.use('/b', b);
        b.use('/a', a);
        app.use('/a', a);
        b.get('/leaf', (req, res) => res.end());
      `,
    });
    expect(routes(result.endpoints)).toContain('GET /a/b/leaf');
    expect(result.issues.some((i) => /Circular/.test(i.message))).toBe(true);
  });

  it('recovers from syntax errors where possible', async () => {
    const { result } = await analyzeFiles({
      'app.js': `
        const express = require('express');
        const app = express();
        app.get('/ok', (req, res) => res.end());
        let x = ;
      `,
    });
    expect(routes(result.endpoints)).toEqual(['GET /ok']);
    expect(result.issues.some((i) => i.kind === 'parse-error')).toBe(true);
  });

  it('applies router-level middleware only to later routes', async () => {
    const { result } = await analyzeFiles({
      'app.js': `
        const express = require('express');
        const router = express.Router();
        const app = express();
        router.get('/public', (req, res) => res.end());
        router.use(requireAuth);
        router.get('/private', (req, res) => res.end());
        app.use('/x', router);
      `,
    });
    expect(find(result.endpoints, 'GET', '/x/public').middleware).toEqual([]);
    expect(find(result.endpoints, 'GET', '/x/private').middleware).toEqual(['requireAuth']);
  });

  it('warns when a mounted module cannot be resolved', async () => {
    const { result } = await analyzeFiles({
      'app.js': `
        const express = require('express');
        const app = express();
        app.use('/missing', require('./does-not-exist'));
      `,
    });
    expect(result.issues.some((i) => /Could not resolve module/.test(i.message))).toBe(true);
  });

  it('handles app.route chains and arrays of handlers', async () => {
    const { result } = await analyzeFiles({
      'app.js': `
        const express = require('express');
        const app = express();
        app.route('/book').get(getBook).post([auth, validate], addBook).all(log);
        function getBook() {}
        function addBook() {}
      `,
    });
    expect(routes(result.endpoints)).toEqual(['ALL /book', 'GET /book', 'POST /book']);
    expect(find(result.endpoints, 'POST', '/book').middleware).toEqual(['auth', 'validate']);
    expect(find(result.endpoints, 'GET', '/book').handlerLocation?.line).toBe(5);
  });

  it('follows chained use() calls on inline routers (RealWorld example pattern)', async () => {
    const { result } = await analyzeFiles({
      'src/main.ts': `
        import express from 'express';
        import routes from './routes';
        const app = express();
        app.use(routes);
      `,
      'src/routes.ts': `
        import { Router } from 'express';
        import tags from './tags';
        import users from './users';
        const api = Router().use(tags).use(users);
        export default Router().use('/api', api);
      `,
      'src/tags.ts': `
        import { Router } from 'express';
        const router = Router();
        router.get('/tags', (req, res) => res.end()).post('/tags', (req, res) => res.end());
        export default router;
      `,
      'src/users.ts': `
        import { Router } from 'express';
        export default Router().get('/users', (req, res) => res.end());
      `,
    });
    expect(routes(result.endpoints)).toEqual(['GET /api/tags', 'GET /api/users', 'POST /api/tags']);
    expect(result.issues).toEqual([]);
  });

  it('links directly called functions imported from service modules', async () => {
    const { result } = await analyzeFiles({
      'src/app.ts': `
        import express from 'express';
        import getTags from './tag.service';
        import { formatDate } from './utils';
        const app = express();
        app.get('/tags', async (req, res) => res.json(await getTags(formatDate())));
      `,
      'src/tag.service.ts': `export default async function getTags() { return []; }`,
      'src/utils.ts': `export const formatDate = () => '';`,
    });
    const e = result.endpoints[0];
    expect(e.services.map((s) => s.name)).toEqual(['tag.service.getTags']);
    expect(e.services[0].location?.file.endsWith('tag.service.ts')).toBe(true);
  });
});
