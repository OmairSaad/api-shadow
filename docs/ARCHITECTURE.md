# API Shadow architecture

This document is for contributors. It explains how endpoints are discovered and where to change things.

## Layers

```
src/
  core/        Host-agnostic engine, data model, path utilities, filtering/grouping, duplicates, excludes
  analyzers/   Per-file fact extraction (Babel AST for JS/TS, java-parser CST for Java, Spring config)
  linkers/     Cross-file resolution: Express/Fastify/Koa router graph, NestJS prefixes/modules, Spring mappings/constants, imported JS path constants
  export/      Markdown, OpenAPI 3.0, cURL and .http writers
  vscode/      VS Code integration: file host, controller (watching, debouncing, cancellation, cache),
               tree views, CodeLens, go to definition and hovers on client calls, workspace symbols,
               request flow webview, commands, diagnostics, config, logging
  extension.ts Activation; wires the above together and returns a small public API
```

Only `src/vscode/**` and `src/extension.ts` import `vscode`. Everything else runs in plain Node, which is what the unit tests use.

## Pipeline

```
FileHost.listFiles ──► kind + exclusion ──► per-file facts (cached) ──► linkers ──► endpoints
                                              ▲                            │
                                              └──── requested files ◄──────┘   (up to 4 rounds)
                                                                               │
                                                     duplicates + issues ◄─────┘
```

1. **Discovery** (`VscodeFileHost.listFiles`): `workspace.findFiles` for sources (`js/ts/jsx/tsx/mjs/cjs/mts/cts/java/kt`), Spring config files (`application.{properties,yml,yaml}`) and project markers (`package.json`, `pom.xml`, `build.gradle[.kts]`). Dependency, build and VCS folders are excluded in the ripgrep query itself; user globs, `files.exclude`, and test patterns are applied with `PathExcluder`.
2. **Per-file analysis** (`AnalysisEngine.ensure`): a file is re-read only when it is marked changed (watcher) or, on a full refresh, its `mtime`/`size` differ from the cache. A cheap regex pre-filter (`isJsCandidate`, `isJavaCandidate`) skips files that can't declare routes. Analyzers return **facts**: JSON-serialisable records with no source text (`analyzers/facts.ts`).
3. **Linking**: linkers read facts only. When a linker needs a file the pre-filter skipped (an imported controller, a service, a `ApiPaths.java` constants class), it calls `LinkContext.getFacts`/`requestJavaClass`. The engine parses the requested files and links again (bounded to 4 rounds).
   Before linkers see a JS file's facts, `LinkContext.getFacts` resolves path parts that reference imported constants (`ref` parts recorded by the analyzer for imported names in path positions) against the exporting file's `constants`, following re-exports (`linkers/jsConstants.ts`). `app.use(IMPORTED, x)` records `maybePath`: it becomes the mount path only if it resolves to a string, and stays middleware otherwise. Unresolved references become `dynamic` parts.
4. **Post-processing**: duplicate detection (`core/duplicates.ts`), auth classification (`core/auth.ts`), listening ports per project (`servers`), issue de-duplication, sorting.

## Unreachable routes

Linkers record where each endpoint was registered (`LinkContext.registrations`): a chain of `{ scope, order }` from the root app down, where `scope` is a router node in one file and `order` the position of the route or mount within it. `core/shadowing.ts` compares two endpoints only where their chains share a scope, so "registered first" is always well defined, and uses `core/routeMatch.ts` to test whether the earlier pattern accepts every request of the later one (`shadows`). Handlers whose arity includes `next` (3 for Express, 2 for Koa) are pass-through and never shadow. NestJS records method order per controller. Spring and Fastify are excluded: they choose the most specific route.

## Client calls

The JS analyzer records `ClientCallFact`s for `fetch`/`$fetch`/`useFetch`, axios (default import, `axios.create` instances with their `baseURL`), ky, superagent, got, Angular `HttpClient` (`this.http` typed `HttpClient`), supertest (`request(app).get(...)`) and imported client instances named like `api`/`http`/`client`. Imported instances only count when the arguments can't be a route registration (`looksLikeHandler`). Client detection runs before route detection in `visitCall`. The Java analyzer scans tokens for MockMvc request builders, WebTestClient `.get().uri(...)` and TestRestTemplate calls.

`core/clientCalls.ts` parses each URL (`parseClientUrl`: origin, query and hash dropped; `${...}` segments unknown; a leading unknown part or an imported instance means an unknown prefix, matched as a suffix) and scores it against every endpoint (`matchScore`), keeping the best matches. A call with no match is reported only if its first fixed segment appears in some route, so calls to other services are ignored. Test files are listed by the host in `read` mode and excluded from the linkers' fact map in the engine; their calls count as tests.

