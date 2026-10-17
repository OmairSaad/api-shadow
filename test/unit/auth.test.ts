import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { applyAuth, authLabel, classifyAuth, compileAuthOptions, DEFAULT_AUTH_OPTIONS, DEFAULT_AUTH_PATTERNS, DEFAULT_PUBLIC_PATTERNS, shouldWarn } from '../../src/core/auth';
import type { Endpoint, HttpMethod } from '../../src/core/types';
import { analyzeFixture } from '../helpers/nodeHost';
import { analyzeFiles, find } from '../helpers/memoryHost';

function ep(method: HttpMethod, p: string, extra: Partial<Endpoint> = {}): Endpoint {
  return {
    id: `${method} ${p}`,
    framework: 'express',
    method,
    path: p,
    pathIsStatic: true,
    location: { file: '/p/src/app.js', line: 1, column: 1 },
    middleware: [],
    services: [],
    parameters: [],
    notes: [],
    projectRoot: '/p',
    ...extra,
  };
}

const compiled = compileAuthOptions(DEFAULT_AUTH_OPTIONS);
const status = (middleware: string[], markers: string[] = []): string => classifyAuth(ep('GET', '/x', { middleware, markers }), compiled, undefined).status;

describe('classifyAuth with the default patterns', () => {
  it('recognises common auth middleware, guards and annotations', () => {
    for (const mw of ['authenticate', 'requireAuth', 'passport.authenticate()', 'expressjwt()', 'verifyToken', 'ensureLoggedIn()', 'requireAdmin', 'checkPermissions()', 'UseGuards(AuthGuard())', 'UseGuards(JwtAuthGuard)', 'UseGuards(ClerkGuard)', 'APP_GUARD(RolesGuard)', '@PreAuthorize("hasRole(\'ADMIN\')")', '@Secured("ROLE_USER")', '@RolesAllowed("admin")', '@DenyAll']) {
      expect(status([mw]), mw).toBe('protected');
    }
  });

  it('ignores middleware that only sounds security-related', () => {
    for (const mw of ['helmet()', 'helmet.contentSecurityPolicy()', 'passport.initialize()', 'passport.session()', 'session()', 'cors()', 'express.json()', 'rateLimit()', 'UseGuards(ThrottlerGuard)', 'APP_GUARD(ThrottlerGuard)', 'UseInterceptors(LoggingInterceptor)']) {
      expect(status([mw]), mw).toBe('none');
    }
  });

  it('lets explicit public markers win over guards', () => {
    expect(status(['APP_GUARD(JwtAuthGuard)'], ['@Public()'])).toBe('public');
    expect(status(['@PermitAll'])).toBe('public');
    expect(status(['@PreAuthorize("permitAll()")'])).toBe('public');
    expect(status([], ['@AllowAnonymous()'])).toBe('public');
    expect(status([], ['@Roles()'])).toBe('protected');
  });

  it('falls back to central security configuration', () => {
    const central = { name: 'SecurityConfig', location: { file: '/p/SecurityConfig.java', line: 3, column: 1 } };
    expect(classifyAuth(ep('GET', '/x'), compiled, central)).toEqual({ status: 'central', via: ['SecurityConfig'], location: central.location });
    expect(classifyAuth(ep('GET', '/x', { middleware: ['@Secured("ROLE_A")'] }), compiled, central).status).toBe('protected');
  });

  it('labels guards compactly', () => {
    expect(authLabel({ status: 'protected', via: ['APP_GUARD(JwtAuthGuard)', 'UseGuards(RolesGuard)'] })).toBe('JwtAuthGuard, RolesGuard');
    expect(authLabel({ status: 'protected', via: ['x'.repeat(60)] })).toHaveLength(40);
  });

  it('matches the defaults declared in package.json', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
    const props = manifest.contributes.configuration.properties;
    expect(props['apiShadow.auth.patterns'].default).toEqual(DEFAULT_AUTH_PATTERNS);
    expect(props['apiShadow.auth.publicPatterns'].default).toEqual(DEFAULT_PUBLIC_PATTERNS);
  });
});

