import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { analyzePhp, paramName } from '../../src/analyzers/phpAnalyzer';
import { parsePhp } from '../../src/analyzers/phpParser';
import { analyzeImpact } from '../../src/core/impact';
import { describeShape, successShape } from '../../src/core/shapes';
import { generateTests } from '../../src/core/testgen';
import type { Endpoint } from '../../src/core/types';
import { analyzeFiles, find, routes, ROOT } from '../helpers/memoryHost';
import { analyzeFixture } from '../helpers/nodeHost';

const api = (body: string, uses = ''): string => `<?php\n\nuse Illuminate\\Support\\Facades\\Route;\n${uses}\n${body}\n`;
const files = (routesApi: string, extra: Record<string, string> = {}): Record<string, string> => ({ 'composer.json': '{}', 'routes/api.php': routesApi, ...extra });
const controller = (name: string, methods: string, uses = ''): string => `<?php\n\nnamespace App\\Http\\Controllers;\n\nuse Illuminate\\Http\\Request;\n${uses}\nclass ${name} extends Controller\n{\n${methods}\n}\n`;

describe('Laravel: the routes/api.php from the feature request', async () => {
  const { result, root } = await analyzeFixture('laravel-app');
  const byRoute = (m: string, p: string): Endpoint => find(result.endpoints, m, p);

  it('finds every route with the /api prefix, resource expansions and only/except', () => {
    expect(routes(result.endpoints.filter((e) => e.path.startsWith('/api')))).toEqual([
      'DELETE /api/articles/{article}',
      'DELETE /api/categories/{category}',
      'DELETE /api/messages/{message}',
      'DELETE /api/priest/{priest}',
      'GET /api/articles',
      'GET /api/articles/{article}',
      'GET /api/categories',
      'GET /api/categories/{category}',
      'GET /api/events',
      'GET /api/events/{event}',
      'GET /api/events/{id}/test-recurrence',
      'GET /api/messages',
      'GET /api/messages/{message}',
      'GET /api/priest',
      'GET /api/priest/{priest}',
      'PATCH /api/articles/{article}',
      'PATCH /api/categories/{category}',
      'PATCH /api/messages/{message}',
      'PATCH /api/priest/{priest}',
      'POST /api/articles',
      'POST /api/categories',
      'POST /api/login',
      'POST /api/logout',
      'POST /api/messages',
      'POST /api/payment',
      'POST /api/priest',
      'PUT /api/articles/{article}',
      'PUT /api/categories/{category}',
      'PUT /api/messages/{message}',
      'PUT /api/priest/{priest}',
    ]);
    expect(routes(result.endpoints.filter((e) => !e.path.startsWith('/api')))).toEqual(['GET /', 'GET /up']);
    expect(result.duplicates).toEqual([]);
    expect(result.endpoints.some((e) => e.path.includes('should-never-appear'))).toBe(false);
  });

  it('applies group middleware and detects auth:sanctum as auth', () => {
    expect(byRoute('POST', '/api/logout').middleware).toEqual(['api', 'auth:sanctum']);
    expect(byRoute('POST', '/api/logout').auth?.status).toBe('protected');
    expect(byRoute('POST', '/api/articles').auth?.status).toBe('protected');
    expect(byRoute('GET', '/api/articles').auth?.status).toBe('none');
    expect(byRoute('POST', '/api/logout').trace?.map((t) => `${t.text} @ ${t.location ? `${path.relative(root, t.location.file)}:${t.location.line}` : '-'}`)).toEqual([
      'API routes: prefix "api" and the api middleware group (withRouting) @ bootstrap/app.php:8',
      'Group middleware auth:sanctum @ routes/api.php:21',
    ]);
  });

  it('links routes to controller methods, also without an import (ContactController)', () => {
    const show = byRoute('GET', '/api/articles/{article}');
    expect([show.controller, show.handler, path.relative(root, show.handlerLocation!.file), show.handlerLocation!.line]).toEqual(['ArticleController', 'show', 'app/Http/Controllers/ArticleController.php', 21]);
    const contact = byRoute('GET', '/api/messages');
    expect(path.relative(root, contact.handlerLocation!.file)).toBe('app/Http/Controllers/ContactController.php');
    expect(byRoute('GET', '/api/events/{id}/test-recurrence').handler).toBe('testRecurrence');
    expect(byRoute('GET', '/api/articles').services).toEqual([expect.objectContaining({ name: 'ArticleService.latest', uses: [{ name: 'Article.latest' }] })]);
  });

  it('reads validation, response shapes and status codes', () => {
    expect(byRoute('POST', '/api/articles')).toMatchObject({ requestBodyType: 'StoreArticleRequest', validation: { status: 'validated', via: ['StoreArticleRequest'] } });
    expect(byRoute('POST', '/api/login').validation?.status).toBe('validated');
    expect(byRoute('POST', '/api/logout').validation).toBeUndefined();
    expect(describeShape(successShape(byRoute('POST', '/api/login')))).toBe('{ token, user: { id, name } }');
    expect(byRoute('GET', '/api/articles/{article}').responses?.map((r) => r.status)).toEqual([undefined, 404]);
    expect(byRoute('DELETE', '/api/articles/{article}').responses?.map((r) => r.status)).toEqual([204, 404]);
    expect(byRoute('GET', '/api/events/{id}/test-recurrence').responses?.map((r) => r.status)).toEqual([404, undefined, 500]);
  });

  it('runs the Security Radar on PHP: raw SQL with input, mass assignment, CORS config and error messages', () => {
    const lines = result.security.filter((f) => f.rule !== 'missing-auth').map((f) => `${f.rule} ${f.severity} ${f.endpoint ?? path.relative(root, f.location.file)}`).sort();
    expect(lines).toEqual([
      'error-details low GET /api/events/{id}/test-recurrence',
      'injection high POST /api/payment',
      'mass-assignment medium PATCH /api/articles/{article}',
      'mass-assignment medium POST /api/payment',
      'mass-assignment medium PUT /api/articles/{article}',
      'permissive-cors high config/cors.php',
    ]);
  });

  it('counts the feature tests', () => {
    expect(byRoute('GET', '/api/articles').usage).toEqual({ calls: 0, tests: 1 });
    expect(result.clientCalls.map((c) => `${c.kind} ${c.client} ${c.method} ${c.url}`)).toEqual(['test Laravel test GET /api/articles', 'test Laravel test POST /api/articles']);
  });
});

