import { describe, expect, it } from 'vitest';
import { joinUrlPaths, normalizeForComparison, toOpenApiPath } from '../../src/core/paths';

describe('joinUrlPaths', () => {
  it('collapses slashes and drops trailing slash', () => {
    expect(joinUrlPaths('/api/', '/users/', '')).toBe('/api/users');
    expect(joinUrlPaths('', '/')).toBe('/');
    expect(joinUrlPaths('api', 'v1', ':id')).toBe('/api/v1/:id');
  });
});

describe('normalizeForComparison', () => {
  it('ignores parameter names in each framework\'s syntax', () => {
    expect(normalizeForComparison('/users/:id')).toBe('/users/{}');
    expect(normalizeForComparison('/users/:userId')).toBe('/users/{}');
    expect(normalizeForComparison('/users/{userId}', 'spring')).toBe('/users/{}');
    expect(normalizeForComparison('/files/{*rest}', 'spring')).toBe('/files/{*}');
    expect(normalizeForComparison('/u/:id?')).toBe('/u/{}?');
  });

  it('keeps regex constraints, which make routes match different requests', () => {
    expect(normalizeForComparison('/users/:id(\\d+)')).toBe('/users/{\\d+}');
    expect(normalizeForComparison('/users/{id:\\d+}', 'spring')).toBe('/users/{\\d+}');
    expect(normalizeForComparison('/users/:id(\\d+)')).not.toBe(normalizeForComparison('/users/:slug'));
  });

  it('treats a colon as literal text in Spring paths', () => {
    expect(normalizeForComparison('/v1/users:batchGet', 'spring')).not.toBe(normalizeForComparison('/v1/users:batchDelete', 'spring'));
  });

  it('never treats unresolved expressions as wildcards', () => {
    expect(normalizeForComparison('/${config.base}')).toBe('/${config.base}');
    expect(normalizeForComparison('/${ROUTES.SHOPIFY}')).not.toBe(normalizeForComparison('/${ROUTES.INTERNAL}'));
    expect(normalizeForComparison('/${API_BASE}/call/shopify', 'spring')).not.toBe(normalizeForComparison('/${API_BASE}/call/internalroute', 'spring'));
  });
});

describe('toOpenApiPath', () => {
  it('converts express params, including regex constraints', () => {
    expect(toOpenApiPath('/users/:id')).toEqual({ path: '/users/{id}', pathParams: [{ name: 'id', pattern: undefined }] });
    expect(toOpenApiPath('/p/:productId(\\d+)')).toEqual({ path: '/p/{productId}', pathParams: [{ name: 'productId', pattern: '\\d+' }] });
    expect(toOpenApiPath('/files/:name.:ext').path).toBe('/files/{name}.{ext}');
  });

  it('converts spring templates', () => {
    expect(toOpenApiPath('/a/{id}/b/{slug:[a-z]+}')).toEqual({
      path: '/a/{id}/b/{slug}',
      pathParams: [
        { name: 'id', pattern: undefined },
        { name: 'slug', pattern: '[a-z]+' },
      ],
    });
  });

  it('rejects what OpenAPI cannot express', () => {
    expect(toOpenApiPath('/users/:id?').unsupportedReason).toMatch(/optional/);
    expect(toOpenApiPath('/static/*').unsupportedReason).toMatch(/wildcard/);
    expect(toOpenApiPath('/files/**').unsupportedReason).toMatch(/wildcard/);
    expect(toOpenApiPath('/ab?cd').unsupportedReason).toBeDefined();
  });

  it('keeps the root path', () => {
    expect(toOpenApiPath('/').path).toBe('/');
  });
});
