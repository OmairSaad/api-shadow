# API Shadow architecture

This document is for contributors. It explains how endpoints are discovered and where to change things.

## Layers

```
src/
  core/        Host-agnostic engine, data model, path utilities, filtering/grouping, duplicates, excludes
  analyzers/   Per-file fact extraction (Babel AST for JS/TS, java-parser CST for Java, Spring config)
  linkers/     Cross-file resolution: Express router graph, NestJS prefixes/modules, Spring mappings/constants
  export/      Markdown and OpenAPI 3.0 writers
  vscode/      VS Code integration: file host, controller (watching, debouncing, cancellation, cache),
               tree views, commands, diagnostics, config, logging
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
4. **Post-processing**: duplicate detection (`core/duplicates.ts`), issue de-duplication, sorting.

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
- `DuplicateDiagnostics`: Problems-panel warnings with related locations.
- Commands accept optional arguments (`filter('text')`, `filterByMethod(['GET'])`, `groupBy('method')`, `exportMarkdown(uri)`) so they can be scripted and tested without UI. Without arguments they open quick inputs and dialogs.
- `activate` returns `ApiShadowApi` (`getResult`, `refresh`, `whenIdle`, `onDidChangeResult`, tree access), used by the integration tests.

## Why no webview?

Everything the UI needs (hierarchy, icons, descriptions, tooltips, inline actions, filtering via quick input) is available in native TreeViews. These are keyboard- and screen-reader-accessible, theme-aware, and cheaper than a webview. A webview would only be justified for richer visualisations, such as a dependency graph.

## Tests

| Suite | Runner | What it covers |
|---|---|---|
| `test/unit` | Vitest | analyzers and linkers on fixture projects and inline snippets, engine incrementality/cancellation/limits/cache, exporters (OpenAPI validated with swagger-parser), secrets never leaking, filtering, grouping, duplicates |
| `test/integration` | Mocha in Extension Development Host (`@vscode/test-cli`) | activation, commands, tree contents, filters/grouping, navigation, diagnostics, exports, file watching, configuration changes |
| `test/e2e` | Playwright `_electron` driving VS Code | real UI: activity bar, tree clicks, twisties, view toolbar, command palette, multi-select quick picks, keyboard navigation, Issues view, Problems panel, save dialog, live updates; saves screenshots |

`scripts/screenshots/capture.spec.ts` reuses the UI test harness to generate the Marketplace images in `media/` (`npm run screenshots`).

Fixture projects live in `test/fixtures/{express-app,nest-app,spring-app}`. They include intentional duplicates, a broken JS file, a broken Java file, a Kotlin controller, a `node_modules` decoy and a secret in `application.properties`, which the tests verify never leaks.
