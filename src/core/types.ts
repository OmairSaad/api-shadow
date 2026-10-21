import type { SecurityFinding } from './security';

/**
 * Shared data model. Everything in `src/core`, `src/analyzers`, `src/linkers` and `src/export`
 * is free of `vscode` imports so it can be unit-tested in plain Node.
 */

export type Framework = 'express' | 'fastify' | 'koa' | 'nestjs' | 'spring';

export const FRAMEWORKS: readonly Framework[] = ['express', 'fastify', 'koa', 'nestjs', 'spring'];

/** `ALL` means the route matches every HTTP method (Express `all`, Nest `@All`, Spring mapping without `method`). */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD' | 'ALL';

export const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'ALL'];

export interface SourceLocation {
  /** Absolute file system path. */
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
}

/**
 * A route path as written in source. Parts are concatenated in order.
 * - `lit`: literal text
 * - `ref`: an identifier/constant reference that a linker may resolve (Java constants)
 * - `dynamic`: an expression that cannot be evaluated statically
 * - `regex`: a regular-expression route (Express)
 */
export type PathPart =
  | { lit: string }
  | { ref: string }
  | { dynamic: string }
  | { regex: string };

export interface PathExpr {
  parts: PathPart[];
}

/**
 * The inferred shape of a JSON value, from object and array literals in handler code. `unknown`
 * means the value comes from somewhere the analyzer cannot see (a database row, a parameter);
 * `open` objects may have more properties than listed (spreads, computed keys, later mutation).
 */
export type Shape =
  | { t: 'object'; props: Record<string, ShapeProp>; open?: boolean }
  | { t: 'array'; items?: Shape }
  | { t: 'string' | 'number' | 'boolean' | 'null' }
  | { t: 'unknown'; expr?: string };

export interface ShapeProp {
  shape: Shape;
  /** Short text of the value expression (`user.name`), used to recognise renamed fields. */
  src?: string;
  /** Missing on some code paths. */
  optional?: boolean;
}

/** Identifier of a security rule; see `core/security.ts`. */
export type SecurityRuleId =
  | 'hardcoded-secret'
  | 'sensitive-response'
  | 'missing-auth'
  | 'permissive-cors'
  | 'mass-assignment'
  | 'object-authorization'
  | 'injection'
  | 'open-redirect'
  | 'path-traversal'
  | 'error-details'
  | 'config-exposure';

export interface ServiceCall {
  /** Receiver as written, e.g. `usersService` or `this.usersService`. */
  receiver: string;
  method: string;
  /** Declared type of the receiver when known (constructor injection, typed fields). */
  type?: string;
  /** Local name of a directly called imported function (`getTags()` from './tag.service'). */
  local?: string;
}

export interface ServiceRef {
  /** Display name, e.g. `UsersService.findAll`. */
  name: string;
  location?: SourceLocation;
  /** Repositories, DAOs or models this service method uses (Spring fields, JS data access calls). */
  uses?: ServiceRef[];
}

/** A response inferred from handler code: literals, local constants and declared DTO types. Never authoritative. */
export interface EndpointResponse {
  /** Undefined when the framework default applies. */
  status?: number;
  shape?: Shape;
  /** Where it was inferred from: `res.json(...)`, `return`, a declared type (`UserDto`). */
  via: 'json' | 'send' | 'body' | 'return' | 'status' | 'throw' | 'type';
  /** Declared type name, for `type` responses. */
  type?: string;
  location: SourceLocation;
}

/** Evidence for a security rule found in an endpoint's handler. */
export interface EndpointRisk {
  rule: SecurityRuleId;
  evidence: string;
  detail?: string;
  location: SourceLocation;
}

/** How sure the analysis is about an endpoint's method and path. */
export type Confidence = 'high' | 'medium' | 'low';

export type ParameterLocation = 'path' | 'query' | 'header' | 'cookie';

export interface EndpointParameter {
  name: string;
  in: ParameterLocation;
  required: boolean;
  /** Source-level type name, never a fabricated schema. */
  type?: string;
}

/**
 * How an endpoint is protected, as far as the code shows:
 * - `protected`: middleware, a guard or a security annotation that looks like authentication or authorization
 * - `public`: an explicit opt-out marker (`@Public()`, `@PermitAll`, `permitAll()`)
 * - `central`: the project configures security centrally (Spring Security filter chain); per-path rules aren't analyzed
 * - `none`: nothing auth-related was found
 */
export type AuthStatus = 'protected' | 'public' | 'central' | 'none';

export interface EndpointAuth {
  status: AuthStatus;
  /** The middleware, guards, markers or configuration class that decided the status. */
  via: string[];
  /** Where central security is configured (`central` only). */
  location?: SourceLocation;
}