describe('applyAuth warnings', () => {
  const protectedEp = ep('GET', '/users', { id: 'a', middleware: ['authenticate'] });

  it('warns about write and admin endpoints without auth, only where the project uses auth', () => {
    const list = [protectedEp, ep('POST', '/orders', { id: 'b' }), ep('GET', '/products', { id: 'c' }), ep('GET', '/admin/stats', { id: 'd' }), ep('POST', '/other', { id: 'e', projectRoot: '/q' })];
    const issues = applyAuth(list, DEFAULT_AUTH_OPTIONS, new Map());
    expect(issues.map((i) => i.endpointIds)).toEqual([['b'], ['d']]);
    expect(issues[0]).toMatchObject({ kind: 'no-auth', severity: 'warning' });
    expect(list.map((e) => e.auth?.status)).toEqual(['protected', 'none', 'none', 'none', 'none']);
  });

  it('never warns about sign-in flows, webhooks, health checks or docs', () => {
    for (const p of ['/auth/login', '/api/register', '/users/sign-up', '/webhooks/stripe', '/health', '/api-docs', '/oauth/token']) {
      expect(shouldWarn(ep('POST', p), 'all'), p).toBe(false);
    }
    expect(shouldWarn(ep('POST', '/api/internal/reindex'), 'sensitive')).toBe(true);
    expect(shouldWarn(ep('GET', '/products'), 'sensitive')).toBe(false);
    expect(shouldWarn(ep('GET', '/products'), 'all')).toBe(true);
    expect(shouldWarn(ep('DELETE', '/products/1'), 'off')).toBe(false);
  });

  it('reports invalid patterns and can be disabled', () => {
    const list = [ep('GET', '/x', { auth: { status: 'none', via: [] } })];
    expect(applyAuth(list, { ...DEFAULT_AUTH_OPTIONS, patterns: ['(unclosed'] }, new Map())).toEqual([expect.objectContaining({ kind: 'limitation', message: expect.stringContaining('(unclosed') })]);
    expect(applyAuth(list, { ...DEFAULT_AUTH_OPTIONS, enabled: false }, new Map())).toEqual([]);
    expect(list[0].auth).toBeUndefined();
  });
});

describe('Auth in the fixture projects', async () => {
  const [express, nest, spring] = await Promise.all(['express-app', 'nest-app', 'spring-app'].map((f) => analyzeFixture(f)));
  const warned = (r: typeof express): string[] => r.result.issues.filter((i) => i.kind === 'no-auth').map((i) => r.result.endpoints.find((e) => e.id === i.endpointIds![0])!).map((e) => `${e.method} ${e.path}`);

  it('flags unprotected write and admin endpoints next to protected ones', () => {
    expect(find(express.result.endpoints, 'GET', '/users/:id').auth).toEqual({ status: 'protected', via: ['authenticate'] });
    expect(warned(express)).toEqual(['POST /api/orders']);
    expect(warned(nest)).toEqual(['GET /api/admin/reports/stats', 'GET /api/admin/reports/statistics']);
    expect(warned(spring)).toEqual(['DELETE /shop/api/v1/products/{id}', 'DELETE /shop/api/v1/products/remove/{id}', 'POST /shop/api/v1/products/search', 'ALL /shop/api/v1/products/legacy']);
  });
});

describe('NestJS global guards and markers', () => {
  const files = {
    'src/main.ts': `
      import { NestFactory } from '@nestjs/core';
      import { AppModule } from './app.module';
      import { ApiKeyGuard } from './api-key.guard';
      async function bootstrap() {
        const app = await NestFactory.create(AppModule);
        app.useGlobalGuards(new ApiKeyGuard());
        await app.listen(process.env.PORT ?? 3001);
      }
      bootstrap();`,
    'src/app.module.ts': `
      import { Module } from '@nestjs/common';
      import { APP_GUARD } from '@nestjs/core';
      import { ThrottlerGuard } from '@nestjs/throttler';
      import { JwtAuthGuard } from './jwt.guard';
      import { CatsController } from './cats.controller';
      @Module({
        controllers: [CatsController],
        providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }, { provide: APP_GUARD, useClass: JwtAuthGuard }],
      })
      export class AppModule {}`,
    'src/cats.controller.ts': `
      import { Controller, Get, Post } from '@nestjs/common';
      import { Public } from './public.decorator';
      @Controller('cats')
      export class CatsController {
        @Get() list() {}
        @Public() @Get('open') open() {}
        @Post() create() {}
      }`,
  };

  it('applies APP_GUARD providers and useGlobalGuards to every endpoint, and honours @Public()', async () => {
    const { result } = await analyzeFiles(files);
    const list = find(result.endpoints, 'GET', '/cats');
    expect(list.middleware).toEqual(['APP_GUARD(ThrottlerGuard)', 'APP_GUARD(JwtAuthGuard)', 'useGlobalGuards(ApiKeyGuard)']);
    expect(list.auth).toEqual({ status: 'protected', via: ['APP_GUARD(JwtAuthGuard)', 'useGlobalGuards(ApiKeyGuard)'] });
    expect(list.notes).toContain('Global guard JwtAuthGuard (APP_GUARD, app.module.ts:9)');
    expect(find(result.endpoints, 'GET', '/cats/open').auth).toEqual({ status: 'public', via: ['@Public()'] });
    expect(result.issues.filter((i) => i.kind === 'no-auth')).toEqual([]);
    expect(result.servers).toEqual([{ projectRoot: expect.any(String), port: 3001, location: expect.objectContaining({ line: 8 }) }]);
  });

  it('does not count a throttling guard as auth', async () => {
    const { result } = await analyzeFiles({
      'src/app.module.ts': `
        import { Module } from '@nestjs/common';
        import { APP_GUARD } from '@nestjs/core';
        import { ThrottlerGuard } from '@nestjs/throttler';
        @Module({ providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }] })
        export class AppModule {}`,
      'src/cats.controller.ts': `
        import { Controller, Post } from '@nestjs/common';
        @Controller('cats')
        export class CatsController { @Post() create() {} }`,
    });
    expect(find(result.endpoints, 'POST', '/cats').auth?.status).toBe('none');
  });
});

