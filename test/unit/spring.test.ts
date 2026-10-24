import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { analyzeSpringConfig } from '../../src/analyzers/springConfig';
import { analyzeFixture } from '../helpers/nodeHost';
import { analyzeFiles, find, routes } from '../helpers/memoryHost';

describe('Spring fixture project', async () => {
  const { result } = await analyzeFixture('spring-app');
  const spring = result.endpoints;

  it('combines context path, class and method mappings, constants and interface mappings', () => {
    expect(routes(spring)).toEqual(
      [
        'GET /shop/api/orders',
        'GET /shop/api/orders/{orderId}',
        'GET /shop/api/v1/products',
        'POST /shop/api/v1/products',
        'GET /shop/api/v1/products/{id}',
        'DELETE /shop/api/v1/products/{id}',
        'DELETE /shop/api/v1/products/remove/{id}',
        'GET /shop/api/v1/products/search',
        'POST /shop/api/v1/products/search',
        'ALL /shop/api/v1/products/legacy',
        'GET /shop/api/v1/products/{productId}',
      ].sort(),
    );
    expect(spring.every((e) => e.pathIsStatic)).toBe(true);
  });

  it('excludes src/test by default', () => {
    expect(spring.some((e) => e.path.includes('test-only'))).toBe(false);
  });

  it('extracts parameters, body and security annotations', () => {
    const list = find(spring, 'GET', '/shop/api/v1/products');
    expect(list.parameters).toEqual([{ name: 'page', in: 'query', required: false, type: 'int' }]);
    const create = find(spring, 'POST', '/shop/api/v1/products');
    expect(create.requestBodyType).toBe('ProductDto');
    expect(create.middleware).toEqual([`@PreAuthorize("hasRole('ADMIN')")`]);
    const search = find(spring, 'GET', '/shop/api/v1/products/search');
    expect(search.parameters).toEqual([{ name: 'q', in: 'query', required: false, type: 'String' }]);
    expect(find(spring, 'GET', '/shop/api/v1/products/{id}').parameters).toEqual([{ name: 'id', in: 'path', required: true, type: 'Long' }]);
  });

  it('links field-injected and constructor-injected services', () => {
    const get = find(spring, 'GET', '/shop/api/v1/products/{id}');
    expect(get.services.map((s) => s.name)).toEqual(['ProductService.findById']);
    expect(path.basename(get.services[0].location!.file)).toBe('ProductService.java');
    expect(get.services[0].location!.line).toBe(13);
    const order = find(spring, 'GET', '/shop/api/orders/{orderId}');
    expect(order.services.map((s) => s.name)).toEqual(['OrderService.get']);
  });

  it('points interface-inherited mappings at the interface and the implementation', () => {
    const e = find(spring, 'GET', '/shop/api/orders');
    expect(path.basename(e.location.file)).toBe('OrdersApi.java');
    expect(path.basename(e.handlerLocation!.file)).toBe('OrderController.java');
    expect(e.controller).toBe('OrderController');
    expect(e.notes.join()).toMatch(/inherited from OrdersApi/);
  });

  it('reports duplicates, parse errors and unsupported Kotlin', () => {
    expect(result.duplicates.some((d) => d.path.endsWith('{id}') || d.path.endsWith('{productId}'))).toBe(true);
    expect(result.issues.some((i) => i.kind === 'parse-error' && i.location!.file.endsWith('BrokenController.java'))).toBe(true);
    expect(result.issues.some((i) => /Kotlin/.test(i.message))).toBe(true);
  });

  it('can disable the context path', async () => {
    const { result: r } = await analyzeFixture('spring-app', { springApplyContextPath: false });
    expect(r.endpoints.every((e) => !e.path.startsWith('/shop'))).toBe(true);
  });
});

