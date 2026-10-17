import * as path from 'path';
import type { AnalysisIssue, Endpoint, EndpointAuth, SourceLocation } from './types';

/**
 * Auth detection is a heuristic over names: middleware, guards, security annotations and
 * custom decorators are matched against regular expressions. It never inspects arguments or
 * runs code, so it reports what the code suggests, not what is enforced at runtime.
 */
/**
 * Which endpoints without auth are reported, in projects where other endpoints have auth:
 * `sensitive` = write methods and admin/internal paths, `all` = every endpoint, `off` = none.
 */
export type AuthWarnings = 'sensitive' | 'all' | 'off';
export const AUTH_WARNING_VALUES: readonly AuthWarnings[] = ['sensitive', 'all', 'off'];

export interface AuthOptions {
  enabled: boolean;
  warnings: AuthWarnings;
  /** Case-insensitive regular expressions; a match marks the endpoint as protected. */
  patterns: string[];
  /** Case-insensitive regular expressions for explicit opt-outs; they win over `patterns`. */
  publicPatterns: string[];
}

// Deliberately absent: `passport` (`passport.initialize()` runs globally without enforcing
// anything), `policy` (helmet's `contentSecurityPolicy()`) and `session` (`express-session`).
export const DEFAULT_AUTH_PATTERNS: readonly string[] = [
  'auth',
  'jwt',
  'bearer',
  'token',
  'api[-_]?key',
  'logged[-_]?in',
  'signed[-_]?in',
  'require[-_]?(user|login|session)',
  'role',
  'permission',
  'admin',
  'protect',
  // Any NestJS guard except rate limiting.
  '^(UseGuards|APP_GUARD|useGlobalGuards)\\((?!.*(throttl|ratelimit))',
  // Spring method security.
  'Secured',
  'RolesAllowed',
  'DenyAll',
];

export const DEFAULT_PUBLIC_PATTERNS: readonly string[] = ['@Public\\b', '@(Allow)?Anonymous\\b', '@(Skip|No)Auth\\b', '@IsPublic\\b', 'PermitAll', 'permitAll\\(\\)', 'isAnonymous\\(\\)'];

export const DEFAULT_AUTH_OPTIONS: AuthOptions = { enabled: true, warnings: 'sensitive', patterns: [...DEFAULT_AUTH_PATTERNS], publicPatterns: [...DEFAULT_PUBLIC_PATTERNS] };

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'ALL']);
const SENSITIVE_SEGMENT = /^(admin|administration|internal|private|manage|management|backoffice|staff|superuser)$/i;
/** Paths that are public by design: sign-in flows, webhooks (signature-checked), health and docs. */
const PUBLIC_SEGMENT =
  /^(login|logout|sign-?in|sign-?up|register|auth|oauth2?|token|refresh|forgot-password|reset-password|password-reset|verify|webhooks?|callback|health|healthz|ready|readyz|live|livez|ping|status|metrics|version|docs|swagger|swagger-ui|openapi|api-docs|\.well-known|favicon\.ico)$/i;

function segments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** Whether a missing auth check on this endpoint is worth a warning. */
export function shouldWarn(e: Endpoint, warnings: AuthWarnings): boolean {
  if (warnings === 'off') return false;
  const segs = segments(e.path);
  if (segs.some((s) => PUBLIC_SEGMENT.test(s))) return false;
  return warnings === 'all' || WRITE_METHODS.has(e.method) || segs.some((s) => SENSITIVE_SEGMENT.test(s));
}

/** A class that configures security for a whole project (Spring Security). */
export interface CentralSecurity {
  name: string;
  location: SourceLocation;
}

export interface CompiledAuth {
  patterns: RegExp[];
  publicPatterns: RegExp[];
  /** Patterns that are not valid regular expressions; they are ignored. */
  invalid: string[];
}

export function compileAuthOptions(options: AuthOptions): CompiledAuth {
  const invalid: string[] = [];
  const compile = (list: string[]): RegExp[] =>
    list.flatMap((p) => {
      try {
        return [new RegExp(p, 'i')];
      } catch {
        invalid.push(p);
        return [];
      }
    });
  return { patterns: compile(options.patterns), publicPatterns: compile(options.publicPatterns), invalid };
}

export function classifyAuth(endpoint: Endpoint, compiled: CompiledAuth, central: CentralSecurity | undefined): EndpointAuth {
  const candidates = [...endpoint.middleware, ...(endpoint.markers ?? [])];
  const isPublic = candidates.filter((c) => compiled.publicPatterns.some((re) => re.test(c)));
  if (isPublic.length > 0) return { status: 'public', via: isPublic };
  const protecting = candidates.filter((c) => compiled.patterns.some((re) => re.test(c)));
  if (protecting.length > 0) return { status: 'protected', via: protecting };
  if (central) return { status: 'central', via: [central.name], location: central.location };
  return { status: 'none', via: [] };
}

/**
 * Sets `auth` on every endpoint and reports endpoints with no auth in projects where other
 * endpoints have it (see {@link shouldWarn} for which). A project with no auth anywhere is not
 * reported: that is usually intended (a public API, a prototype), and a warning on every route
 * would only be noise.
 */
export function applyAuth(endpoints: Endpoint[], options: AuthOptions, centralByRoot: ReadonlyMap<string, CentralSecurity>): AnalysisIssue[] {
  if (!options.enabled) {
    for (const e of endpoints) delete e.auth;
    return [];
  }
  const compiled = compileAuthOptions(options);
  const usesAuth = new Set<string>();
  for (const e of endpoints) {
    e.auth = classifyAuth(e, compiled, centralByRoot.get(e.projectRoot));
    if (e.auth.status !== 'none') usesAuth.add(e.projectRoot);
  }
  const issues: AnalysisIssue[] = endpoints
    .filter((e) => e.auth?.status === 'none' && usesAuth.has(e.projectRoot) && shouldWarn(e, options.warnings))
    .map((e) => ({
      kind: 'no-auth',
      severity: 'warning',
      message: `No auth found for ${e.method} ${e.path} (${path.basename(e.location.file)}:${e.location.line}), but other endpoints in this project have it.`,
      location: e.location,
      endpointIds: [e.id],
    }));
  for (const p of compiled.invalid) {
    issues.push({ kind: 'limitation', severity: 'warning', message: `Ignoring invalid auth pattern "${p}" (setting apiShadow.auth.patterns / apiShadow.auth.publicPatterns).` });
  }
  return issues;
}

/** Short human-readable description, used by the tree, CodeLens and exports. */
export function describeAuth(auth: EndpointAuth | undefined): string | undefined {
  if (!auth) return undefined;
  switch (auth.status) {
    case 'protected':
      return auth.via.join(', ');
    case 'public':
      return `public (${auth.via.join(', ')})`;
    case 'central':
      return `configured in ${auth.via[0]}`;
    case 'none':
      return 'none found';
  }
}

/** Compact names for inline display: `UseGuards(AuthGuard)` → `AuthGuard`. */
export function authLabel(auth: EndpointAuth, max = 40): string {
  const names = auth.via.map((v) => /^(?:UseGuards|APP_GUARD|useGlobalGuards)\((.*)\)$/.exec(v)?.[1] ?? v);
  const text = [...new Set(names)].join(', ');
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
