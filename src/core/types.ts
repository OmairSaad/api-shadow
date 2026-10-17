/**
 * Shared data model. Everything in `src/core`, `src/analyzers`, `src/linkers` and `src/export`
 * is free of `vscode` imports so it can be unit-tested in plain Node.
 */

export type Framework = 'express' | 'nestjs' | 'spring';

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
}

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
  services: ServiceRef[];
  parameters: EndpointParameter[];
  /** Source-level request body type name (Nest `@Body()`, Spring `@RequestBody`). */
  requestBodyType?: string;
  /** Human-readable analysis notes (where a prefix came from, heuristics applied, ...). */
  notes: string[];
  /** Directory of the nearest project marker (package.json, pom.xml, build.gradle). Used to scope duplicates. */
  projectRoot: string;
}

export type IssueKind = 'duplicate' | 'no-auth' | 'limitation' | 'parse-error' | 'skipped';
export type IssueSeverity = 'info' | 'warning' | 'error';

export interface AnalysisIssue {
  kind: IssueKind;
  severity: IssueSeverity;
  message: string;
  location?: SourceLocation;
  /** Endpoint ids related to this issue (duplicates). */
  endpointIds?: string[];
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
