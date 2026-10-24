/**
 * Security Radar: API-related risks found by static analysis. Every finding is a *potential*
 * issue with its evidence, a severity (how bad it would be) and a confidence (how likely the
 * evidence means what the rule says). Nothing is executed, probed or sent anywhere.
 *
 * Evidence comes from handler bodies (`EndpointRisk`), file scans (secrets, CORS, Spring
 * configuration), auth detection (`no-auth` issues) and inferred response shapes.
 */
import { flatten, successShape } from './shapes';
import type { AnalysisIssue, Confidence, Endpoint, SecurityRuleId, SourceLocation } from './types';
import type { RiskFact } from '../analyzers/facts';

export type Severity = 'high' | 'medium' | 'low' | 'info';

export interface SecurityRule {
  id: SecurityRuleId;
  title: string;
  /** What the rule looks for and why it matters. */
  description: string;
  mitigation: string;
}

export interface SecurityFinding {
  /** Stable across edits that move lines: rule, file, endpoint and evidence. Used for dismissals. */
  id: string;
  rule: SecurityRuleId;
  title: string;
  severity: Severity;
  confidence: Confidence;
  message: string;
  evidence: string;
  mitigation: string;
  location: SourceLocation;
  endpointId?: string;
  /** `DELETE /api/admin/:id` */
  endpoint?: string;
}

export interface FileRisks {
  file: string;
  risks: RiskFact[];
  /** Test files: findings are kept with low severity and confidence. */
  test: boolean;
}

export interface SecurityOptions {
  enabled: boolean;
  /** Rule ids to skip. */
  disabledRules: readonly string[];
  /** Files to skip (user exclusions). */
  isExcluded?: (file: string) => boolean;
}

export const SECURITY_RULES: Record<SecurityRuleId, SecurityRule> = {
  'hardcoded-secret': {
    id: 'hardcoded-secret',
    title: 'Possible hardcoded credential',
    description: 'A value that looks like an API key, token, password or private key is written in source or configuration. Anyone with access to the repository (or a built bundle) can read it.',
    mitigation: 'Move the value to an environment variable or a secret manager, rotate it if it was ever committed, and keep only a placeholder in the code.',
  },
  'sensitive-response': {
    id: 'sensitive-response',
    title: 'Sensitive data may be exposed in a response',
    description: 'The response includes a field whose name suggests credentials or personal data (password hash, token, card number), or sends a whole user record from the database.',
    mitigation: 'Return a DTO with only the fields clients need, or exclude the field from serialisation (`select("-password")`, `@JsonIgnore`, `@Exclude()`).',
  },
  'missing-auth': {
    id: 'missing-auth',
    title: 'No recognizable authentication',
    description: 'No authentication middleware, guard or security annotation was detected for this endpoint, although other endpoints in the project have one. Auth applied in a way API Shadow does not recognise (a custom wrapper, a gateway) is not visible.',
    mitigation: 'Verify that authentication is enforced for this route. If it is, add your middleware name to `apiShadow.auth.patterns` or mark the route public explicitly.',
  },
  'permissive-cors': {
    id: 'permissive-cors',
    title: 'Permissive CORS configuration',
    description: 'Cross-origin requests are allowed from any origin. Combined with credentials (cookies), any website can make authenticated requests on behalf of a logged-in user and read the response.',
    mitigation: 'List the allowed origins explicitly. Never reflect arbitrary origins together with `credentials: true`.',
  },
  'mass-assignment': {
    id: 'mass-assignment',
    title: 'Possible mass assignment',
    description: 'The whole request body is written to a model or entity. Clients can then set fields they should not control, such as `role`, `isAdmin` or `ownerId`.',
    mitigation: 'Pick the allowed fields explicitly or validate the body against a schema that rejects unknown properties; for Spring, bind a DTO instead of the entity.',
  },
  'object-authorization': {
    id: 'object-authorization',
    title: 'Object-level authorization not evident',
    description: 'A path parameter (an id) is passed to a data access call, but the handler does not read the authenticated user and no ownership or permission middleware was found. Any authenticated user might access other users\' records (IDOR/BOLA).',
    mitigation: 'Check that the record belongs to (or is visible to) the current user before reading or changing it, for example by scoping the query with the user id.',
  },
  injection: {
    id: 'injection',
    title: 'Request input reaches a query or command',
    description: 'Request data is concatenated into a SQL query, a shell command or evaluated code, or a whole request object is used as a database filter.',
    mitigation: 'Use parameterised queries or query builders, pass arguments to processes as an array without a shell, never evaluate request data, and validate filter objects.',
  },
  'open-redirect': {
    id: 'open-redirect',
    title: 'Redirect target taken from the request',
    description: 'The redirect location comes from request input, so links to your site can forward users to any external site (phishing).',
    mitigation: 'Redirect only to relative paths or to an allow-list of known hosts.',
  },
  'path-traversal': {
    id: 'path-traversal',
    title: 'File path built from request input',
    description: 'A file is read, written or sent using a path derived from request input. Inputs such as `../../etc/passwd` can escape the intended directory.',
    mitigation: 'Resolve the path against a fixed base directory and reject results outside it, or map identifiers to files server-side.',
  },
  'error-details': {
    id: 'error-details',
    title: 'Error details exposed to clients',
    description: 'Stack traces, exception messages or error objects are sent in responses. They can reveal file paths, queries, library versions and internal logic.',
    mitigation: 'Log the details on the server and return a generic message with a correlation id.',
  },
  'config-exposure': {
    id: 'config-exposure',
    title: 'Internal endpoints exposed by configuration',
    description: 'Configuration exposes actuator or diagnostic endpoints (environment, heap dumps, configuration properties) that can leak secrets.',
    mitigation: 'Expose only the endpoints you need (e.g. `health,info`) and protect the rest with authentication.',
  },
};

