/**
 * Line-based scan for hardcoded credentials (and Java CORS annotations) in source and
 * configuration files. It runs on every file the engine reads, including files the route
 * pre-filter skips, so a key in `config.js` is found too.
 *
 * Evidence is always redacted: the variable name, the first two characters and the length.
 * Secret values are never stored, cached, logged or shown.
 */
import type { RiskFact } from '../analyzers/facts';

export type ScanKind = 'js' | 'java' | 'config' | 'php';

interface KnownPattern {
  re: RegExp;
  label: string;
  /** `high` for formats that are unambiguous (provider prefixes), `medium` otherwise. */
  confidence: 'high' | 'medium';
}

const KNOWN: KnownPattern[] = [
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, label: 'AWS access key ID', confidence: 'high' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, label: 'GitHub token', confidence: 'high' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/, label: 'GitHub fine-grained token', confidence: 'high' },
  { re: /\b(?:sk|rk)_live_[0-9a-zA-Z]{20,}\b/, label: 'Stripe live key', confidence: 'high' },
  { re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/, label: 'Slack token', confidence: 'high' },
  { re: /https:\/\/hooks\.slack\.com\/services\/T[0-9A-Z]+\/B[0-9A-Z]+\/[0-9A-Za-z]+/, label: 'Slack webhook URL', confidence: 'high' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, label: 'Google API key', confidence: 'high' },
  { re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/, label: 'SendGrid API key', confidence: 'high' },
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, label: 'Anthropic API key', confidence: 'high' },
  { re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}\b/, label: 'OpenAI API key', confidence: 'high' },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}\b/, label: 'GitLab token', confidence: 'high' },
  { re: /\bnpm_[A-Za-z0-9]{36}\b/, label: 'npm token', confidence: 'high' },
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/, label: 'private key', confidence: 'high' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, label: 'JSON Web Token', confidence: 'medium' },
];