export interface Endpoint {
  id: string;
  framework: Framework;
  method: HttpMethod;
  /** Full display path (prefixes applied). Dynamic parts are shown as `${expr}`. */
  path: string;
  /** False when any part of the path could not be resolved statically or is a regex. */
  pathIsStatic: boolean;
  controller?: string;
  handler?: string;
  location: SourceLocation;
  handlerLocation?: SourceLocation;
  middleware: string[];
  /** Custom decorators on the handler or controller (NestJS), e.g. `@Public()`. Used for auth detection. */
  markers?: string[];
  /** Filled in after linking; see {@link EndpointAuth}. */
  auth?: EndpointAuth;
  /**
   * For endpoints that accept a request body: whether it is validated (validation middleware,
   * pipes, `@Valid`, or a schema check of the body in the handler), and by what.
   */
  validation?: { status: 'validated' | 'missing'; via: string[] };
  /** Calls to this endpoint found in the workspace (filled in after linking). */
  usage?: { calls: number; tests: number };
  services: ServiceRef[];
  parameters: EndpointParameter[];
  /** Source-level request body type name (Nest `@Body()`, Spring `@RequestBody`). */
  requestBodyType?: string;
  /**
   * Version selected outside the path (NestJS header, media-type or custom versioning). Routes
   * with the same path but different versions are not duplicates.
   */
  version?: string;
  /**
   * Request conditions that narrow which requests match (Spring `params`, `headers`, `consumes`,
   * `produces`), as written. Routes with different conditions are not duplicates.
   */
  conditions?: string[];
  /** Human-readable analysis notes (where a prefix came from, heuristics applied, ...). */
  notes: string[];
  /** Responses inferred from handler code; see {@link EndpointResponse}. */
  responses?: EndpointResponse[];
  /** Data access calls in the handler (`User.findById`, `userRepository.save`). */
  dataAccess?: string[];
  /** Security evidence from the handler body; turned into findings by `core/security.ts`. */
  risks?: EndpointRisk[];
  /** The handler reads the authenticated user / passes a path parameter to data access. */
  ownership?: { readsUser: boolean; paramIdToData: boolean };
  /** How certain the method and path are: `low` for unresolved expressions, `medium` for unmounted routers. */
  confidence?: Confidence;
  /**
   * Set when the router's mount point was not found: the router the path is relative to. Such
   * paths are only compared with routes of the same router.
   */
  relativeTo?: string;
  /** Directory of the nearest project marker (package.json, pom.xml, build.gradle). Used to scope duplicates. */
  projectRoot: string;
}

export type IssueKind = 'duplicate' | 'unreachable' | 'broken-call' | 'response-mismatch' | 'no-auth' | 'no-validation' | 'uncalled' | 'limitation' | 'parse-error' | 'skipped';
export type IssueSeverity = 'info' | 'warning' | 'error';

export interface AnalysisIssue {
  kind: IssueKind;
  severity: IssueSeverity;
  message: string;
  location?: SourceLocation;
  /** Endpoint ids related to this issue (duplicates). */
  endpointIds?: string[];
  /** Other locations involved, e.g. the route that shadows an unreachable one. */
  related?: { location: SourceLocation; message: string }[];
}

/** An HTTP call to an API in the workspace: frontend code (`fetch`, axios, ...) or a test. */
export interface ClientCall {
  id: string;
  kind: 'app' | 'test';
  /** Library, e.g. `fetch`, `axios`, `HttpClient`, `supertest`, `MockMvc`. */
  client: string;
  /** `ALL` when the method could not be determined. */
  method: HttpMethod;
  /** The URL as written, unresolved parts shown as `${expr}`. */
  url: string;
  location: SourceLocation;
  /** Range of the URL argument, for go-to-definition and hovers. */
  range: { start: SourceLocation; end: SourceLocation };
  /** Endpoints this call most likely reaches (best matches only). */
  endpointIds: string[];
  /** Function or component making the call. */
  within?: string;
  /** Response fields read from this call's result, here or in code that uses the function making it. */
  reads?: ResponseRead[];
  /** Code that receives this call's response through a function (`getUser()` in `UserProfile`). */
  consumers?: ResponseConsumer[];
}

/** A response field read by client code: `user.name`; array items are `[]` (`items.[].title`). */
export interface ResponseRead {
  path: string;
  location: SourceLocation;
  /** Function or component reading it. */
  within?: string;
  /** Read in another function that receives the response from this call's function. */
  indirect?: boolean;
}

export interface ResponseConsumer {
  /** Function or component, e.g. `UserProfile`. */
  within?: string;
  /** The function it calls, e.g. `getUser`. */
  callee: string;
  location: SourceLocation;
}

export interface DuplicateGroup {
  key: string;
  method: HttpMethod;
  path: string;
  endpointIds: string[];
}

export interface AnalysisStats {
  filesDiscovered: number;
  filesAnalyzed: number;
  filesFromCache: number;
  filesSkipped: number;
  durationMs: number;
  truncated: boolean;
}

/** A port a project listens on, read from `app.listen(3000)` or `server.port`. */
export interface ServerInfo {
  projectRoot: string;
  port: number;
  location: SourceLocation;
}

export interface AnalysisResult {
  endpoints: Endpoint[];
  issues: AnalysisIssue[];
  duplicates: DuplicateGroup[];
  servers: ServerInfo[];
  clientCalls: ClientCall[];
  /** Security Radar findings; see `core/security.ts`. */
  security: SecurityFinding[];
  stats: AnalysisStats;
}

export interface Logger {
  trace(message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string | Error): void;
}

export const nullLogger: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface CancellationLike {
  readonly isCancellationRequested: boolean;
}

export class CancelledError extends Error {
  constructor() {
    super('Analysis cancelled');
    this.name = 'CancelledError';
  }
}

export function throwIfCancelled(token: CancellationLike | undefined): void {
  if (token?.isCancellationRequested) {
    throw new CancelledError();
  }
}