describe('Spring patterns', () => {
  it('resolves static imports, wildcard static imports and inherited interface constants', async () => {
    const { result } = await analyzeFiles({
      'pom.xml': '<project/>',
      'src/main/java/a/Paths.java': `package a; public interface Paths { String USERS = "/users"; String ADMIN = "/admin"; }`,
      'src/main/java/a/Other.java': `package a; public class Other { public static final String X = "/x"; }`,
      'src/main/java/a/C1.java': `package a;
        import static a.Paths.USERS;
        @RestController public class C1 { @GetMapping(USERS) void a(){} }`,
      'src/main/java/a/C2.java': `package a;
        import static a.Other.*;
        @RestController public class C2 { @PostMapping(X + "/y") void b(){} }`,
      'src/main/java/a/C3.java': `package a;
        @RestController @RequestMapping(Paths.ADMIN) public class C3 implements Paths { @DeleteMapping(USERS) void c(){} }`,
    });
    expect(routes(result.endpoints)).toEqual(['DELETE /admin/users', 'GET /users', 'POST /x/y']);
  });

  it('marks unresolved constants as dynamic', async () => {
    const { result } = await analyzeFiles({
      'pom.xml': '<project/>',
      'src/main/java/a/C.java': `package a; @RestController public class C { @GetMapping(External.PATH) void a(){} }`,
    });
    expect(result.endpoints[0].pathIsStatic).toBe(false);
    expect(result.endpoints[0].path).toBe('/${External.PATH}');
  });

  it('inherits class-level method restriction and supports @Controller + abstract base classes', async () => {
    const { result } = await analyzeFiles({
      'pom.xml': '<project/>',
      'src/main/java/a/Base.java': `package a; public abstract class Base { @GetMapping("/ping") public String ping(){ return "pong"; } }`,
      'src/main/java/a/C.java': `package a;
        @Controller @RequestMapping(path = "/legacy", method = RequestMethod.POST)
        public class C extends Base { @RequestMapping("/submit") void submit(){} }`,
    });
    expect(routes(result.endpoints)).toEqual(['GET /legacy/ping', 'POST /legacy/submit']);
  });

  it('handles nested controllers and does not report non-controllers', async () => {
    const { result } = await analyzeFiles({
      'pom.xml': '<project/>',
      'src/main/java/a/Outer.java': `package a; public class Outer {
          @RestController public static class Inner { @GetMapping("/inner") void a(){} }
          public static class NotAController { @GetMapping("/no") void b(){} }
        }`,
    });
    expect(routes(result.endpoints)).toEqual(['GET /inner']);
  });

  it('reads context path from application.yml', async () => {
    const { result } = await analyzeFiles({
      'pom.xml': '<project/>',
      'src/main/resources/application.yml': 'server:\n  servlet:\n    context-path: /svc\nspring:\n  datasource:\n    password: hunter2\n',
      'src/main/java/a/C.java': `package a; @RestController public class C { @GetMapping("/a") void a(){} }`,
    });
    expect(routes(result.endpoints)).toEqual(['GET /svc/a']);
  });

  it('scopes context paths to their module in multi-module builds', async () => {
    const { result } = await analyzeFiles({
      'pom.xml': '<project/>',
      'svc-a/pom.xml': '<project/>',
      'svc-a/src/main/resources/application.properties': 'server.servlet.context-path=/a',
      'svc-a/src/main/java/a/A.java': `package a; @RestController public class A { @GetMapping("/x") void x(){} }`,
      'svc-b/pom.xml': '<project/>',
      'svc-b/src/main/java/b/B.java': `package b; @RestController public class B { @GetMapping("/x") void x(){} }`,
    });
    expect(routes(result.endpoints)).toEqual(['GET /a/x', 'GET /x']);
    // Different modules: same path is not a duplicate.
    expect(result.duplicates).toEqual([]);
  });
});

describe('Spring config parsing', () => {
  it('retains only context-path keys', () => {
    const facts = analyzeSpringConfig('server.servlet.context-path=/api\nspring.datasource.password=secret\n', 'application.properties');
    expect(facts).toEqual({ lang: 'spring-config', contextPath: '/api', servletPath: undefined, contextLine: 1, issues: [] });
    expect(JSON.stringify(facts)).not.toContain('secret');
  });

  it('ignores placeholders', () => {
    const facts = analyzeSpringConfig('server:\n  servlet:\n    context-path: ${CTX:/api}\n', 'application.yml');
    expect(facts.contextPath).toBeUndefined();
    expect(facts.issues).toHaveLength(1);
  });

  it('survives malformed YAML', () => {
    const facts = analyzeSpringConfig('server: [unclosed\n  - : :', 'application.yml');
    expect(facts.contextPath).toBeUndefined();
  });
});
