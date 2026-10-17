/**
 * Per-file "facts" extracted by analyzers. Facts are plain JSON so they can be cached between
 * sessions; cross-file reasoning (router mounting, constant resolution, service lookup) happens
 * later in the linkers, which only ever see facts, never source code.
 */
import type { EndpointParameter, HttpMethod, PathExpr, ServiceCall } from '../core/types';

/** Bump whenever the facts shape or extraction semantics change, to invalidate persisted caches. */
export const FACTS_VERSION = 5;

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

export interface RouterNodeFact {
  key: string;
  kind: 'app' | 'router' | 'param';
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
}

export interface ExpressRouteFact {
  router: RefExpr;
  method: HttpMethod;
  paths: PathExpr[];
  middleware: string[];
  handler?: HandlerFact;
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
  pos: Pos;
  order: number;
}

export interface ExpressInjectionFact {
  /** Function receiving a router/app argument (e.g. `registerRoutes(app)`). */
  callee: RefExpr;
  argIndex: number;
  parent: RefExpr;
  pos: Pos;
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
  params: NestParamFact[];
  bodyType?: string;
  serviceCalls: ServiceCall[];
}

export interface NestControllerFact {
  className: string;
  pos: Pos;
  paths: PathExpr[];
  versions: string[];
  middleware: string[];
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
  issues: FileIssue[];
}

// ---------------------------------------------------------------------------------------------
// Java (Spring)
// ---------------------------------------------------------------------------------------------

export interface JavaMapping {
  methods: HttpMethod[];
  paths: PathExpr[];
}

export interface JavaMethodFact {
  name: string;
  pos: Pos;
  mapping?: JavaMapping;
  security: string[];
  params: EndpointParameter[];
  bodyType?: string;
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
  issues: FileIssue[];
}

// ---------------------------------------------------------------------------------------------
// Spring configuration files
// ---------------------------------------------------------------------------------------------

export interface SpringConfigFacts {
  lang: 'spring-config';
  contextPath?: string;
  servletPath?: string;
  issues: FileIssue[];
}

export interface SkippedFacts {
  lang: 'none';
  issues: FileIssue[];
}

export type FileFacts = JsFileFacts | JavaFileFacts | SpringConfigFacts | SkippedFacts;
