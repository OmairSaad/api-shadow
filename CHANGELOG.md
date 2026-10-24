# Changelog

## 0.5.0

- **Laravel (PHP) support**: routes from `routes/*.php` with `Route::get/post/put/patch/delete/any/match`, `view` and `redirect`; `resource`, `apiResource`, `resources` and `singleton` with `only`/`except`/`parameters`/`names` and nested resources; array and fluent groups with prefixes, middleware, names and controllers; route files loaded by `withRouting()` (including `apiPrefix` and the `/up` health route), service providers and `require`; the `/api` prefix of `routes/api.php`. Routes link to their controller methods (FormRequest and `$request->validate()` validation, response shapes, route model binding, injected services), `auth:sanctum` and `can:` count as auth, and frontend calls and feature tests (`$this->getJson()`) are matched to them.
- Impact analysis, response checks, the Security Radar (raw SQL with input, `$request->all()` written to models, `config/cors.php`, `'debug' => true`, credentials in PHP config), the dependency graph and the dashboard cover Laravel endpoints. **Generate API Tests…** writes PHPUnit feature tests.
- CodeLens summarizes lines that declare several routes (resource routes) instead of repeating actions for each.
- `vendor/` folders are excluded from analysis.
- **Dashboard endpoint details** redesigned: *How this path is built* lists every mount, prefix, group, context path and loaded route file in order, and each step opens where it is declared (Express mounts, NestJS global prefix, versioning and controller path, Spring context path and class mapping, Laravel groups, providers and `withRouting()`). Actions for Request Flow, Try it, cURL, callers and tests; parameters table; status codes as chips; middleware in order with auth highlighted; the endpoint's security findings; copy path.
- **Where an endpoint is mounted**, one click away: the API Explorer has a *Mounted at* column, and the sidebar lists each endpoint's mounts and prefixes; both open the line that declares them.
- **API map** in the API Explorer: the API as a tree of path prefixes, with endpoint counts, methods and every place a prefix is mounted. Filter, expand and collapse; endpoints open their details.
- **API at a glance** on the Overview: endpoints by method and the largest path prefixes with where they are mounted.
- The Request Flow view opens each mount step at its source.
- API Explorer: sortable columns, arrow-key navigation through endpoints, a sticky header.
- Dependency graph: panning no longer clears the selected node; Esc clears it, and the zoom level is shown.

## 0.4.1

- API Shadow now activates in large workspaces and parent folders. It used to search every folder (including `node_modules`) for a `package.json`, `pom.xml` or Gradle build, and VS Code gave up and never started it.
- `fetch(url, requestOptions)` uses the method of a local options object (`const requestOptions = { method: 'POST' }`). These calls were read as GET and reported as calls to missing routes. When the options can't be read, the call matches any method.

## 0.4.0