describe('Laravel routing patterns', () => {
  it('reads array and fluent groups, nested prefixes, names, controller groups and withoutMiddleware', async () => {
    const { result } = await analyzeFiles(
      files(
        api(`
Route::prefix('v1')->middleware(['auth:sanctum', 'throttle:api'])->name('v1.')->group(function () {
    Route::get('/me', [UserController::class, 'me'])->name('me');
    Route::group(['prefix' => 'admin', 'middleware' => 'can:admin'], function () {
        Route::delete('/users/{user}', [UserController::class, 'destroy']);
    });
    Route::controller(OrderController::class)->prefix('orders')->group(function () {
        Route::get('/', 'index');
        Route::post('/{order}/cancel', 'cancel')->withoutMiddleware('throttle:api');
    });
});
Route::match(['get', 'post'], '/search', SearchController::class);
Route::any('/webhook', 'WebhookController@handle');
Route::view('/about', 'pages.about');`, 'use App\\Http\\Controllers\\UserController;\nuse App\\Http\\Controllers\\OrderController;\nuse App\\Http\\Controllers\\SearchController;'),
      ),
    );
    expect(routes(result.endpoints)).toEqual(['ALL /api/webhook', 'DELETE /api/v1/admin/users/{user}', 'GET /api/about', 'GET /api/search', 'GET /api/v1/me', 'GET /api/v1/orders', 'POST /api/search', 'POST /api/v1/orders/{order}/cancel']);
    expect(find(result.endpoints, 'DELETE', '/api/v1/admin/users/{user}').middleware).toEqual(['api', 'auth:sanctum', 'throttle:api', 'can:admin']);
    expect(find(result.endpoints, 'POST', '/api/v1/orders/{order}/cancel')).toMatchObject({ controller: 'OrderController', handler: 'cancel', middleware: ['api', 'auth:sanctum'] });
    expect(find(result.endpoints, 'GET', '/api/v1/me').notes).toContain('Route name: v1.me');
    expect(find(result.endpoints, 'GET', '/api/search')).toMatchObject({ controller: 'SearchController', handler: '__invoke' });
    expect(find(result.endpoints, 'ALL', '/api/webhook')).toMatchObject({ controller: 'WebhookController', handler: 'handle' });
  });

  it('expands resources: web resources, nested names, parameters, names and singletons', async () => {
    const { result } = await analyzeFiles({
      'composer.json': '{}',
      'routes/web.php': api(`
Route::resource('blog-posts', PostController::class)->except(['destroy']);
Route::resource('photos.comments', CommentController::class)->only(['index', 'show']);
Route::apiResource('users', UserController::class)->parameters(['users' => 'member'])->only(['show']);
Route::singleton('profile', ProfileController::class);`),
    });
    expect(routes(result.endpoints)).toEqual([
      'GET /blog-posts',
      'GET /blog-posts/create',
      'GET /blog-posts/{blog_post}',
      'GET /blog-posts/{blog_post}/edit',
      'GET /photos/{photo}/comments',
      'GET /photos/{photo}/comments/{comment}',
      'GET /profile',
      'GET /profile/edit',
      'GET /users/{member}',
      'PATCH /blog-posts/{blog_post}',
      'PATCH /profile',
      'POST /blog-posts',
      'PUT /blog-posts/{blog_post}',
      'PUT /profile',
    ]);
    expect(find(result.endpoints, 'GET', '/blog-posts').middleware).toEqual(['web']);
    expect(['categories', 'boxes', 'status', 'priest', 'blog-posts'].map(paramName)).toEqual(['category', 'box', 'status', 'priest', 'blog_post']);
  });

  it('follows route files loaded by a service provider or required from another file', async () => {
    const { result } = await analyzeFiles({
      'composer.json': '{}',
      'app/Providers/RouteServiceProvider.php': `<?php\nnamespace App\\Providers;\nuse Illuminate\\Support\\Facades\\Route;\nclass RouteServiceProvider extends ServiceProvider\n{\n    public function boot(): void\n    {\n        $this->routes(function () {\n            Route::middleware('api')->prefix('api/v2')->group(base_path('routes/api.php'));\n            Route::middleware('web')->group(base_path('routes/web.php'));\n        });\n    }\n}\n`,
      'routes/api.php': api(`Route::get('/orders', [OrderController::class, 'index']);`),
      'routes/web.php': api(`Route::get('/', fn () => view('home'));\nrequire __DIR__.'/auth.php';`),
      'routes/auth.php': api(`Route::post('/login', [LoginController::class, 'store'])->middleware('guest');`),
    });
    expect(routes(result.endpoints)).toEqual(['GET /', 'GET /api/v2/orders', 'POST /login']);
    expect(find(result.endpoints, 'POST', '/login').middleware).toEqual(['web', 'guest']);
    expect(find(result.endpoints, 'GET', '/api/v2/orders').trace?.map((t) => `${t.text} @ ${path.basename(t.location!.file)}:${t.location!.line}`)).toEqual(['Middleware api @ RouteServiceProvider.php:9', 'Prefix "api/v2" @ RouteServiceProvider.php:9', 'Route file api.php loaded @ RouteServiceProvider.php:9']);
  });

  it('uses a custom apiPrefix from withRouting, and Laravel defaults without it', async () => {
    const custom = await analyzeFiles(files(api(`Route::get('/ping', fn () => ['ok' => true]);`), { 'bootstrap/app.php': `<?php\nreturn Application::configure(basePath: dirname(__DIR__))\n    ->withRouting(api: __DIR__.'/../routes/api.php', apiPrefix: 'api/v1')\n    ->create();` }));
    expect(routes(custom.result.endpoints)).toEqual(['GET /api/v1/ping']);
    expect(describeShape(successShape(custom.result.endpoints[0]))).toBe('{ ok }');
    const defaults = await analyzeFiles(files(api(`Route::get('/ping', fn () => ['ok' => true]);`)));
    expect(routes(defaults.result.endpoints)).toEqual(['GET /api/ping']);
  });

  it('reports duplicates and unreachable routes, but not where()-constrained ones', async () => {
    const { result } = await analyzeFiles(
      files(
        api(`
Route::get('/users/{id}', [UserController::class, 'show']);
Route::get('/users/me', [UserController::class, 'me']);
Route::get('/posts/{id}', [PostController::class, 'show'])->whereNumber('id');
Route::get('/posts/latest', [PostController::class, 'latest']);
Route::get('/tags', [TagController::class, 'index']);
Route::get('/tags', [TagController::class, 'all']);`),
      ),
    );
    expect(result.issues.filter((i) => i.kind === 'unreachable').map((i) => i.message)).toEqual([expect.stringMatching(/^GET \/api\/users\/me is unreachable: GET \/api\/users\/\{id\}/)]);
    expect(result.duplicates.map((d) => `${d.method} ${d.path}`)).toEqual(['GET /api/tags']);
  });

  it('keeps routes outside routes/ relative to their file', async () => {
    const { result } = await analyzeFiles({ 'composer.json': '{}', 'packages/blog/src/routes.php': api(`Route::get('/posts', fn () => []);`) });
    expect(result.endpoints[0]).toMatchObject({ path: '/posts', confidence: 'medium' });
  });
});

