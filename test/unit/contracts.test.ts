import { describe, expect, it } from 'vitest';
import { contractDiffToMarkdown, contractDrift, ContractError, diffContracts, looksLikeOpenApi, normalizePath, parseContract } from '../../src/core/contracts';

const v1 = {
  openapi: '3.0.3',
  info: { title: 'Shop', version: '1.0.0' },
  security: [{ bearer: [] }],
  paths: {
    '/products/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        operationId: 'getProduct',
        security: [],
        parameters: [{ name: 'expand', in: 'query', schema: { type: 'string' } }],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } } }, '404': { description: 'missing' } },
      },
    },
    '/products': {
      post: {
        operationId: 'createProduct',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NewProduct' } } } },
        responses: { '201': { description: 'created' } },
      },
    },
    '/legacy': { get: { operationId: 'legacy', responses: { '200': { description: 'ok' } } } },
    '/status': { get: { operationId: 'status', responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { state: { type: 'string', enum: ['up', 'down'] } } } } } } } } },
  },
  components: {
    schemas: {
      Base: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      Product: { allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', properties: { price: { type: 'number' }, stock: { type: 'integer' }, name: { type: 'string' } }, required: ['name'] }] },
      NewProduct: { type: 'object', properties: { name: { type: 'string' }, note: { type: 'string' } }, required: ['name'] },
    },
  },
};

function v2(): typeof v1 {
  const d = JSON.parse(JSON.stringify(v1)) as typeof v1;
  const product = d.components.schemas.Product.allOf[1] as { properties: Record<string, unknown>; required: string[] };
  delete product.properties.price; // removed response field
  product.properties.stock = { type: 'string' }; // type change
  product.properties.rating = { type: 'number' }; // added response field
  (d.components.schemas.NewProduct as { required: string[]; properties: Record<string, unknown> }).required.push('sku'); // newly required request field
  (d.components.schemas.NewProduct as { properties: Record<string, unknown> }).properties.sku = { type: 'string' };
  (d.components.schemas.NewProduct as { properties: Record<string, unknown> }).properties.tags = { type: 'array', items: { type: 'string' } }; // optional request field
  (d.paths['/products/{id}'].get as { security?: unknown }).security = undefined; // inherits global bearer: auth now required
  delete (d.paths as Record<string, unknown>)['/legacy']; // removed endpoint
  (d.paths['/status'].get.responses['200'].content['application/json'].schema.properties.state as { enum: string[] }).enum.push('degraded');
  return d;
}