const SENSITIVE_FIELD = /^(password|passwd|pwd|password_?hash|hashed_?password|pass_?hash|salt|secret|client_?secret|api_?key|private_?key|ssn|social_?security_?number|credit_?card(_?number)?|card_?number|cvv|cvc|pin|otp|mfa_?secret|totp_?secret|reset_?token|verification_?token|access_?token|refresh_?token|session_?token)$/i;
const TOKEN_FIELD = /token$/i;
const AUTH_PATH = /(login|signin|sign-in|token|auth|refresh|register|signup|sign-up|oauth|session|password\/reset|verify)/i;
const OWNERSHIP_MIDDLEWARE = /(owner|permission|authori[sz]e|can[A-Z_]|^can:|policy|role|admin|acl|ability|rbac|scope|guard|isSelf|checkAccess)/i;
const ID_PARAM = /(^|[_-])id$|Id$|^(slug|uuid|key)$/;

export function analyzeSecurity(endpoints: Endpoint[], issues: AnalysisIssue[], files: FileRisks[], options: SecurityOptions): SecurityFinding[] {
  if (!options.enabled) return [];
  const out: SecurityFinding[] = [];
  const disabled = new Set(options.disabledRules);
  const excluded = (file: string): boolean => options.isExcluded?.(file) ?? false;
  const add = (f: Omit<SecurityFinding, 'id' | 'title' | 'mitigation'> & { mitigation?: string }): void => {
    if (disabled.has(f.rule) || excluded(f.location.file)) return;
    const rule = SECURITY_RULES[f.rule];
    const id = fingerprint(`${f.rule}|${f.location.file}|${f.endpoint ?? ''}|${f.evidence}`);
    if (out.some((x) => x.id === id)) return;
    out.push({ ...f, id, title: rule.title, mitigation: f.mitigation ?? rule.mitigation });
  };
  const label = (e: Endpoint): string => `${e.method} ${e.path}`;

  // Handler evidence.
  for (const e of endpoints) {
    for (const r of e.risks ?? []) {
      const { severity, confidence, message } = handlerRisk(r.rule, r.detail, e, r.evidence);
      add({ rule: r.rule, severity, confidence, message, evidence: r.evidence, location: r.location, endpointId: e.id, endpoint: label(e) });
    }
    sensitiveFields(e, add);
    objectAuthorization(e, add);
  }

  // Missing auth, from the auth checks (which respect the warning settings).
  const byId = new Map(endpoints.map((e) => [e.id, e]));
  for (const i of issues) {
    if (i.kind !== 'no-auth' || !i.location) continue;
    const e = byId.get(i.endpointIds?.[0] ?? '');
    const admin = !!e && /(^|\/)(admin|internal|manage|management|ops|system|debug)(\/|$)/i.test(e.path);
    const write = !!e && ['POST', 'PUT', 'PATCH', 'DELETE', 'ALL'].includes(e.method);
    add({
      rule: 'missing-auth',
      severity: admin ? 'high' : write ? 'medium' : 'low',
      confidence: 'medium',
      message: e ? `No recognizable authentication was detected for ${label(e)}${admin ? ', an administrative path' : ''}. Verify that authentication and object-level authorization are enforced.` : i.message,
      evidence: e ? `middleware: ${e.middleware.length ? e.middleware.join(', ') : 'none'}` : i.message,
      location: i.location,
      endpointId: e?.id,
      endpoint: e ? label(e) : undefined,
    });
  }

  // File-level evidence.
  for (const f of files) {
    for (const r of f.risks) {
      const location = { file: f.file, line: r.pos.line, column: r.pos.column };
      if (r.rule === 'hardcoded-secret') {
        const strong = r.detail === 'high';
        add({
          rule: r.rule,
          severity: f.test ? 'low' : strong ? 'high' : 'medium',
          confidence: f.test ? 'low' : strong ? 'high' : 'medium',
          message: f.test ? `A credential-like value appears in a test file: ${r.evidence}. It is probably a fixture; make sure it is not a real key.` : `Possible hardcoded credential: ${r.evidence}.`,
          evidence: r.evidence,
          location,
        });
      } else if (r.rule === 'permissive-cors') {
        const { severity, message } = corsRisk(r.detail ?? '', r.evidence);
        add({ rule: r.rule, severity: f.test ? 'info' : severity, confidence: 'high', message, evidence: r.evidence, location });
      } else if (r.rule === 'error-details' || r.rule === 'config-exposure') {
        const stack = r.detail === 'stack' || r.detail === 'exception';
        add({
          rule: r.rule,
          severity: r.rule === 'config-exposure' ? 'medium' : stack ? 'medium' : 'low',
          confidence: 'high',
          message: r.rule === 'config-exposure' ? `Configuration exposes actuator endpoints: ${r.evidence}.` : `Configuration adds ${stack ? 'stack traces' : 'exception messages'} to error responses: ${r.evidence}.`,
          evidence: r.evidence,
          location,
        });
      }
    }
  }
  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.location.file.localeCompare(b.location.file) || a.location.line - b.location.line);
}