describe('Laravel and the rest of the workspace', () => {
  const backend = {
    'backend/composer.json': '{}',
    'backend/routes/api.php': api(`Route::get('/articles/{article}', [ArticleController::class, 'show']);`, 'use App\\Http\\Controllers\\ArticleController;'),
    'backend/app/Http/Controllers/ArticleController.php': controller('ArticleController', `    public function show(Article $article)\n    {\n        return response()->json(['id' => $article->id, 'title' => $article->title]);\n    }`),
    'web/package.json': '{}',
    'web/src/Article.jsx': `export async function Article({ id }) {\n  const a = await (await fetch(\`/api/articles/\${id}\`)).json();\n  return <h1>{a.name}</h1>;\n}`,
  };

  it('links frontend calls to Laravel routes and checks the fields they read', async () => {
    const { result } = await analyzeFiles(backend);
    expect(result.clientCalls[0].endpointIds).toEqual([find(result.endpoints, 'GET', '/api/articles/{article}').id]);
    expect(result.issues.filter((i) => i.kind === 'response-mismatch').map((i) => i.message)).toEqual([expect.stringMatching(/^`name` is read in Article, but GET \/api\/articles\/\{article\} responds with \{ id, title \}/)]);
  });

  it('reports the impact of a renamed field on the frontend', async () => {
    const before = (await analyzeFiles({ ...backend, 'web/src/Article.jsx': backend['web/src/Article.jsx'].replace('a.name', 'a.title') })).result;
    const after = (await analyzeFiles({ ...backend, 'web/src/Article.jsx': backend['web/src/Article.jsx'].replace('a.name', 'a.title'), 'backend/app/Http/Controllers/ArticleController.php': backend['backend/app/Http/Controllers/ArticleController.php'].replace("'title' => $article->title", "'headline' => $article->title") })).result;
    const report = analyzeImpact(before, after, 'HEAD');
    expect(report.endpoints[0].changes[0]).toMatchObject({ text: expect.stringContaining('`title` renamed to `headline`'), risk: 'high', evidence: 'confirmed' });
  });

  it('flags hardcoded credentials and forced debug mode in PHP config', async () => {
    const { result } = await analyzeFiles({
      'composer.json': '{}',
      'config/services.php': `<?php\nreturn [\n    'stripe' => ['secret' => 'sk_live_${'a'.repeat(24)}'],\n    'mailgun' => ['secret' => env('MAILGUN_SECRET')],\n];\n`,
      'config/app.php': `<?php\nreturn [\n    'timezone' => 'UTC',\n    'debug' => true,\n];\n`,
    });
    expect(result.security.map((f) => `${f.rule} ${path.basename(f.location.file)}:${f.location.line}`).sort()).toEqual(['error-details app.php:4', 'hardcoded-secret services.php:3']);
    expect(JSON.stringify(result.security)).not.toContain('a'.repeat(24));
  });

  it('generates PHPUnit feature tests from the routes', async () => {
    const { result } = await analyzeFixture('laravel-app');
    const article = result.endpoints.filter((e) => e.controller === 'ArticleController');
    const out = generateTests(article, { kind: 'php', root: ROOT, testDir: path.join(ROOT, 'tests', 'Feature'), pest: false, sanctum: true }, 'ArticleController');
    expect(out.file).toBe(path.join(ROOT, 'tests', 'Feature', 'ArticleControllerApiTest.php'));
    expect(out.runner).toBe('phpunit');
    expect(out.content).toContain('namespace Tests\\Feature;');
    expect(out.content).toContain('class ArticleControllerApiTest extends TestCase');
    expect(out.content).toContain("$response = $this->getJson('/api/articles');");
    expect(out.content).toContain("$response->assertJsonStructure(['data', 'meta' => ['total']]);");
    expect(out.content).toContain("$this->getJson('/api/articles/999999')->assertNotFound();");
    expect(out.content).toContain("$this->postJson('/api/articles', [])->assertUnprocessable();");
    expect(out.content).toContain('Sanctum::actingAs(User::factory()->create());');
    expect(out.content).toContain("$this->postJson('/api/articles', [/* TODO: a valid request body */])->assertUnauthorized();");
    expect(out.content).toContain("$this->markTestIncomplete('No validation was detected for this request body.');");
  });
});