describe('OpenAPI contracts', () => {
  it('parses JSON and YAML, resolves $ref and allOf, and normalises paths', () => {
    const json = parseContract(JSON.stringify(v1), 'v1.json');
    const yaml = parseContract(`openapi: "3.1.0"\ninfo:\n  title: T\n  version: "2"\npaths:\n  /users/{userId}:\n    get:\n      responses:\n        "200":\n          description: ok\n          content:\n            application/json:\n              schema:\n                type: [object, "null"]\n                properties:\n                  name: { type: string }\n`, 'v.yaml');
    expect([...json.operations.keys()].sort()).toEqual(['GET /legacy', 'GET /products/{}', 'GET /status', 'POST /products']);
    const get = json.operations.get('GET /products/{}')!;
    expect(get.secured).toBe(false);
    expect(get.parameters.map((p) => `${p.in}:${p.name}:${p.required}`)).toEqual(['path:id:true', 'query:expand:false']);
    expect(Object.keys(get.responses['200'].schema!.properties!)).toEqual(['id', 'price', 'stock', 'name']);
    expect(get.responses['200'].schema!.required).toEqual(['id', 'name']);
    expect(json.operations.get('POST /products')!.secured).toBe(true);
    expect(yaml.operations.get('GET /users/{}')!.responses['200'].schema).toMatchObject({ type: 'object', nullable: true });
    expect(normalizePath('/a/{x}/b/')).toBe('/a/{}/b');
  });

  it('classifies changes as breaking, potentially breaking, non-breaking and informational', () => {
    const diff = diffContracts(parseContract(JSON.stringify(v1)), parseContract(JSON.stringify(v2())));
    const lines = diff.changes.map((c) => `${c.severity} | ${c.display} | ${c.text}`);
    expect(lines).toEqual(
      expect.arrayContaining([
        'breaking | GET /legacy | Removed',
        'breaking | GET /products/{id} | Authentication is now required',
        'breaking | GET /products/{id} | 200 response field `price` removed',
        'breaking | GET /products/{id} | 200 response field `stock` changed type: integer → string',
        'breaking | POST /products | New required request field `sku`',
        'non-breaking | GET /products/{id} | 200 response field `rating` added',
        'non-breaking | POST /products | New optional request field `tags`',
        "potentially-breaking | GET /status | 200 response field `state`: enum value(s) \"degraded\" added; clients may not handle them",
      ]),
    );
    expect(diff.counts.breaking).toBe(5);
    const md = contractDiffToMarkdown(diff, 'main', 'working tree', 'openapi.json');
    expect(md).toContain('Compatibility: **Breaking**');
    expect(md).toContain('## GET /products/{id}');
  });

  it('detects moved operations by operationId and newly required parameters', () => {
    const b = JSON.parse(JSON.stringify(v1)) as typeof v1;
    (b.paths as Record<string, unknown>)['/items/{id}'] = b.paths['/products/{id}'];
    delete (b.paths as Record<string, unknown>)['/products/{id}'];
    (b.paths['/items/{id}' as '/products/{id}'].get.parameters[0] as { required?: boolean }).required = true;
    const diff = diffContracts(parseContract(JSON.stringify(v1)), parseContract(JSON.stringify(b)));
    expect(diff.changes.map((c) => `${c.severity}: ${c.text}`)).toEqual(expect.arrayContaining(['breaking: Moved from GET /products/{id} to GET /items/{id} (operationId getProduct)', 'breaking: Query parameter `expand` is now required']));
    expect(diff.changes.some((c) => c.text === 'Removed' || c.text === 'Added')).toBe(false);
  });

  it('reports identical documents as compatible', () => {
    const diff = diffContracts(parseContract(JSON.stringify(v1)), parseContract(JSON.stringify(v1)));
    expect(diff.changes).toEqual([]);
    expect(contractDiffToMarkdown(diff, 'a', 'b')).toContain('No differences');
  });

  it('rejects Swagger 2, invalid documents and missing versions with clear messages', () => {
    expect(() => parseContract('{"swagger":"2.0","paths":{}}', 'old.json')).toThrow(ContractError);
    expect(() => parseContract('{"swagger":"2.0","paths":{}}', 'old.json')).toThrow(/only OpenAPI 3\.x/);
    expect(() => parseContract('{ not json', 'bad.json')).toThrow(/not valid JSON/);
    expect(() => parseContract('title: x\n', 'x.yaml')).toThrow(/no "openapi: 3.x"/);
    expect(looksLikeOpenApi('openapi: 3.0.0\n')).toBe(true);
    expect(looksLikeOpenApi('{"name":"pkg"}')).toBe(false);
  });

  it('records unresolved and remote references instead of fetching them', () => {
    const doc = { openapi: '3.0.0', info: { title: 't', version: '1' }, paths: { '/x': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: 'https://example.com/schema.json' } } } } } } } } };
    expect(parseContract(JSON.stringify(doc)).unresolved).toEqual(['https://example.com/schema.json']);
  });

  it('compares a contract with the implementation found in code', () => {
    const drift = contractDrift(parseContract(JSON.stringify(v1)), [
      { method: 'GET', path: '/products/{productId}', label: 'GET /products/:productId' },
      { method: 'POST', path: '/products', label: 'POST /products' },
      { method: 'DELETE', path: '/products/{id}', label: 'DELETE /products/:id' },
    ]);
    expect(drift.changes.map((c) => `${c.severity}: ${c.display}`).sort()).toEqual(['breaking: GET /legacy', 'breaking: GET /status', 'info: DELETE /products/:id']);
  });
});
