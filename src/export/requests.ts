/**
 * Ready-to-send requests for endpoints: cURL commands and `.http` files (the format of the REST
 * Client extension and JetBrains HTTP Client). Values are placeholders; nothing is sent.
 */
import type { Endpoint, EndpointParameter, Framework, ServerInfo } from '../core/types';
import { compareEndpoints } from './markdown';

const DEFAULT_PORTS: Record<Framework, number> = { express: 3000, fastify: 3000, koa: 3000, nestjs: 3000, spring: 8080 };
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

export interface BaseUrlOptions {
  /** `apiShadow.requests.baseUrl`; empty to use the detected port. */
  baseUrl: string;
  servers: readonly ServerInfo[];
}

/** The setting if given, else `http://localhost:<port>` from the code, else the framework default. */
export function baseUrlFor(e: Endpoint, options: BaseUrlOptions): string {
  const configured = options.baseUrl.trim().replace(/\/+$/, '');
  if (configured) return configured;
  const port = options.servers.find((s) => s.projectRoot === e.projectRoot)?.port ?? DEFAULT_PORTS[e.framework];
  return `http://localhost:${port}`;
}

export interface RequestTemplate {
  method: string;
  /** Path with each parameter replaced by `fill(name)`. */
  path: string;
  query: EndpointParameter[];
  headers: EndpointParameter[];
  cookies: EndpointParameter[];
  body: boolean;
  bearer: boolean;
  /** Why the request may need editing before it works. */
  warnings: string[];
}

export function requestTemplate(e: Endpoint, fill: (name: string, param?: EndpointParameter) => string): RequestTemplate {
  const warnings: string[] = [];
  const param = (name: string): string => fill(name, e.parameters.find((p) => p.in === 'path' && p.name === name));
  const path = e.path
    // Spring and OpenAPI style `{id}`, `{id:\d+}`, `{*rest}`; `${expr}` is a dynamic part, not a parameter.
    .replace(/(?<!\$)\{\*?([A-Za-z_$][\w$.-]*)(?::[^}]*)?\}/g, (_m, name: string) => param(name))
    // Express and NestJS style `:id`, `:id?`, `:id(\d+)`.
    .replace(/:([A-Za-z_$][\w$]*)(\([^)]*\))?\??/g, (_m, name: string) => param(name));
  if (!e.pathIsStatic) warnings.push('The path contains parts that could not be resolved statically; edit it before sending.');
  if (e.method === 'ALL') warnings.push('The route matches every HTTP method; GET is used.');
  return {
    method: e.method === 'ALL' ? 'GET' : e.method,
    path,
    query: e.parameters.filter((p) => p.in === 'query'),
    headers: e.parameters.filter((p) => p.in === 'header'),
    cookies: e.parameters.filter((p) => p.in === 'cookie'),
    body: !!e.requestBodyType || BODY_METHODS.has(e.method),
    bearer: e.auth?.status === 'protected',
    warnings,
  };
}