function handlerRisk(rule: SecurityRuleId, detail: string | undefined, e: Endpoint, evidence: string): { severity: Severity; confidence: Confidence; message: string } {
  const where = `${e.method} ${e.path}`;
  switch (rule) {
    case 'mass-assignment': {
      const validated = e.validation?.status === 'validated';
      if (detail === 'entity') return { severity: 'medium', confidence: 'medium', message: `${where} binds the request body directly to a persistence entity (${evidence}); clients may set fields such as ids or roles.` };
      return {
        severity: validated ? 'low' : 'medium',
        confidence: validated ? 'low' : 'medium',
        message: `${where} writes the whole request body to the database (${evidence})${validated ? '; the body is validated, so this is only a risk if the schema allows unknown or privileged fields' : ''}.`,
      };
    }
    case 'injection': {
      const kind = detail === 'sql' ? 'a SQL query' : detail === 'command' ? 'a shell command' : detail === 'code' ? 'evaluated code' : 'a database filter';
      return { severity: detail === 'nosql' ? 'medium' : 'high', confidence: detail === 'nosql' ? 'low' : 'medium', message: `Request input reaches ${kind} in ${where}: ${evidence}.` };
    }
    case 'open-redirect':
      return { severity: 'medium', confidence: 'medium', message: `${where} redirects to a location taken from the request: ${evidence}.` };
    case 'path-traversal':
      return { severity: 'high', confidence: 'medium', message: `${where} uses request input in a file path: ${evidence}.` };
    case 'error-details':
      return {
        severity: detail === 'stack' ? 'medium' : 'low',
        confidence: detail === 'object' ? 'low' : 'medium',
        message: `${where} sends ${detail === 'stack' ? 'a stack trace' : detail === 'object' ? 'an error object' : 'an internal error message'} to the client: ${evidence}.`,
      };
    case 'sensitive-response':
      return { severity: 'medium', confidence: 'low', message: `${where} ${evidence}; the record may include fields such as a password hash.` };
    default:
      return { severity: 'low', confidence: 'low', message: `${where}: ${evidence}` };
  }
}

