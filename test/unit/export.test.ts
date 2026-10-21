import * as path from 'path';
import SwaggerParser from '@apidevtools/swagger-parser';
import { describe, expect, it } from 'vitest';
import { toMarkdown } from '../../src/export/markdown';
import { toOpenApi } from '../../src/export/openapi';
import type { AnalysisResult } from '../../src/core/types';
import { analyzeFixture } from '../helpers/nodeHost';

async function all(): Promise<{ result: AnalysisResult; rel: (f: string) => string }> {
  const parts = await Promise.all(['express-app', 'nest-app', 'spring-app'].map((f) => analyzeFixture(f)));
  const result: AnalysisResult = {
    endpoints: parts.flatMap((p) => p.result.endpoints),
    issues: parts.flatMap((p) => p.result.issues),
    duplicates: parts.flatMap((p) => p.result.duplicates),
    security: parts.flatMap((p) => p.result.security),
    servers: parts.flatMap((p) => p.result.servers),
    clientCalls: parts.flatMap((p) => p.result.clientCalls),
    stats: parts[0].result.stats,
  };
  const fixtures = path.dirname(parts[0].root);
  return { result, rel: (f) => path.relative(fixtures, f).split(path.sep).join('/') };
}

describe('OpenAPI export', async () => {
  const { result, rel } = await all();
  const doc = toOpenApi(result, { title: 'Fixtures', relativePath: rel });

  it('produces a document that validates against the OpenAPI 3.0 schema', async () => {
    await expect(SwaggerParser.validate(JSON.parse(JSON.stringify(doc)))).resolves.toBeTruthy();
  });

  it('converts parameters and request bodies without inventing schemas, and marks inferred responses', () => {
    const op = doc.paths['/api/v1/users/{id}'].get;
    expect(op.parameters).toEqual([{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]);
    const product = doc.paths['/shop/api/v1/products/{id}'].get;
    expect(product.parameters).toEqual([{ name: 'id', in: 'path', required: true, schema: { type: 'integer', format: 'int64' } }]);
    const post = doc.paths['/shop/api/v1/products'].post;
    expect(post.requestBody).toMatchObject({ description: expect.stringContaining('ProductDto'), content: { 'application/json': { schema: {} } } });
    // The declared return type gives an inferred, clearly marked response; nothing else is added.
    expect(Object.keys(post.responses)).toEqual(['200', 'default']);
    expect(post.responses['200']).toMatchObject({ 'x-api-shadow-inferred': true, description: expect.stringContaining('ProductDto'), content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } });
    expect(doc.paths['/api/products/{productId}'].get.parameters).toEqual([{ name: 'productId', in: 'path', required: true, schema: { type: 'string', pattern: '\\d+' } }]);
  });

  it('skips what cannot be represented and explains why', () => {
    const skipped = doc['x-api-shadow'].skipped;
    const reasons = Object.fromEntries(skipped.map((s) => [`${s.method} ${s.path}`, s.reason]));
    expect(reasons['GET /${config.customPath}']).toMatch(/statically/);
    expect(reasons['ALL /shop/api/v1/products/legacy']).toMatch(/all HTTP methods/);
    expect(reasons['GET /users/:userId']).toMatch(/duplicate/);
    expect(doc['x-api-shadow'].included + skipped.length).toBe(result.endpoints.length);
  });

  it('includes source locations only when asked', () => {
    expect(doc.paths['/users'].get['x-api-shadow']?.source).toBe('express-app/src/routes/users.js:7');
    const noLoc = toOpenApi(result, { title: 'x', relativePath: rel, includeSourceLocations: false });
    expect(JSON.stringify(noLoc)).not.toContain('users.js');
  });

  it('has unique operation ids', () => {
    const ids = Object.values(doc.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('Markdown export', async () => {
  const { result, rel } = await all();
  const md = toMarkdown(result, { title: 'Fixture APIs', relativePath: rel });

  it('lists endpoints grouped by controller with locations', () => {
    expect(md).toMatch(/^# Fixture APIs/);
    expect(md).toContain('## UsersController (nestjs)');
    expect(md).toContain('| POST | `/api/v1/users` | `create` | `UseGuards(AuthGuard)`, `UseGuards(RolesGuard)` | `UsersService.create` | nest-app/src/users/users.controller.ts:22 |');
    expect(md).toContain('## Potential duplicate routes');
    expect(md).toContain('## Analysis notes and limitations');
  });

  it('escapes table-breaking characters', () => {
    const e = { ...result.endpoints[0], handler: 'a|b', middleware: [] };
    const out = toMarkdown({ ...result, endpoints: [e], duplicates: [], issues: [] }, { title: 't', relativePath: rel });
    expect(out).toContain('`a\\|b`');
  });
});

describe('Secrets', async () => {
  const { result, rel } = await all();
  it('never leak configuration values into results or exports', () => {
    const blobs = [JSON.stringify(result), toMarkdown(result, { title: 't', relativePath: rel }), JSON.stringify(toOpenApi(result, { title: 't', relativePath: rel }))];
    for (const blob of blobs) {
      expect(blob).not.toContain('SUPER_SECRET_DO_NOT_LEAK');
      expect(blob).not.toContain('jdbc:postgresql');
    }
  });
});