describe('Express ports', () => {
  it('reads the port from a server file that imports the app', async () => {
    const { result } = await analyzeFiles({
      'src/app.js': `const express = require('express'); const app = express(); app.post('/orders', (req, res) => res.end()); module.exports = app;`,
      'src/server.js': `const app = require('./app');\nconst PORT = Number(process.env.PORT) || 4000;\napp.listen(PORT, () => console.log('up'));`,
    });
    expect(result.servers.map((s) => [s.port, path.basename(s.location.file), s.location.line])).toEqual([[4000, 'server.js', 3]]);
  });

  it('ignores listen calls on unrelated objects', async () => {
    const { result } = await analyzeFiles({
      'src/app.js': `const express = require('express'); const app = express(); app.get('/x', (req, res) => res.end());\nconst emitter = makeEmitter();\nemitter.listen(9999);`,
    });
    expect(result.servers).toEqual([]);
  });
});

describe('Spring Security configuration', () => {
  const controller = `
    package com.example;
    import org.springframework.web.bind.annotation.*;
    import org.springframework.security.access.prepost.PreAuthorize;
    @RestController
    @RequestMapping("/items")
    public class ItemController {
      @GetMapping public String list() { return ""; }
      @PreAuthorize("hasRole('ADMIN')") @DeleteMapping("/{id}") public void delete(@PathVariable Long id) {}
      @PreAuthorize("permitAll()") @GetMapping("/open") public String open() { return ""; }
    }`;

  it('treats endpoints as centrally secured when a SecurityFilterChain bean exists', async () => {
    const { result } = await analyzeFiles({
      'pom.xml': '<project/>',
      'src/main/java/com/example/ItemController.java': controller,
      'src/main/java/com/example/SecurityConfig.java': `
        package com.example;
        import org.springframework.context.annotation.*;
        import org.springframework.security.web.SecurityFilterChain;
        @Configuration
        public class SecurityConfig {
          @Bean
          public SecurityFilterChain filterChain(HttpSecurity http) throws Exception { return http.build(); }
        }`,
      'src/main/resources/application.properties': 'server.port=${PORT:8081}\nspring.datasource.password=hunter2',
    });
    const list = find(result.endpoints, 'GET', '/items');
    expect(list.auth).toMatchObject({ status: 'central', via: ['SecurityConfig'] });
    expect(path.basename(list.auth!.location!.file)).toBe('SecurityConfig.java');
    expect(find(result.endpoints, 'DELETE', '/items/{id}').auth?.status).toBe('protected');
    expect(find(result.endpoints, 'GET', '/items/open').auth?.status).toBe('public');
    expect(result.issues.filter((i) => i.kind === 'no-auth')).toEqual([]);
    expect(result.servers.map((s) => s.port)).toEqual([8081]);
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('recognises @EnableWebSecurity and warns without central configuration', async () => {
    const secured = await analyzeFiles({
      'pom.xml': '<project/>',
      'src/main/java/com/example/ItemController.java': controller,
      'src/main/java/com/example/WebSecurity.java': 'package com.example;\n@EnableWebSecurity\npublic class WebSecurity {}',
    });
    expect(find(secured.result.endpoints, 'GET', '/items').auth?.status).toBe('central');

    const { result } = await analyzeFiles({
      'pom.xml': '<project/>',
      'src/main/java/com/example/ItemController.java': controller.replace(`@PreAuthorize("hasRole('ADMIN')") @DeleteMapping`, '@DeleteMapping'),
    });
    expect(result.issues.filter((i) => i.kind === 'no-auth').map((i) => i.message)).toEqual([expect.stringMatching(/^No auth found for DELETE \/items\/\{id\} \(ItemController\.java:9\)/)]);
  });
});
