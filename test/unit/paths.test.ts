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
  it('treats parameters of any syntax as equal', () => {
    expect(normalizeForComparison('/users/:id')).toBe(normalizeForComparison('/users/{userId}'));
    expect(normalizeForComparison('/users/{id:\\d+}')).toBe('/users/{}');
    expect(normalizeForComparison('/users/:id(\\d+)')).toBe('/users/{}');
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
