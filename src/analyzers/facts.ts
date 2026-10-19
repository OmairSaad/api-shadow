/**
 * Per-file "facts" extracted by analyzers. Facts are plain JSON so they can be cached between
 * sessions; cross-file reasoning (router mounting, constant resolution, service lookup) happens
 * later in the linkers, which only ever see facts, never source code.
 */
import type { EndpointParameter, HttpMethod, PathExpr, ServiceCall } from '../core/types';

/** Bump whenever the facts shape or extraction semantics change, to invalidate persisted caches. */
export const FACTS_VERSION = 8;

export interface Pos {
  line: number;
  column: number;
}

export interface FileIssue {
  severity: 'info' | 'warning' | 'error';
  kind: 'parse-error' | 'limitation';
  message: string;
  pos?: Pos;
}

// ---------------------------------------------------------------------------------------------
// JavaScript / TypeScript (Express + NestJS)
// ---------------------------------------------------------------------------------------------

/** A reference to something router-like or callable, resolved by the Express linker. */
export type RefExpr =
  /** A router/app created in this file (`express()`, `Router()`), or a router-typed parameter. */
  | { k: 'node'; key: string }
  /** A function declared in this file. */
  | { k: 'fn'; key: string }
  /** An imported binding. `name` is `default`, `*` (namespace), `*cjs` (whole `require()`), or a named export. */
  | { k: 'import'; source: string; name: string; member?: string }
  /** The result of calling a function (router factories). */
  | { k: 'call'; callee: RefExpr }
  /** `new SomeClass()` exported as a singleton. */
  | { k: 'instance'; className: string }
  /** A class declared in this file. */
  | { k: 'class'; name: string };

/** Router library of a node; `param` nodes take it from whatever they are attached to. */
export type RouterLib = 'express' | 'fastify' | 'koa';

export interface RouterNodeFact {
  key: string;
  kind: 'app' | 'router' | 'param';
  lib?: RouterLib;
  /** Prefix applied to every route of the router (`new Router({ prefix })`, `router.prefix()`). */
  prefix?: PathExpr;
  /** Variable name as written. */
  name: string;
  pos: Pos;
}

export interface HandlerFact {
  /** Display name of the handler (`list`, `UserController.list`, `(anonymous)`). */
  name: string;
  /** Receiver for `ctrl.list`-style handlers. */
  controller?: string;
  /** Reference to the handler function when it is not inline. */
  ref?: RefExpr;
  /** Member name when the handler is `ref.member`. */
  member?: string;
  pos: Pos;
  /** Service calls found in an inline handler body. */
  serviceCalls: ServiceCall[];
  /** Parameter count of an inline handler (Express passes `next` third, Koa second). */
  arity?: number;
  /** Inline handler checks the request body against a schema (`schema.parse(req.body)`). */
  validatesBody?: boolean;
}

export interface ExpressRouteFact {
  router: RefExpr;
  method: HttpMethod;
  paths: PathExpr[];
  middleware: string[];
  handler?: HandlerFact;
  /** Fastify route options declare a body schema. */
  bodySchema?: boolean;
  pos: Pos;
  order: number;
}

export interface MountChildCandidate {
  ref?: RefExpr;
  text: string;
}

export interface ExpressMountFact {
  parent: RefExpr;
  paths: PathExpr[];
  /** All non-path arguments in order. The linker decides which are routers vs middleware. */
  args: MountChildCandidate[];
  /**
   * The first argument references an import that may be a path constant (`app.use(PATHS.V1, r)`)
   * or middleware (`app.use(authenticate, r)`). If it resolves to a constant, it is the mount path
   * and `args[0]` is dropped; otherwise it stays middleware.
   */
  maybePath?: PathExpr;
  pos: Pos;
  order: number;
}

export interface ExpressInjectionFact {
  /** Function receiving a router/app argument (e.g. `registerRoutes(app)`). */
  callee: RefExpr;
  argIndex: number;
  parent: RefExpr;
  pos: Pos;
  /** Prefix for routes the function registers (Fastify `register(plugin, { prefix })`). */
  paths?: PathExpr[];
}

export interface CallableFact {
  key: string;
  name: string;
  pos: Pos;
  /** Indexes of parameters that are used as routers inside the function body. */
  routerParams: number[];
  /** What the function returns when it is a router factory. */
  returns?: RefExpr;
  serviceCalls: ServiceCall[];
  /** Parameter count. */
  arity?: number;
  /** Checks the request body against a schema. */
  validatesBody?: boolean;
}

export interface ClassFact {
  name: string;
  pos: Pos;
  /** method name -> callable key */
  methods: Record<string, string>;
  /** property name -> declared type (constructor parameter properties and typed fields). */
  deps: Record<string, string>;
}

export interface NestParamFact extends EndpointParameter {
  /** `@Body()` etc. that apply to the whole object. */
  whole?: boolean;
}

export interface NestMethodFact {
  name: string;
  pos: Pos;
  method: HttpMethod;
  paths: PathExpr[];
  versions: string[];
  middleware: string[];
  /** Decorators not imported from `@nestjs/*`, as written (`@Public()`, `@Roles('admin')`). */
  markers: string[];
  params: NestParamFact[];
  bodyType?: string;
  /** Pipes passed to `@Body(...)`. */
  bodyPipes?: string[];
  serviceCalls: ServiceCall[];
}