function corsRisk(detail: string, evidence: string): { severity: Severity; message: string } {
  if (detail.endsWith('+credentials')) return { severity: 'high', message: `CORS allows ${detail.startsWith('reflect') ? 'every origin (reflected)' : 'any origin'} with credentials: ${evidence}. Any website can make authenticated requests and read the responses.` };
  if (detail === 'reflect') return { severity: 'medium', message: `CORS reflects every request origin: ${evidence}. Fine for a fully public API; risky if cookies or other credentials are ever accepted.` };
  if (detail === 'default') return { severity: 'low', message: `CORS is enabled for all origins by default: ${evidence}. Fine for a public API; otherwise list the allowed origins.` };
  return { severity: 'low', message: `CORS allows any origin: ${evidence}.` };
}

type Add = (f: Omit<SecurityFinding, 'id' | 'title' | 'mitigation'> & { mitigation?: string }) => void;

/** Response fields named like credentials or personal data. */
function sensitiveFields(e: Endpoint, add: Add): void {
  const shape = successShape(e);
  if (!shape) return;
  const response = (e.responses ?? []).find((r) => r.shape && (r.status === undefined || r.status < 300));
  const location = response?.location ?? e.location;
  const fields = [...flatten(shape).values()].filter((f) => {
    const name = f.path.split('.').pop()!;
    if (!SENSITIVE_FIELD.test(name)) return false;
    // Sign-in and token endpoints are expected to return tokens.
    if (TOKEN_FIELD.test(name) && AUTH_PATH.test(e.path)) return false;
    // `password: undefined`/literal booleans like `hasPassword: true` are not values.
    return f.shape.t !== 'boolean' && f.shape.t !== 'null';
  });
  if (fields.length === 0) return;
  const names = fields.map((f) => f.path);
  const declared = response?.via === 'type';
  add({
    rule: 'sensitive-response',
    severity: names.some((n) => /pass|secret|private|ssn|card|cvv|cvc/i.test(n)) ? 'high' : 'medium',
    confidence: declared ? 'high' : 'medium',
    message: `${e.method} ${e.path} returns ${names.map((n) => `\`${n}\``).join(', ')}${declared ? ` (declared by ${response?.type})` : ''}. Check that clients really need ${names.length === 1 ? 'it' : 'them'}.`,
    evidence: `response fields: ${names.join(', ')}`,
    location,
    endpointId: e.id,
    endpoint: `${e.method} ${e.path}`,
  });
}

/** Ids from the path used in data access without any sign of an ownership check. */
function objectAuthorization(e: Endpoint, add: Add): void {
  if (!e.ownership?.paramIdToData || e.ownership.readsUser) return;
  if (!['GET', 'PUT', 'PATCH', 'DELETE'].includes(e.method)) return;
  const idParams = (e.path.match(/[:{]([\w-]+)/g) ?? []).map((p) => p.slice(1)).filter((p) => ID_PARAM.test(p));
  if (idParams.length === 0) return;
  // Without auth the missing-auth rule applies; public routes are deliberate.
  if (e.auth && (e.auth.status === 'none' || e.auth.status === 'public')) return;
  if (e.middleware.some((m) => OWNERSHIP_MIDDLEWARE.test(m) && !/^(UseGuards|APP_GUARD|useGlobalGuards)\((Jwt|Auth)/i.test(m) && !/^(auth|authenticate|requireAuth|jwt|passport)/i.test(m))) return;
  add({
    rule: 'object-authorization',
    severity: e.method === 'GET' ? 'low' : 'medium',
    confidence: 'low',
    message: `${e.method} ${e.path} loads or changes a record by \`${idParams.join(', ')}\` without reading the current user; verify that users can only access their own records.`,
    evidence: `data access: ${(e.dataAccess ?? []).slice(0, 3).join(', ') || 'yes'}; current user not referenced`,
    location: e.handlerLocation ?? e.location,
    endpointId: e.id,
    endpoint: `${e.method} ${e.path}`,
  });
}

function fingerprint(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
