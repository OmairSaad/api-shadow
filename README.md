# API Shadow

**See every HTTP endpoint in your Express, NestJS and Spring Boot projects without running them.**

API Shadow reads your source code with real parsers and lists every route it finds in a dedicated sidebar. Each entry shows the HTTP method, the full path with all prefixes applied, the controller and handler, middleware and guards, the services it calls, and the exact source line. Click an endpoint to jump straight to it.

Above each route in the editor, a CodeLens shows the full path and how it's protected. **Try it** opens a ready-to-send request, and endpoints that are missing auth are flagged.

Everything runs locally. There are no accounts, servers, telemetry or AI services, and your code never leaves your machine.

![The API Shadow sidebar listing endpoints from Express, NestJS and Spring projects. An expanded NestJS endpoint shows its handler, guards, linked service, request body type, global prefix and API version, next to the controller source.](media/overview.png)

## See it in action

![Animated demo: filtering endpoints by text, jumping to a controller, expanding endpoint details, following a service link, filtering by HTTP method and searching for an endpoint.](media/demo.gif)

## Getting started

1. Install API Shadow and open a folder that contains an Express, NestJS or Spring Boot project. Monorepos with several projects (or several Maven/Gradle modules) are supported.
2. Click the **API Shadow** icon in the Activity Bar. Analysis starts automatically and usually takes a second or two.
3. Click an endpoint to open its declaration. Expand it to see the handler, middleware, services and how its path was built.

The status bar shows the endpoint count and any potential duplicate routes. Click it to open the sidebar.

## Features

### Every endpoint, with its real path

API Shadow follows the code to work out the URL a request actually hits. That includes Express mount prefixes through nested routers across files, NestJS global prefixes, URI versioning and `RouterModule`, and Spring class and method mappings, constants and `server.servlet.context-path`. Paths that depend on runtime values are marked **dynamic** instead of guessed.

![An Express endpoint expanded in the sidebar, showing its handler in the controller module, the middleware chain from the app and the mount, the service it calls, and a potential duplicate route warning.](media/express.png)

### Right above your code

A CodeLens above every route declaration shows the full method and path (with every prefix applied), the auth that protects it, and duplicate warnings. Click the path for quick actions. Turn it off with `apiShadow.codeLens.enabled`.

### Try any endpoint: cURL and .http requests