- **Dashboard** (**API Shadow: Open Dashboard**, or click the status bar): overview, a searchable API explorer with callers, inferred responses and tests, impact analysis, security, dependency graph, contract comparison and test generation in one view.
- **Change impact**: response shapes are inferred from handlers (literals, statuses, thrown Nest exceptions, Nest DTO types, Spring DTOs, records and Jackson annotations) and response reads are followed through client code (fetch, axios, supertest, React state, react-query, service modules across files). Compared with git HEAD (or a chosen branch, tag or snapshot), removed, renamed and retyped fields, moved routes, new required parameters and changed statuses are reported at the client code that reads them, with risk, evidence and a quick fix for renames.
- **Reads of missing response fields** are reported where they happen, with *Did you mean …?*.
- **OpenAPI contract comparison**: working tree vs. a revision, two revisions, two files, or contract vs. implementation, classified as breaking, potentially breaking, non-breaking or informational.
- **Security Radar**: hardcoded credentials (redacted, never stored), sensitive response fields, missing auth, permissive CORS, mass assignment, object-level authorization, injection, open redirects, path traversal, error details and exposed actuator endpoints, each with severity, confidence, evidence and mitigation. A Security view, Problems-panel entries, dismissals and rule/file exclusions.
- **Dependency graph** from components to repositories, with search, filters, impact highlighting, keyboard navigation and Mermaid/JSON export.
- **Test generation**: Jest, Vitest or Mocha with Supertest, and JUnit 5 with MockMvc, previewed and written only after confirmation, never over existing files.
- **Analysis report** in Markdown with overview, impact, coverage findings (unmatched requests, potentially unused and dynamic routes), security findings and inventory.
- The OpenAPI export includes responses inferred from code, marked `x-api-shadow-inferred`.
- Endpoints have a confidence (resolved, relative to an unmounted router, dynamic). Service → repository links for Spring and data access for JS services.
- `tsconfig.json`/`jsconfig.json` `paths` and `baseUrl`, and the `@/` → `src/` convention, are resolved for imports.
- The root `.gitignore` of each workspace folder is respected (`apiShadow.respectGitignore`).
- Fewer false duplicate routes:
  - Routers whose mount point was not found (mounted in a loop, through `require()` of a computed path, or by an app that wasn't analysed) are no longer compared with each other. Each router's `POST /` used to be reported as a duplicate of every other router's.
  - `ALL` routes are compared only with other `ALL` routes, so `router.all('*', auth)`, `router.all('/x', mw)` and a `.route('/x')…all(405)` fallback are no longer reported. An `ALL` route that answers requests before a route on the same path is reported as unreachable.
  - A handler that calls `next()` hands the request on and isn't counted as a second route. `next(err)` doesn't count.

## 0.3.0

- **Unreachable routes**: routes that can never run because an earlier route on the same router matches every request they would get (`GET /users/:id` before `GET /users/me`, a catch-all before API routes). Covers Express, Koa and NestJS, across mounted routers, with regex constraints. Shown in the sidebar, the CodeLens and the Problems panel, with a link to the route that catches the requests.
- **Frontend ↔ backend linking**: HTTP calls in frontend and test code (`fetch`, axios and axios instances, ky, `$fetch`, Angular `HttpClient`, supertest, Spring MockMvc, WebTestClient, TestRestTemplate) are matched to endpoints. Ctrl+click a URL to open the handler; hover for details; a CodeLens above each call names its endpoint.
- **Calls to missing routes** are reported in the Issues view and the Problems panel, with a hint when only the HTTP method is wrong.
- **Callers and test coverage** per endpoint, in the sidebar, the CodeLens and tooltips; **Show Callers** peeks them all. Optionally list endpoints nothing calls (`apiShadow.clientCalls.reportUncalled`).
- **API diff**: **Compare API with Branch or Tag…** analyzes any git revision without checking it out and reports added, removed and changed endpoints, flagging breaking changes and removed auth.
- **Request flow** diagram: callers, mounts, middleware, auth, validation, handler and services, each clickable.
- **Request body validation**: validation middleware, handler schema checks, NestJS pipes, `@Valid` and Fastify schemas are recognised; unvalidated bodies are reported in projects that validate others.
- **Fastify** support: routes, `route({...})`, plugins with prefixes (including `fastify-plugin` and inline plugins), hooks, body schemas, `listen({ port })`.
- **Koa** support: `@koa/router` and `koa-router`, prefixes, nested routers, named routes, `del`.
- **Ctrl+T**: endpoints appear in Go to Symbol in Workspace.
- Test files are read for coverage; their routes are still not shown as endpoints unless `apiShadow.includeTestFiles` is on.
- The Issues view opens bug sections (unreachable, missing routes, duplicates, parse errors) and keeps review lists collapsed.

## 0.2.0

- **CodeLens** above every route declaration: full method and path, auth, duplicate warnings, and request actions.
- **Try it**: open a ready-to-send `.http` request (REST Client / JetBrains HTTP Client format) beside the code, with path parameters, required query parameters, headers, a JSON body and a bearer token header filled in.
- **Copy as cURL** from the CodeLens, the endpoint context menu or the Command Palette.
- **Export Endpoints to .http Requests**: a request collection for the whole API, with shared variables.
- The base URL uses the port from `app.listen()` or `server.port`, or the new `apiShadow.requests.baseUrl` setting.
- **Auth detection**: auth middleware, guards and security annotations, global NestJS guards (`APP_GUARD`, `app.useGlobalGuards()`), explicit opt-outs (`@Public()`, `@PermitAll`), and Spring Security filter chains. Shown in the sidebar, the CodeLens, tooltips and the Markdown export.
- **Endpoints without detected auth**: write endpoints and admin paths without auth, in projects that use auth elsewhere, are listed in the Issues view and counted in the status bar (`apiShadow.auth.warnings`).
- The text filter matches `auth:none`, `auth:protected`, `auth:public` and `auth:central`.
- Global NestJS guards are now listed in each endpoint's middleware, with a note saying where they come from.
- **Path constants imported from other files are resolved**: `router.get(ROUTES.SHOPIFY)`, `` `${API}/orders` ``, `API + ROUTES.USERS`, `app.use(PATHS.V1, router)`, `@Controller(PATHS.CATS)`, through named, default, namespace and `require()` imports, nested objects, `Object.freeze`, TypeScript enums and barrel re-exports. These paths used to show as `${...}`.

### Fixes

- **False duplicate routes**: routes whose paths contained parts that couldn't be resolved (for example imported constants) were all treated as the same route. Unresolved parts are now compared literally, and calls such as `getPath('a')` never make two routes equal.
- Duplicate detection now uses each framework's own parameter syntax (a `:` in a Spring path such as `/users:batchGet` is literal text), keeps regex constraints (`/p/:id(\d+)` and `/p/:slug` match different requests), and ignores routes that differ only in NestJS header or media-type version, or in Spring `params`, `headers`, `consumes` or `produces` conditions.
- One declaration reached twice through the analysis is no longer reported as a duplicate of itself.
- Code that names functions or variables after `Object.prototype` members (`constructor`, `toString`) could make a file fail to analyze.

## 0.1.0

Initial release.

- Static discovery of Express, NestJS and Spring Boot (Java) endpoints.
- Endpoints sidebar with grouping, text and HTTP-method filters, search, and navigation to source.
- Controller → service relationships where statically identifiable.
- Potential duplicate route detection (sidebar, Issues view and Problems panel).
- Issues view listing parse errors and analysis limitations.
- Export to Markdown and OpenAPI 3.0 JSON.
- Incremental re-analysis on file changes, cancellation, and a persistent per-file cache.