/** `mongodb://user:pass@host`; `${...}` and obvious placeholders are skipped. */
const URL_CREDENTIALS = /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|redis|rediss|amqps?|mssql|sqlserver):\/\/([^:\s'"/@]+):([^@\s'"]{3,})@/i;
const SECRET_NAME = /(password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer|private[_-]?key|client[_-]?secret|signing[_-]?key|encryption[_-]?key|credentials?|token)$/i;
/** `apiKey = "…"`, `"client_secret": "…"`, `private String password = "…";` */
const ASSIGNMENT = /(?:^|[\s{,(;])["']?([A-Za-z_$][\w$.-]{1,60})["']?\s*(?:[:=]|=>)\s*(["'`])([^"'`\n]{6,200})\2/g;
/** `spring.datasource.password=…`, `jwt.secret: …` */
const CONFIG_ENTRY = /^\s*([\w.[\]-]+)\s*[:=]\s*["']?([^"'#\s][^"'#]*?)["']?\s*$/;
const JWT_SIGN = /\bjwt\.(?:sign|verify)\s*\([^,()]+,\s*(["'`])([^"'`]{4,})\1/;
const SESSION_SECRET = /\bsecret\s*:\s*(["'`])([^"'`]{4,})\1/;
const SPRING_VALUE_DEFAULT = /@Value\(\s*"\$\{([\w.-]*(?:secret|password|key|token)[\w.-]*):([^}"]{6,})\}"/i;
const PLACEHOLDER = /^(\$\{|\{\{|<|%|process\.env|import\.meta|env\(|os\.environ|System\.getenv)|^(changeme|change[-_]?me|change[-_]?this|your[-_ ]|my[-_ ]|xxx+|\*{3,}|\.{3}|example|sample|dummy|fake|mock|test|testing|password|secret|placeholder|todo|tbd|none|null|undefined|true|false|redacted|hidden|replace[-_ ]?me|insert|enter[-_ ])/i;
const MAX_LINE = 500;
const MAX_FINDINGS = 20;

/** Provider prefixes that identify a token format without revealing any of the secret part. */
const FORMAT_PREFIX = /^(AKIA|ASIA|gh[pousr]_|github_pat_|sk_live_|rk_live_|xox[baprs]-|AIza|SG\.|sk-ant-|sk-proj-|glpat-|npm_|eyJ)/;

/** Redacted evidence: `apiKey = "…" (40 chars)`; only a known format prefix is ever shown. */
export function redact(name: string | undefined, value: string): string {
  const prefix = FORMAT_PREFIX.exec(value)?.[1];
  return `${name ? `${name} = ` : ''}"${prefix ?? ''}…" (${value.length} chars)`;
}

/** Shannon entropy in bits per character. */
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** True for values that look like real credentials rather than labels, keys of other maps or placeholders. */
function looksSecret(name: string, value: string): boolean {
  const v = value.trim();
  if (PLACEHOLDER.test(v) || /\s/.test(v)) return false;
  // Any literal password is worth a look, however simple it is.
  if (/password|passwd|pwd/i.test(name)) return v.length >= 6 && !/^(https?:|\/)/.test(v);
  // Storage keys, header names and enum-like labels: `auth_token`, `X-Api-Key`, `ACCESS_TOKEN`.
  if (/^[a-z]+([_.-][a-z]+)*$/.test(v)) return false;
  if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/.test(v) || /^[A-Z][a-z]+(-[A-Z][a-z]+)+$/.test(v)) return false;
  // URLs, paths, file names and route templates are not secrets themselves.
  if (/^(https?:|\/|\.\/|[\w-]+\.(json|js|ts|pem|key|crt|txt)$)/i.test(v)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(v)).length;
  return v.length >= 12 && classes >= 2 && entropy(v) >= 3;
}

export function scanText(source: string, kind: ScanKind): RiskFact[] {
  const out: RiskFact[] = [];
  const lines = source.split(/\r?\n/);
  const add = (line: number, column: number, evidence: string, detail: string): void => {
    if (out.length >= MAX_FINDINGS || out.some((r) => r.pos.line === line + 1 && r.rule === 'hardcoded-secret')) return;
    out.push({ rule: 'hardcoded-secret', pos: { line: line + 1, column: column + 1 }, evidence, detail });
  };
  let corsAny: number | undefined;
  let corsCredentials = false;
  // Laravel `config/app.php` with debug forced on, and `config/cors.php` allowing any origin.
  const laravelAppConfig = kind === 'php' && /'providers'\s*=>|'timezone'\s*=>/.test(source);
  const laravelCors = kind === 'php' && /'allowed_origins'\s*=>/.test(source);
  for (let i = 0; i < lines.length && out.length < MAX_FINDINGS; i++) {
    const line = lines[i];
    if (line.length > MAX_LINE) continue;
    for (const k of KNOWN) {
      const m = k.re.exec(line);
      if (m) add(i, m.index, k.label === 'private key' ? 'private key block (-----BEGIN … PRIVATE KEY-----)' : `${k.label} ${redact(undefined, m[0])}`, k.confidence);
    }
    const url = URL_CREDENTIALS.exec(line);
    if (url && !PLACEHOLDER.test(url[2]) && !/^\$|^\{|^<|^:/.test(url[2])) add(i, url.index, `credentials in a connection string (password of ${url[2].length} chars)`, 'medium');
    if (kind === 'js') {
      const jwt = JWT_SIGN.exec(line);
      if (jwt) add(i, jwt.index, `jwt.${line.includes('verify') ? 'verify' : 'sign'}(…, ${redact(undefined, jwt[2])})`, 'high');
      const session = /session\s*\(|cookieSession\s*\(|secret\s*:/.test(line) ? SESSION_SECRET.exec(line) : null;
      if (session && !PLACEHOLDER.test(session[2]) && /session|cookie/i.test(lines.slice(Math.max(0, i - 3), i + 1).join('\n'))) add(i, session.index, `session ${redact('secret', session[2])}`, 'medium');
    }
    if (kind === 'java') {
      const v = SPRING_VALUE_DEFAULT.exec(line);
      if (v && !PLACEHOLDER.test(v[2])) add(i, v.index, `@Value default for ${v[1]} ${redact(undefined, v[2])}`, 'medium');
      // CORS
      if (/@CrossOrigin\b(?!\s*\()/.test(line) || /@CrossOrigin\s*\(\s*\)/.test(line)) out.push({ rule: 'permissive-cors', pos: { line: i + 1, column: line.indexOf('@CrossOrigin') + 1 }, evidence: '@CrossOrigin (all origins by default)', detail: 'default' });
      else if (/@CrossOrigin\s*\((\s*(origins|value)\s*=)?\s*\{?\s*"\*"/.test(line)) out.push({ rule: 'permissive-cors', pos: { line: i + 1, column: line.indexOf('@CrossOrigin') + 1 }, evidence: '@CrossOrigin(origins = "*")', detail: 'any' });
      if (/allowedOrigin(Pattern)?s\s*\(\s*"\*"|addAllowedOrigin(Pattern)?\s*\(\s*"\*"|setAllowedOrigin(Pattern)?s\s*\([^)]*"\*"/.test(line)) corsAny ??= i;
      if (/allowCredentials\s*\(\s*true|setAllowCredentials\s*\(\s*true/.test(line)) corsCredentials = true;
    }
    if (laravelAppConfig && /^\s*'debug'\s*=>\s*true\b/.test(line)) {
      out.push({ rule: 'error-details', pos: { line: i + 1, column: line.indexOf("'debug'") + 1 }, evidence: "'debug' => true in config/app.php", detail: 'stack' });
    }
    if (laravelCors) {
      if (/'allowed_origins'\s*=>\s*\[\s*'\*'/.test(line) || /'allowed_origins_patterns'\s*=>\s*\[\s*'(\.\*|\*)'/.test(line)) corsAny ??= i;
      if (/'supports_credentials'\s*=>\s*true/.test(line)) corsCredentials = true;
    }
    if (kind === 'config') {
      if (/^\s*[#!]/.test(line)) continue;
      const m = CONFIG_ENTRY.exec(line);
      if (m && SECRET_NAME.test(m[1].replace(/[\]\d[]+$/, '')) && looksSecret(m[1], m[2])) add(i, line.indexOf(m[1]), `${m[1]} ${redact(undefined, m[2].trim())}`, 'medium');
      continue;
    }
    ASSIGNMENT.lastIndex = 0;
    for (let m = ASSIGNMENT.exec(line); m; m = ASSIGNMENT.exec(line)) {
      const name = m[1].split('.').pop()!;
      if (!SECRET_NAME.test(name) || /\$\{/.test(m[3]) || !looksSecret(name, m[3])) continue;
      // Type annotations and keys in i18n files (`passwordLabel: "Password"`) are labels, not secrets.
      if (/label|placeholder|hint|message|title|text|field|name|type|header|url|endpoint|route|path|key[_-]?name|storage/i.test(name.replace(SECRET_NAME, ''))) continue;
      add(i, m.index, redact(m[1], m[3]), 'medium');
    }
  }
  if (corsAny !== undefined) {
    const evidence = kind === 'php' ? (corsCredentials ? "'allowed_origins' => ['*'] with 'supports_credentials' => true" : "'allowed_origins' => ['*']") : corsCredentials ? 'allowedOrigins("*") with allowCredentials(true)' : 'allowedOrigins("*")';
    out.push({ rule: 'permissive-cors', pos: { line: corsAny + 1, column: 1 }, evidence, detail: corsCredentials ? 'any+credentials' : 'any' });
  }
  return out;
}