export interface NestControllerFact {
  className: string;
  pos: Pos;
  paths: PathExpr[];
  versions: string[];
  middleware: string[];
  markers: string[];
  methods: NestMethodFact[];
  deps: Record<string, string>;
}

export interface NestGlobalPrefixFact {
  prefix: PathExpr;
  /** Excluded routes, as raw path strings (method-specific excludes are recorded with method). */
  exclude: { path: string; method?: HttpMethod }[];
  pos: Pos;
}

export interface NestVersioningFact {
  type: 'URI' | 'HEADER' | 'MEDIA_TYPE' | 'CUSTOM' | 'UNKNOWN';
  prefix: string | false;
  defaultVersions: string[];
  pos: Pos;
}

/** A guard applied to every route: `app.useGlobalGuards(new X())` or `{ provide: APP_GUARD, useClass: X }`. */
export interface NestGlobalGuardFact {
  name: string;
  via: 'useGlobalGuards' | 'APP_GUARD' | 'useGlobalPipes' | 'APP_PIPE';
  pos: Pos;
}

export interface NestModuleFact {
  name: string;
  controllers: string[];
  pos: Pos;
}

export interface NestRouterModuleRoute {
  path: string;
  module?: string;
  children: NestRouterModuleRoute[];
}

/** An outgoing HTTP call (`fetch('/api/x')`, `axios.post(url)`, `request(app).get('/x')`). */
export interface ClientCallFact {
  client: string;
  /** Undefined when the method could not be determined. */
  method?: HttpMethod;
  url: PathExpr;
  /** The URL is relative to a base we can't see (an axios instance, an injected client). */
  unknownBase?: boolean;
  pos: Pos;
  start: Pos;
  end: Pos;
}

export interface JsFileFacts {
  lang: 'js';
  imports: Record<string, { source: string; name: string }>;
  exports: Record<string, RefExpr>;
  starExports: string[];
  routers: RouterNodeFact[];
  routes: ExpressRouteFact[];
  mounts: ExpressMountFact[];
  injections: ExpressInjectionFact[];
  callables: Record<string, CallableFact>;
  classes: Record<string, ClassFact>;
  nestControllers: NestControllerFact[];
  nestGlobalPrefix?: NestGlobalPrefixFact;
  nestVersioning?: NestVersioningFact;
  nestModules: NestModuleFact[];
  nestRouterModule: NestRouterModuleRoute[];
  nestGlobalGuards: NestGlobalGuardFact[];
  /** `app.useGlobalPipes(new ValidationPipe())` and `{ provide: APP_PIPE, ... }`. */
  nestGlobalPipes: NestGlobalGuardFact[];
  clientCalls: ClientCallFact[];
  /**
   * Exported string constants, for path parts that reference imports. Keys are export names,
   * with members joined by dots: `ROUTES.SHOPIFY`, `default.BASE`, and plain keys for
   * `module.exports = { BASE }`. Values may reference this file's own imports.
   */
  constants: Record<string, PathExpr>;
  /** Port from `app.listen(3000)` / `app.listen(process.env.PORT ?? 3000)`. */
  listenPort?: { port: number; pos: Pos };
  issues: FileIssue[];
}

// ---------------------------------------------------------------------------------------------
// Java (Spring)
// ---------------------------------------------------------------------------------------------

export interface JavaMapping {
  methods: HttpMethod[];
  paths: PathExpr[];
  /** `params`, `headers`, `consumes` and `produces` attributes as written, e.g. `params = "type=a"`. */
  conditions: string[];
}

export interface JavaMethodFact {
  name: string;
  pos: Pos;
  mapping?: JavaMapping;
  security: string[];
  params: EndpointParameter[];
  bodyType?: string;
  /** The `@RequestBody` parameter is annotated `@Valid` / `@Validated`. */
  bodyValidated?: boolean;
  calls: ServiceCall[];
}

export interface JavaClassFact {
  name: string;
  /** Outer classes, outermost first. */
  outer: string[];
  kind: 'class' | 'interface';
  pos: Pos;
  isController: boolean;
  isAbstract: boolean;
  mapping?: JavaMapping;
  security: string[];
  extends: string[];
  implements: string[];
  /** field name -> simple type name */
  fields: Record<string, string>;
  methods: JavaMethodFact[];
}

export interface JavaFileFacts {
  lang: 'java';
  packageName: string;
  /** simple name -> fully qualified name */
  imports: Record<string, string>;
  /** statically imported member simple name -> `Class.MEMBER` */
  staticImports: Record<string, string>;
  classes: JavaClassFact[];
  /** `Class.CONSTANT` (and `Outer.Inner.CONSTANT`) -> expression */
  constants: Record<string, PathExpr>;
  /** MockMvc / WebTestClient / TestRestTemplate calls. */
  clientCalls: ClientCallFact[];
  /** A class that configures Spring Security (`SecurityFilterChain` bean, `@EnableWebSecurity`, ...). */
  securityConfig?: { className: string; pos: Pos };
  issues: FileIssue[];
}

// ---------------------------------------------------------------------------------------------
// Spring configuration files
// ---------------------------------------------------------------------------------------------

export interface SpringConfigFacts {
  lang: 'spring-config';
  contextPath?: string;
  servletPath?: string;
  serverPort?: number;
  issues: FileIssue[];
}

export interface SkippedFacts {
  lang: 'none';
  issues: FileIssue[];
}

export type FileFacts = JsFileFacts | JavaFileFacts | SpringConfigFacts | SkippedFacts;
