import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { AnalysisEngine } from '../../src/core/engine';
import { engineOptions, FIXTURES, NodeFileHost } from '../helpers/nodeHost';

/** All fixture projects in one workspace: a React frontend calling Express, NestJS and Spring backends. */
describe('Full-stack fixture workspace', async () => {
  const result = await new AnalysisEngine(new NodeFileHost(FIXTURES), engineOptions(FIXTURES)).analyze();
  const messages = (kind: string): string[] => result.issues.filter((i) => i.kind === kind).map((i) => i.message);
  const pathOf = (id: string): string => result.endpoints.find((e) => e.id === id)!.path;

  it('links frontend calls to the backends', () => {
    const app = result.clientCalls.filter((c) => c.kind === 'app').map((c) => [path.relative(FIXTURES, c.location.file), c.method, c.url, c.endpointIds.map(pathOf).sort()]);
    expect(app).toEqual([
      ['web-app/src/api/client.ts', 'GET', '/api/v1/users/${id}', ['/api/v1/users/:id']],
      ['web-app/src/api/client.ts', 'POST', '/api/v1/users', ['/api/v1/users']],
      ['web-app/src/api/client.ts', 'GET', 'http://localhost:8080/shop/api/v1/products/search?q=${encodeURIComponent()}', ['/shop/api/v1/products/search']],
      ['web-app/src/api/client.ts', 'GET', 'http://localhost:8080/shop/api/v1/products/${id}', ['/shop/api/v1/products/{id}', '/shop/api/v1/products/{productId}']],
      ['web-app/src/pages/Orders.tsx', 'GET', '/api/orders', ['/api/orders']],
      ['web-app/src/pages/Orders.tsx', 'GET', '/api/order', []],
    ]);
    expect(messages('broken-call')).toEqual(['No route matches GET /api/order (fetch, Orders.tsx:9).']);
  });

  it('counts tests from supertest, Nest e2e specs and MockMvc', () => {
    const tested = result.endpoints.filter((e) => (e.usage?.tests ?? 0) > 0).map((e) => `${e.method} ${e.path}`).sort();
    expect(tested).toEqual(['GET /api/v1/users', 'GET /shop/api/v1/products', 'GET /users', 'GET /users/:id', 'GET /users/:userId']);
  });

  it('finds the unreachable route and keeps test-only controllers out', () => {
    expect(messages('unreachable')).toEqual(['GET /users/me is unreachable: GET /users/:id (users.js:8) is registered first and matches every request it would get. Declare it before that route.']);
    expect(result.endpoints.filter((e) => path.relative(FIXTURES, e.location.file).split(path.sep).includes('test')).map((e) => e.path)).toEqual([]);
  });
});