Click **Try it** to open a ready-to-send request beside the code, in the `.http` format used by the [REST Client](https://marketplace.visualstudio.com/items?itemName=humao.rest-client) extension and JetBrains IDEs. Click **cURL** to copy the same request as a cURL command.

- Path parameters get sample values (`1`, `example`, or a UUID, based on their type), and required query parameters, headers and cookies are filled in.
- POST, PUT and PATCH requests get a JSON body. Protected endpoints get an `Authorization: Bearer` header, read from `$TOKEN` in cURL.
- The base URL uses the port from `app.listen(3000)` or `server.port`, or set `apiShadow.requests.baseUrl` to target staging.

**Export Endpoints to .http Requests** writes a request for every endpoint into one file, with shared variables at the top, so you get a request collection for the whole API.

API Shadow never sends requests itself. Sending is up to REST Client, cURL or another tool, when you choose.

![A NestJS controller with a CodeLens above each handler showing its path, guards, Try it and cURL. Next to it, the .http request opened by Try it, with the base URL, a bearer token variable and a JSON body.](media/requests.png)

### Find endpoints without auth

API Shadow recognises auth middleware, guards and security annotations: `requireAuth`, `passport.authenticate()`, `expressjwt()`, `@UseGuards(JwtAuthGuard)`, global guards (`APP_GUARD`, `app.useGlobalGuards()`), `@PreAuthorize`, `@Secured` and `@RolesAllowed`. It also recognises explicit opt-outs such as `@Public()` and `@PermitAll`. Every endpoint shows its auth in the sidebar and in its CodeLens.

When a project uses auth, write endpoints (POST, PUT, PATCH, DELETE) and admin or internal paths that have none are flagged in the Issues view, the CodeLens and the status bar. A `POST /orders` with no guard next to protected routes deserves a second look. Sign-in, webhook, health and documentation paths are never flagged. Filter the sidebar with `auth:none` to see every unprotected endpoint.

With a Spring Security filter chain (`SecurityFilterChain`, `@EnableWebSecurity`), endpoints show where security is configured, because per-path rules in it aren't analyzed.

![The sidebar filtered to admin endpoints. An Express route shows "Auth: authenticate, requireAdmin"; a NestJS admin endpoint shows the warning "Auth: none found", and its CodeLens in the editor reads "No auth found".](media/auth.png)

### Handlers, middleware and services

- **Express**: app-level, mount-level, router-level and per-route middleware in the order they run; handlers in controller modules and classes; service calls.
- **NestJS**: `@UseGuards`, `@UseInterceptors`, `@UsePipes` and `@UseFilters`; `@Param`, `@Query`, `@Headers` and `@Body` parameters; services injected through the constructor.
- **Spring Boot**: `@PreAuthorize`, `@Secured` and `@RolesAllowed`; `@PathVariable`, `@RequestParam`, `@RequestHeader` and `@RequestBody`; services in `@Autowired` or constructor-injected fields; mappings inherited from interfaces.

Each linked service and handler opens its declaration with a single click.

![A Spring Boot endpoint expanded in the sidebar, showing its security annotation, linked service method, request body type and the context path from application.properties, next to the controller source.](media/spring.png)

### Search, filter and group

Find any endpoint with **API Shadow: Search Endpoints**. Narrow the tree by text or by HTTP method. Group it by controller, file, HTTP method, framework or first path segment.

![The Search API Endpoints quick pick matching "users" across NestJS and Express endpoints, with handler names and source files.](media/search.png)

![The HTTP method filter with DELETE selected. The sidebar shows only DELETE endpoints from all three frameworks, with "5 of 38" in the view header.](media/filter.png)

### Duplicate routes and analysis issues

API Shadow flags potential duplicate routes: the same method and path within one project, even when parameter names differ (`/users/:id` and `/users/:userId`). Duplicates appear in the sidebar, in the Issues view and in the Problems panel.

The Issues view also lists what could not be analyzed (syntax errors, unresolved modules, unsupported files), each linked to its source line, so you know exactly what the tree does and doesn't cover.

![The Issues view listing potential duplicate routes and an analysis limitation, with the duplicate warnings and their related locations shown in the Problems panel.](media/issues.png)

### Export to Markdown, OpenAPI 3.0 and .http

Export everything to a Markdown report, to an **OpenAPI 3.0** document, or to a `.http` request collection. The OpenAPI export contains only what was found in code; request and response schemas are never invented. Endpoints OpenAPI can't represent exactly are listed under `x-api-shadow.skipped` with the reason, rather than approximated.

![A Markdown export of all endpoints rendered in VS Code's Markdown preview, with a table per controller listing method, path, handler, middleware, services and source location.](media/export.png)

### Stays up to date

When you save a relevant file, API Shadow re-analyzes only what changed, so updates take a fraction of a second even in large repositories. Results are cached between sessions.

## Supported patterns

### Express (JavaScript and TypeScript, CommonJS and ESM)

| Pattern | Example |
|---|---|
| Apps and routers | `express()`, `express.Router()`, `Router()`, `require('express')()`, `new Router()`, inline `Router().use(...)` chains |
| Route methods | `get post put patch delete options head all` (and `del`) |
| Route chains | `router.route('/x').get(h).post(h)`, `router.get('/a', h).post('/b', h)` |
| Path forms | string, template literal, `const` strings and `const` object members, `+` concatenation, arrays of paths, regex literals (shown as `prefix ~ /regex/`) |
| Mounting | `app.use('/api', router)`, `app.use(router)`, `app.use('/a', mw1, mw2, router)`, nested routers across files, multiple mount points |
| Imports | `require`, `import` default/named/namespace, `export { default as x } from`, `export * from`, `module.exports = { a, b }`, `exports.x =` |
| Router factories | `app.use('/x', createRouter(db))` where the function returns a router it created |
| Router parameters | `module.exports = (app) => { app.get(...) }` called as `require('./routes')(app)`; parameters typed `Express`, `Router` or `Application`, or untyped and named `app`, `router`, `api`, `server`, `routes` or `r` |
| Class-based servers | `this.app = express()` or `app = express()` class fields with `this.app.use(...)` |
| Handlers | inline functions, local and imported functions, `controller.method`, `instance.method` (`new Controller()`), `.bind(...)`, single-argument wrappers such as `asyncHandler(fn)` |

### NestJS

| Pattern | Example |
|---|---|
| Controllers | `@Controller()`, `@Controller('users')`, `@Controller(['a', 'b'])`, `@Controller({ path, version })` |
| Methods | `@Get @Post @Put @Patch @Delete @Options @Head @All` with no path, a string or an array |
| Global prefix | `app.setGlobalPrefix('api', { exclude: ['health', { path, method }] })`, including `(.*)` and `*` wildcards |
| Versioning | `enableVersioning({ type: VersioningType.URI, prefix, defaultVersion })`, `@Version()`, `VERSION_NEUTRAL`. Header and media-type versioning are noted but add no path prefix |
| Modules | `RouterModule.register([{ path, module, children }])` combined with `@Module({ controllers })` |
| Guards and pipes | `@UseGuards`, `@UseInterceptors`, `@UsePipes`, `@UseFilters` on classes and methods |
| Parameters | `@Param('x')`, `@Query('x')`, `@Headers('x')`, `@Body()` type |
| Services | constructor parameter properties (`constructor(private svc: UsersService)`) and typed fields |

Decorators are recognized only when imported from `@nestjs/*` (aliases are supported), so look-alike decorators never produce false endpoints.

### Spring Boot (Java)

| Pattern | Example |
|---|---|
| Controllers | `@RestController`, `@Controller`, including nested static classes |
| Mappings | `@GetMapping @PostMapping @PutMapping @PatchMapping @DeleteMapping @RequestMapping` with `value` or `path`, arrays, and `method = RequestMethod.X` or `{...}`. `@RequestMapping` without `method` is shown as `ALL` |
| Class level | `@RequestMapping` on the class, both paths and method restriction |
| Constants | `static final String` constants in the same class, other classes (`ApiPaths.V1`), nested classes and interfaces, single and wildcard static imports, `+` concatenation |
| Inheritance | mappings declared on implemented interfaces (OpenAPI Generator `*Api` style) and on abstract base classes |
| Context path | `server.servlet.context-path` and `spring.mvc.servlet.path` from `application.properties` or `application.yml`, per Maven or Gradle module |
| Parameters | `@PathVariable`, `@RequestParam` (`required`, `defaultValue`), `@RequestHeader`, `@CookieValue`, `@RequestBody` type |
| Security | `@PreAuthorize`, `@PostAuthorize`, `@Secured`, `@RolesAllowed`, `@PermitAll`, `@DenyAll` |
| Services | calls on `@Autowired` or constructor-injected fields |

## Known limitations

API Shadow reports what it can prove from the code. When something can't be resolved, it says so in the Issues view instead of guessing.

- **No execution or type checking.** Paths built at runtime (from environment variables, configuration objects or function results) appear as `${expression}`, are marked *dynamic*, and are left out of the OpenAPI export.
- **Express**: routers passed through arbitrary data structures or dependency-injection containers, dynamic `require` paths and routes registered in loops are not followed. Only relative imports are resolved; tsconfig `paths` aliases and `#imports` aren't.
- **NestJS**: middleware configured with `consumer.apply(...).forRoutes(...)` and controllers registered by dynamic modules at runtime aren't shown. One `setGlobalPrefix` per project is used.
- **Spring**: Kotlin controllers are **not supported** (they're reported in the Issues view). Profile-specific configuration (`application-<profile>.yml`), `${...}` placeholders, custom composed mapping annotations, functional routing (`RouterFunction`) and Spring Data REST repositories aren't analyzed.
- **Other frameworks** (Fastify, Koa, Hapi, Micronaut, JAX-RS, …) aren't supported yet.
- Unsaved editor changes are picked up when you save. Files over 512 KB and test files are skipped by default (both configurable).
- Duplicate detection compares method and path with parameter names ignored, within one project. It doesn't consider hosts, headers or `consumes`/`produces` conditions.
- **Auth detection** matches names of middleware, guards, annotations and decorators (configurable with `apiShadow.auth.patterns`). It shows that an auth check is applied, not that it is correct. Checks inside handlers (`if (!req.user)`), per-path rules in a Spring Security filter chain, and NestJS `consumer.apply()` middleware aren't seen.

## Commands

| Command | Description |
|---|---|
| `API Shadow: Refresh Endpoints` | Re-analyze the workspace |
| `API Shadow: Search Endpoints` | Search all endpoints and jump to the selected one |
| `API Shadow: Filter Endpoints by Text` | Match method, path, controller, handler, file, middleware and services; separate terms with spaces. `auth:none`, `auth:protected`, `auth:public` and `auth:central` match the auth status |
| `API Shadow: Filter by HTTP Method` | Show only the selected methods |
| `API Shadow: Clear Filters` | Remove text and method filters |
| `API Shadow: Group Endpoints By…` | Controller, file, HTTP method, framework, first path segment, or a flat list |
| `API Shadow: Export Endpoints to Markdown` | Write a Markdown report |
| `API Shadow: Export Endpoints to OpenAPI 3.0 (JSON)` | Write an OpenAPI 3.0.3 document |
| `API Shadow: Export Endpoints to .http Requests` | Write a request for every endpoint (REST Client / JetBrains HTTP Client format) |
| `API Shadow: Open as HTTP Request` | Open a ready-to-send request for an endpoint beside the code (same as **Try it**) |
| `API Shadow: Copy as cURL` | Copy a cURL command for an endpoint |
| `API Shadow: Clear Analysis Cache and Re-analyze` | Drop cached results and start over |
| `API Shadow: Show Log` | Open the *API Shadow* log (set its level with *Developer: Set Log Level…*) |

Right-click an endpoint for *Go to Handler*, *Open as HTTP Request*, *Copy Path*, *Copy Method and Path* and *Copy as cURL*. The ▷ button on an endpoint row opens its request.

## Settings

| Setting | Default | Description |
|---|---|---|
| `apiShadow.frameworks` | all | Frameworks to detect: `express`, `nestjs`, `spring` |
| `apiShadow.exclude` | `[]` | Extra glob patterns to exclude |
| `apiShadow.includeTestFiles` | `false` | Also analyze `*.spec.*`, `*.test.*`, `__tests__/` and `src/test/` |
| `apiShadow.respectFilesExclude` | `true` | Skip files matched by `files.exclude` |
| `apiShadow.maxFiles` | `20000` | Maximum number of candidate files to analyze |
| `apiShadow.maxFileSizeKB` | `512` | Skip larger files (usually generated or bundled code) |
| `apiShadow.autoRefresh` | `true` | Re-analyze when files change |
| `apiShadow.refreshDebounceMs` | `800` | Delay after the last change before re-analyzing |
| `apiShadow.groupBy` | `controller` | Default grouping of the Endpoints view |
| `apiShadow.diagnostics.duplicates` | `true` | Show potential duplicate routes in the Problems panel |
| `apiShadow.showStatusBar` | `true` | Show the endpoint count in the status bar |
| `apiShadow.spring.applyContextPath` | `true` | Prefix Spring endpoints with the configured context path |
| `apiShadow.persistCache` | `true` | Keep analysis results between sessions |
| `apiShadow.export.includeSourceLocations` | `true` | Include file paths and line numbers in exports |
| `apiShadow.codeLens.enabled` | `true` | Show method, path, auth and request actions above each endpoint |
| `apiShadow.requests.baseUrl` | `""` | Base URL for requests and cURL; empty uses `http://localhost:<detected port>` |
| `apiShadow.auth.enabled` | `true` | Detect auth middleware, guards and security annotations |
| `apiShadow.auth.warnings` | `sensitive` | Endpoints without auth to report: `sensitive` (writes and admin paths), `all`, or `off` |
| `apiShadow.auth.patterns` | see settings | Regular expressions for auth middleware, guards and annotations; add your own names here |
| `apiShadow.auth.publicPatterns` | see settings | Regular expressions for explicit opt-outs such as `@Public()` |

`node_modules`, `.git`, `dist`, `out`, `build`, `target`, `coverage`, `.next`, `.gradle` and similar folders are always excluded.

## Privacy and security

- **Your code is never executed.** Files are only read and parsed. Nothing is required, compiled or evaluated, so API Shadow also works in Restricted Mode.
- **Nothing leaves your machine.** API Shadow makes no network requests and has no telemetry or AI services. **Try it** and **Copy as cURL** only produce text. Requests are sent only when you send them yourself, with REST Client or cURL.
- **Secrets stay put.** `.env` files are never read. From Spring configuration files, only the context-path and `server.port` settings are kept; every other value is discarded immediately and never logged, cached or exported. Middleware labels never include call arguments, so a call such as `basicAuth({ users: { admin: '…' } })` appears as `basicAuth()`.
- The cache holds only structural facts (routes, names, line numbers), stores them in VS Code's workspace storage, and can be cleared at any time.

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for building, testing and packaging, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the analysis works.

## License

[MIT](LICENSE)
