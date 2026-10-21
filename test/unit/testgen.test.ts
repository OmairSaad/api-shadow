import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { detectNodeSetup, generateTests, nextFreeName, samplePath, type JavaTestProject, type NodeTestProject } from '../../src/core/testgen';
import { analyzeFiles, find, ROOT } from '../helpers/memoryHost';

const node = (overrides: Partial<NodeTestProject> = {}): NodeTestProject => ({
  kind: 'node',
  root: ROOT,
  runner: 'jest',
  runnerMissing: false,
  supertest: true,
  esm: false,
  typescript: false,
  testDir: path.join(ROOT, 'tests', 'api'),
  app: { file: path.join(ROOT, 'src', 'app.js'), exportName: '*cjs', lib: 'express' },
  ...overrides,
});

describe('Test generation', () => {
  it('chooses the runner and module style from package.json', () => {
    expect(detectNodeSetup({ devDependencies: { vitest: '1', jest: '29', supertest: '6' }, type: 'module' }, false)).toEqual({ runner: 'vitest', runnerMissing: false, supertest: true, esm: true, typescript: false });
    expect(detectNodeSetup({ devDependencies: { mocha: '10' } }, true)).toMatchObject({ runner: 'mocha', supertest: false, typescript: true });
    expect(detectNodeSetup(undefined, false)).toMatchObject({ runner: 'jest', runnerMissing: true });
  });

  it('writes Supertest tests whose expectations come from the code', async () => {
    const { result } = await analyzeFiles({
      'src/app.js': `const app = require('express')(); const { requireAuth } = require('./auth');
app.get('/api/users/:id', requireAuth, async (req, res) => { const u = await User.findById(req.params.id); if (!u) return res.status(404).json({ error: 'nf' }); res.json({ id: u.id, name: 'x', active: true }); });
app.post('/api/users', validate(schema), (req, res) => res.status(201).json({ id: 1 }));
module.exports = app;`,
    });
    const get = find(result.endpoints, 'GET', '/api/users/:id');
    const post = find(result.endpoints, 'POST', '/api/users');
    const out = generateTests([get, post], node(), 'app');
    expect(out.file).toBe(path.join(ROOT, 'tests', 'api', 'app.api.test.js'));
    expect(out.content).toContain(`const request = require('supertest');`);
    expect(out.content).toContain(`const app = require('../../src/app.js');`);
    expect(out.content).toContain(`await request(app).get('/api/users/1');`);
    expect(out.content).toContain('expect(res.status).toBe(200);');
    expect(out.content).toContain(`expect(res.body).toHaveProperty(["name"]);`);
    expect(out.content).toContain(`expect(typeof res.body.name).toBe('string');`);
    expect(out.content).toContain(`it('responds 404 when the resource does not exist'`);
    expect(out.content).toContain(`await request(app).get('/api/users/999999');`);
    expect(out.content).toContain(`it('rejects unauthenticated requests'`);
    expect(out.content).toContain('expect(res.status).toBe(201);');
    expect(out.content).toContain(`it('rejects an invalid request body'`);
    expect(out.content).toContain(`it.todo('responds 500 when a dependency fails`);
    expect(out.content).not.toMatch(/expect\(true\)/);
  });

  it('marks unknown behaviour as pending instead of guessing', async () => {
    const { result } = await analyzeFiles({ 'src/app.js': `const app = require('express')();\napp.put('/things/:id', (req, res) => res.json(store.save(req.body)));\nmodule.exports = app;` });
    const out = generateTests(result.endpoints, node({ runner: 'vitest', esm: true }), 'things');
    expect(out.content).toContain(`import { describe, it, expect } from 'vitest';`);
    expect(out.content).toContain(`import request from 'supertest';`);
    expect(out.content).toContain(`it.todo('responds with an error when the resource does not exist`);
    expect(out.content).toContain(`it.todo('rejects a request body with missing required fields (no validation was detected)')`);
    expect(out.content).toContain('// TODO: assert the response body; its shape could not be inferred.');
    expect(out.content).not.toContain('404);');
  });

  it('explains missing setup: no runner, no Supertest, app not exported', async () => {
    const { result } = await analyzeFiles({ 'src/server.js': `const app = require('express')();\napp.get('/x', (req, res) => res.end());\napp.listen(3000);` });
    const out = generateTests(result.endpoints, node({ app: undefined, supertest: false, runnerMissing: true }), 'server');
    expect(out.warnings.join('\n')).toMatch(/Supertest is not installed/);
    expect(out.warnings.join('\n')).toMatch(/No test runner found/);
    expect(out.warnings.join('\n')).toMatch(/not exported/);
    expect(out.content).toContain('const app = undefined;');
  });

  it('bootstraps NestJS and Fastify apps', async () => {
    const { result } = await analyzeFiles({
      'src/app.module.ts': `export class AppModule {}`,
      'src/cats.controller.ts': `import { Controller, Get } from '@nestjs/common';\n@Controller('cats') export class CatsController { @Get() all() { return [{ name: 'Tom' }]; } }`,
      'f/server.js': `const fastify = require('fastify'); const app = fastify();\napp.get('/f', async () => ({ ok: true }));\nmodule.exports = app;`,
    });
    const nest = generateTests([find(result.endpoints, 'GET', '/cats')], node({ typescript: true, nestAppModule: path.join(ROOT, 'src', 'app.module.ts'), app: undefined }), 'CatsController');
    expect(nest.file.endsWith('CatsController.api.test.ts')).toBe(true);
    expect(nest.content).toContain(`import { AppModule } from '../../src/app.module';`);
    expect(nest.content).toContain('await request(app.getHttpServer()).get(');
    const fast = generateTests([find(result.endpoints, 'GET', '/f')], node({ app: { file: path.join(ROOT, 'f', 'server.js'), exportName: '*cjs', lib: 'fastify' } }), 'server');
    expect(fast.content).toContain('await app.ready();');
    expect(fast.content).toContain('request(app.server)');
  });

  it('writes MockMvc tests for Spring controllers', async () => {
    const { result } = await analyzeFiles({
      'pom.xml': '<project/>',
      'src/main/java/a/ProductDto.java': `package a;\npublic class ProductDto { private String name; private long priceCents; }`,
      'src/main/java/a/ProductController.java': `package a;\nimport org.springframework.web.bind.annotation.*;\n@RestController @RequestMapping("/api/products")\npublic class ProductController {\n  private final ProductService productService;\n  @GetMapping("/{id}") public ProductDto one(@PathVariable Long id) { return productService.find(id); }\n  @GetMapping("/search") public java.util.List<ProductDto> search(@RequestParam String q) { return null; }\n}`,
    });
    const project = (version?: string): JavaTestProject => ({ kind: 'java', root: ROOT, testDir: path.join(ROOT, 'src', 'test', 'java'), packageName: 'a', dependencies: { productService: 'ProductService' }, springBootVersion: version, contextPath: undefined, security: false });
    const out = generateTests(result.endpoints, project('3.4.1'), 'ProductController');
    expect(out.file).toBe(path.join(ROOT, 'src', 'test', 'java', 'a', 'ProductControllerApiTest.java'));
    expect(out.content).toContain('@WebMvcTest(ProductController.class)');
    expect(out.content).toContain('import org.springframework.test.context.bean.override.mockito.MockitoBean;');
    expect(out.content).toContain('    @MockitoBean\n    private ProductService productService;');
    expect(out.content).toContain('mockMvc.perform(get("/api/products/{id}", 1))');
    expect(out.content).toContain('.andExpect(jsonPath("$.name").exists())');
    expect(out.content).toContain('void getApiProductsSearch_requiresQueryParameters()');
    expect(generateTests(result.endpoints, project('3.2.0'), 'ProductController').content).toContain('@MockBean');
  });

  it('builds sample paths and never overwrites existing files', async () => {
    expect(samplePath('/users/:id(\\d+)/posts/{postId}', [{ name: 'postId', in: 'path', required: true, type: 'String' }])).toBe('/users/1/posts/example');
    expect(samplePath('/files/*', [])).toBe('/files/any');
    const taken = new Set(['/p/tests/app.api.test.js', '/p/tests/app.api.2.test.js', '/p/X/AApiTest.java']);
    const exists = async (f: string): Promise<boolean> => taken.has(f);
    expect(await nextFreeName('/p/tests/app.api.test.js', exists)).toBe('/p/tests/app.api.3.test.js');
    expect(await nextFreeName('/p/tests/new.api.test.js', exists)).toBe('/p/tests/new.api.test.js');
    expect(await nextFreeName('/p/X/AApiTest.java', exists)).toBe('/p/X/AApiTest2.java');
  });
});