describe('PHP parser', () => {
  it('survives modern and unusual syntax and keeps reading routes after errors', () => {
    const source = `<?php
declare(strict_types=1);
namespace App;
use App\\Models\\{User, Post as P};
#[Attribute(Attribute::TARGET_CLASS)]
enum Status: string { case Active = 'active'; }
$text = <<<EOT
Hello {$name}
EOT;
$v = match ($x) { 1 => 'a', default => 'b' };
if ($a): $b = 1; endif;
Route::get('/broken', [X::class 'missing comma']);
Route::get('/after', fn () => ['ok' => true]);
?>
<p>inline html with Route::get('/not-code')</p>
<?php Route::post('/last', fn () => null);`;
    const parsed = parsePhp(source);
    expect(parsed.errors).toHaveLength(1);
    const facts = analyzePhp(source, '/p/routes/web.php');
    expect(facts.uses).toMatchObject({ User: 'App\\Models\\User', P: 'App\\Models\\Post' });
    expect(facts.routes.map((r) => `${r.methods[0]} ${r.paths.map((p) => p.parts.map((x) => ('lit' in x ? x.lit : '?')).join('')).join('')}`)).toEqual(['GET /after', 'POST /last']);
    expect(facts.issues).toEqual([expect.objectContaining({ kind: 'limitation', message: expect.stringContaining('could not be parsed') })]);
  });
});