## API diff

`core/gitHost.ts` is a `FileHost` over a commit: `ls-tree -r -l -z` lists blobs and sizes, and one `cat-file --batch` process reads them. A second `AnalysisEngine` analyzes the revision with the current settings, and `core/apiDiff.ts` pairs endpoints by framework, method, normalised path, version and conditions. Only run in trusted workspaces.

## Auth detection

`core/auth.ts` classifies each endpoint after linking, from names only:

- `public` when a middleware entry or marker matches `apiShadow.auth.publicPatterns` (`@Public()`, `@PermitAll`, `permitAll()`); this wins, because opt-outs exist to bypass a global guard.
- `protected` when one matches `apiShadow.auth.patterns`.
- `central` when the project has a Spring Security configuration class (`securityConfig` in the Java facts: a `SecurityFilterChain`/`SecurityWebFilterChain` bean, `@EnableWebSecurity`, or a `WebSecurityConfigurerAdapter` subclass). Per-path rules are not analyzed.
- `none` otherwise.

Markers are custom (non-`@nestjs`) decorators on Nest handlers and controllers, recorded without arguments. Global guards (`APP_GUARD` providers, `app.useGlobalGuards()`) are prepended to the middleware of every Nest endpoint in the project by the linker.

`no-auth` issues are raised only in projects where at least one endpoint is not `none`, and by default (`sensitive`) only for write methods and admin/internal paths, never for sign-in, webhook, health or docs paths (`shouldWarn`). The default patterns deliberately leave out names that sound like auth but don't enforce it (`passport.initialize()`, helmet's `contentSecurityPolicy()`, `express-session`, `ThrottlerGuard`); `test/unit/auth.test.ts` pins both lists, and checks that `package.json` declares the same defaults.

Facts are versioned with `FACTS_VERSION`. Bump it whenever extraction semantics change, so persisted caches are discarded.

## Analyzers

### JavaScript / TypeScript (`analyzers/jsAnalyzer.ts`)

- Parsed with `@babel/parser` (`errorRecovery`, TypeScript or JSX depending on extension, legacy decorators). If Babel can't recover, `parseJs` searches for up to 3 lines near the reported error whose blanking (replaced by spaces, so offsets and lines are preserved) makes the file parse, and reports which lines were ignored.
- A single recursive walk keeps a lexical `Scope` chain with bindings: router nodes, functions, classes, instances, aliases, string constants and shadowed names. Function declarations and arrow-function constants are hoisted.
- References are recorded as `RefExpr` values (`node`, `fn`, `import`, `call`, `instance`, `class`), not resolved immediately. That keeps per-file facts independent of other files, which makes caching sound.
- Express: route calls on router references (`x.get(path, ...)`, `x.route(p).get(...)`), `use` mounts (each argument kept as a candidate so the linker decides router vs middleware), injections (`fn(app)`), exports and imports.
- NestJS: decorators are matched only if imported from `@nestjs/*`. Controllers, methods, parameter decorators, guards, `setGlobalPrefix`, `enableVersioning`, `@Module({ controllers })`, `RouterModule.register`.
- Service calls: `this.dep.method()` for injected/typed dependencies, and `importedServiceModule.method()` where the binding or module path looks like a service. The heuristic is intentionally narrow.

### Java (`analyzers/javaAnalyzer.ts`)

- Parsed with `java-parser` (Chevrotain CST, Java 21 syntax). The CST groups children by kind, so token order is restored by `startOffset` before evaluating expressions.
- Annotation values are evaluated as sequences of string literals, `+` and constant references (`ref` path parts), resolved later by the linker. Anything else becomes a `dynamic` part.
- Classes and interfaces (including nested ones) record mappings, security annotations, `extends`/`implements`, typed fields, methods, parameters and `field.method(...)` calls.
- A Java file that fails to parse is reported; there is no partial recovery for Java.

### Spring configuration (`analyzers/springConfig.ts`)

Reads only the context-path keys. All other values are discarded during parsing.

## Linkers

### Express (`linkers/expressLinker.ts`)

Builds a graph of router nodes across files:

- `RefExpr` resolution follows relative imports (`resolveModule`: extension probing, `index.*`, `.js → .ts` mapping), named, default, CommonJS and namespace exports, `export *`, re-exports, class instances (`new X()` → class methods), and factory functions (`returns`).
- Edges come from `use` mounts (with the mount path and the middleware preceding the router in that call) and from injections (`fn(app)` binds the function's router parameter node to `app`).
- Roots are apps with no incoming edge, plus orphan routers (reported, shown relative). A DFS accumulates prefixes and middleware, detects cycles, and emits one endpoint per reachable path.
- Router-level `router.use(mw)` applies to routes declared after it in the same file (path-scoped when given a path).

### NestJS (`linkers/nestLinker.ts`)

Per project root (nearest `package.json`), combines `setGlobalPrefix` (+ `exclude`), URI versioning, `RouterModule` module prefixes (via `@Module({ controllers })`), controller paths and method paths. The order matches Nest: `/globalPrefix/version/routerModulePath/controller/method`.

### Spring (`linkers/springLinker.ts`)

Indexes classes by simple name and FQN, and constants by `Class.NAME` (plus every nested-class suffix). Concrete controller classes collect their own mappings plus those inherited from interfaces and superclasses (an own mapping wins). Constant references resolve through the class chain, static imports, wildcard static imports and inherited interfaces. The context path is applied per module (nearest `pom.xml`/`build.gradle`).

## VS Code layer

- `AnalysisController`: owns the engine. File watchers mark changed files (or a structural change), then trigger a debounced refresh. `refresh()` cancels the in-flight run (`CancellationTokenSource`) and chains the new run after it, so runs never overlap. Results are published through an event. The facts cache is persisted to `context.storageUri` after a short delay.
- `EndpointTreeProvider` / `IssuesTreeProvider`: native TreeViews (no webview). Every item has stable ids (expansion state survives refreshes), accessible labels, theme-colour method icons with the method also in text, and Markdown tooltips with `isTrusted = false`.
- Name-keyed fact records are read with `own()` (`core/records.ts`) and keyword tables are built with `table()`, so source names like `constructor` never resolve to `Object.prototype` members.
- `DuplicateDiagnostics`: Problems-panel warnings with related locations.
- `EndpointCodeLensProvider`: lenses above each endpoint's declaration line. Results come from the last analysis (on save); while a document is dirty, each lens follows the text of its original line within ±200 lines and is hidden if that text is gone.
- Request commands (`copyCurl`, `openRequest`, `exportHttp`) use `export/requests.ts`. The base URL is the setting, else `http://localhost:<port>` from `result.servers` (`app.listen(...)` in JS facts, `server.port` in Spring config), else 3000/8080.
- Commands accept optional arguments (`filter('text')`, `filterByMethod(['GET'])`, `groupBy('method')`, `exportMarkdown(uri)`) so they can be scripted and tested without UI. Without arguments they open quick inputs and dialogs.
- `activate` returns `ApiShadowApi` (`getResult`, `refresh`, `whenIdle`, `onDidChangeResult`, tree access), used by the integration tests.

## Native views first

Everything the sidebar needs (hierarchy, icons, descriptions, tooltips, inline actions, filtering via quick input) is available in native TreeViews. These are keyboard- and screen-reader-accessible, theme-aware, and cheaper than a webview. The only webview is the request flow diagram (`vscode/flowView.ts`), a visualisation TreeViews can't express. It uses a strict CSP (no remote content, one nonce'd inline script), escapes every value, styles itself with theme variables, and makes clickable steps keyboard-focusable.

## Tests

| Suite | Runner | What it covers |
|---|---|---|
| `test/unit` | Vitest | analyzers and linkers on fixture projects and inline snippets, engine incrementality/cancellation/limits/cache, exporters (OpenAPI validated with swagger-parser), cURL and `.http` requests, auth detection and warnings, secrets never leaking, filtering, grouping, duplicates |
| `test/integration` | Mocha in Extension Development Host (`@vscode/test-cli`) | activation, commands, tree contents, filters/grouping, navigation, diagnostics, exports, CodeLens, request commands, file watching, configuration changes |
| `test/e2e` | Playwright `_electron` driving VS Code | real UI: activity bar, tree clicks, twisties, view toolbar, command palette, multi-select quick picks, keyboard navigation, Issues view, Problems panel, save dialog, clicking a CodeLens, live updates; saves screenshots |

`scripts/screenshots/capture.spec.ts` reuses the UI test harness to generate the Marketplace images in `media/` (`npm run screenshots`).

Fixture projects live in `test/fixtures/{express-app,nest-app,spring-app}`. They include intentional duplicates, a broken JS file, a broken Java file, a Kotlin controller, a `node_modules` decoy and a secret in `application.properties`, which the tests verify never leaks.