/** A plausible value for a parameter, so the request can be sent as is. */
export function sampleValue(param?: EndpointParameter): string {
  const type = param?.type?.toLowerCase() ?? '';
  if (type === 'uuid') return '00000000-0000-0000-0000-000000000000';
  if (type === 'string') return 'example';
  if (type === 'boolean') return 'true';
  return '1';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A multi-line cURL command; protected endpoints read a token from `$TOKEN`. */
export function toCurl(e: Endpoint, baseUrl: string): { command: string; warnings: string[] } {
  const t = requestTemplate(e, (_name, p) => encodeURIComponent(sampleValue(p)));
  const required = t.query.filter((q) => q.required);
  const query = required.length ? '?' + required.map((q) => `${encodeURIComponent(q.name)}=${encodeURIComponent(sampleValue(q))}`).join('&') : '';
  const parts = [t.method === 'GET' ? 'curl' : `curl -X ${t.method}`, shellQuote(baseUrl + t.path + query)];
  const lines = [parts.join(' ')];
  for (const h of t.headers) lines.push(`-H ${shellQuote(`${h.name}: ${sampleValue(h)}`)}`);
  if (t.cookies.length) lines.push(`-b ${shellQuote(t.cookies.map((c) => `${c.name}=${sampleValue(c)}`).join('; '))}`);
  if (t.bearer) lines.push('-H "Authorization: Bearer $TOKEN"');
  if (t.body) lines.push(`-H ${shellQuote('Content-Type: application/json')}`, `-d ${shellQuote('{}')}`);
  return { command: lines.join(' \\\n  '), warnings: t.warnings };
}

export interface HttpFileOptions {
  title?: string;
  /** Extra comment lines under the title, e.g. how to send the requests. */
  notes?: string[];
  baseUrl: (e: Endpoint) => string;
  /** Maps absolute paths to the form shown in comments; omit to leave locations out. */
  relativePath?: (file: string) => string;
}

/** A `.http` document with one request per endpoint and shared variables at the top. */
export function toHttpFile(endpoints: readonly Endpoint[], options: HttpFileOptions): string {
  const variables = new Map<string, string>();
  const baseVars = new Map<string, string>();
  const variable = (name: string, value: string): string => {
    const v = name.replace(/[^\w]/g, '_');
    if (!variables.has(v)) variables.set(v, value);
    return `{{${v}}}`;
  };
  const requests: string[] = [];
  for (const e of [...endpoints].sort(compareEndpoints)) {
    const base = options.baseUrl(e);
    let baseVar = baseVars.get(base);
    if (!baseVar) {
      baseVar = baseVars.size === 0 ? 'baseUrl' : `baseUrl${baseVars.size + 1}`;
      baseVars.set(base, baseVar);
    }
    const t = requestTemplate(e, (name, p) => variable(name, sampleValue(p)));
    const lines: string[] = [`### ${e.method} ${e.path}`];
    // Inline handlers are named `(anonymous)`; only real names help.
    const handler = e.handler && !e.handler.startsWith('(') ? (e.controller ? `${e.controller}.${e.handler}` : e.handler) : undefined;
    const where = [handler, options.relativePath ? `${options.relativePath(e.location.file)}:${e.location.line}` : undefined].filter(Boolean);
    if (where.length) lines.push(`# ${where.join(' · ')}`);
    for (const w of t.warnings) lines.push(`# ${w}`);
    const optional = t.query.filter((q) => !q.required);
    if (optional.length) lines.push(`# Optional query parameters: ${optional.map((q) => q.name).join(', ')}`);
    if (e.requestBodyType) lines.push(`# Body: ${e.requestBodyType}`);
    const required = t.query.filter((q) => q.required);
    const query = required.length ? '?' + required.map((q) => `${q.name}=${variable(q.name, sampleValue(q))}`).join('&') : '';
    lines.push(`${t.method} {{${baseVar}}}${t.path}${query}`);
    for (const h of t.headers) lines.push(`${h.name}: ${variable(h.name, sampleValue(h))}`);
    if (t.cookies.length) lines.push(`Cookie: ${t.cookies.map((c) => `${c.name}=${variable(c.name, sampleValue(c))}`).join('; ')}`);
    if (t.bearer) lines.push(`Authorization: Bearer ${variable('token', '')}`);
    if (t.body) lines.push('Content-Type: application/json', '', '{}');
    requests.push(lines.join('\n'));
  }
  const header: string[] = [];
  if (options.title) {
    header.push(`# ${options.title}`, '# Generated by API Shadow. Values are placeholders; edit the variables below.');
    for (const n of options.notes ?? []) header.push(`# ${n}`);
    header.push('');
  }
  for (const [base, name] of baseVars) header.push(`@${name} = ${base}`);
  for (const [name, value] of variables) header.push(`@${name} = ${value}`);
  return [header.join('\n'), ...requests].join('\n\n') + '\n';
}
