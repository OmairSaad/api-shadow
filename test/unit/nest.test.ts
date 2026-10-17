import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { analyzeFixture } from '../helpers/nodeHost';
import { analyzeFiles, find, routes } from '../helpers/memoryHost';

describe('NestJS fixture project', async () => {
  const { result } = await analyzeFixture('nest-app');
  const nest = result.endpoints;

  it('applies global prefix (with exclude), URI versioning and RouterModule prefixes', () => {
    expect(routes(nest)).toEqual(
      [
        'GET /health',
        'GET /api/v1/users',
        'GET /api/v1/users/:id',
        'POST /api/v1/users',
        'PATCH /api/v1/users/:id',
        'DELETE /api/v2/users/:id',
        'GET /api/admin/reports/stats',
        'GET /api/admin/reports/statistics',
      ].sort(),
    );
    expect(nest.every((e) => e.framework === 'nestjs')).toBe(true);
  });

  it('records controller, handler, guards and parameters', () => {
    const create = find(nest, 'POST', '/api/v1/users');
    expect(create.controller).toBe('UsersController');
    expect(create.handler).toBe('create');
    expect(create.middleware).toEqual(['UseGuards(AuthGuard)', 'UseGuards(RolesGuard)']);
    expect(create.requestBodyType).toBe('CreateUserDto');
    expect(find(nest, 'GET', '/api/v1/users').parameters).toEqual([{ name: 'page', in: 'query', required: false, type: 'number' }]);
    expect(find(nest, 'GET', '/api/admin/reports/stats').parameters).toEqual([{ name: 'x-tenant', in: 'header', required: true, type: 'string' }]);
  });

  it('links injected services to their declarations', () => {
    const e = find(nest, 'GET', '/api/v1/users/:id');
    expect(e.services).toHaveLength(1);
    expect(e.services[0].name).toBe('UsersService.findOne');
    expect(path.basename(e.services[0].location!.file)).toBe('users.service.ts');
    expect(e.services[0].location!.line).toBe(10);
  });

  it('points at the HTTP decorator line', () => {
    const e = find(nest, 'GET', '/health');
    expect(path.basename(e.location.file)).toBe('health.controller.ts');
    expect(e.location.line).toBe(5);
  });
});

describe('NestJS patterns', () => {
  it('supports array paths, @All, no global prefix and aliased imports', async () => {
    const { result } = await analyzeFiles({
      'src/cats.controller.ts': `
        import { Controller as C, Get, All } from '@nestjs/common';
        @C(['cats', 'kittens'])
        export class CatsController {
          @Get(['', 'list']) list() {}
          @All('any') any() {}
        }
      `,
    });
    expect(routes(result.endpoints)).toEqual(['ALL /cats/any', 'ALL /kittens/any', 'GET /cats', 'GET /cats/list', 'GET /kittens', 'GET /kittens/list']);
  });

  it('ignores decorators that do not come from @nestjs', async () => {
    const { result } = await analyzeFiles({
      'src/x.ts': `
        import { Controller, Get } from './my-decorators';
        @Controller('nope') export class X { @Get() a() {} }
      `,
    });
    expect(result.endpoints).toEqual([]);
  });

  it('keeps non-literal paths as expressions and marks them dynamic', async () => {
    const { result } = await analyzeFiles({
      'src/x.ts': `
        import { Controller, Get } from '@nestjs/common';
        import { ROUTES } from './routes';
        @Controller(ROUTES.base) export class X { @Get() a() {} }
      `,
    });
    expect(result.endpoints[0].pathIsStatic).toBe(false);
    expect(result.endpoints[0].path).toBe('/${ROUTES.base}');
  });

  it('uses default version and custom version prefix', async () => {
    const { result } = await analyzeFiles({
      'src/main.ts': `
        import { NestFactory } from '@nestjs/core';
        import { VersioningType } from '@nestjs/common';
        const app = await NestFactory.create(AppModule);
        app.enableVersioning({ type: VersioningType.URI, prefix: 'version-', defaultVersion: ['1', '2'] });
      `,
      'src/a.controller.ts': `
        import { Controller, Get } from '@nestjs/common';
        @Controller('a') export class A { @Get() a() {} }
      `,
    });
    expect(routes(result.endpoints)).toEqual(['GET /version-1/a', 'GET /version-2/a']);
  });
});
