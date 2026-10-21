/**
 * OpenAPI 3.x contract comparison. Parses JSON or YAML documents, resolves local `$ref`s and
 * `allOf`, normalises operations, and classifies every difference:
 *
 * - `breaking`: existing clients are expected to fail (removed operation or response field,
 *   new required input, changed type, auth newly required).
 * - `potentially-breaking`: may fail depending on how clients behave (response field now
 *   optional, success status changed, removed request property with `additionalProperties: false`).
 * - `non-breaking`: additive changes.
 * - `info`: worth knowing (auth removed, deprecations, new error statuses).
 *
 * Nothing in the documents is executed or fetched: remote `$ref`s are reported as unresolved.
 */
import { parse as parseYaml } from 'yaml';

export type ContractSeverity = 'breaking' | 'potentially-breaking' | 'non-breaking' | 'info';

export interface SchemaNode {
  type?: string;
  format?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  enum?: unknown[];
  nullable?: boolean;
  additionalProperties?: boolean | SchemaNode;
  /** `oneOf`/`anyOf` and unresolved references: compared only by presence. */
  opaque?: string;
}

export interface ContractParameter {
  name: string;
  in: string;
  required: boolean;
  schema?: SchemaNode;
}

export interface ContractOperation {
  /** `GET /users/{}`: method and path with parameter names removed. */
  key: string;
  method: string;
  path: string;
  operationId?: string;
  deprecated: boolean;
  parameters: ContractParameter[];
  requestBody?: { required: boolean; schema?: SchemaNode };
  /** status code (or `default`, `2XX`) → response body schema */
  responses: Record<string, { schema?: SchemaNode }>;
  /** Requires authentication (non-empty `security` with at least one non-empty requirement). */
  secured: boolean;
}

export interface Contract {
  title?: string;
  version?: string;
  openapi: string;
  operations: Map<string, ContractOperation>;
  /** References that could not be resolved (remote or missing). */
  unresolved: string[];
}

export interface ContractChange {
  severity: ContractSeverity;
  /** Operation key, e.g. `GET /users/{}`. */
  operation: string;
  /** Path as written in the newer document (or the older one, for removals). */
  display: string;
  area: 'operation' | 'parameter' | 'request' | 'response' | 'security' | 'status';
  text: string;
}

export interface ContractDiff {
  changes: ContractChange[];
  counts: Record<ContractSeverity, number>;
  before: { title?: string; version?: string; operations: number };
  after: { title?: string; version?: string; operations: number };
}

export class ContractError extends Error {}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const MAX_REF_DEPTH = 24;

/** True when a file's text looks like an OpenAPI 3 document (cheap check before parsing). */
export function looksLikeOpenApi(text: string): boolean {
  return /(^|\n)\s*["']?openapi["']?\s*:\s*["']?3\./.test(text.slice(0, 4096));
}

export function parseContract(text: string, fileName = 'document'): Contract {
  let doc: unknown;
  try {
    doc = /^\s*[{[]/.test(text) ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 100 });
  } catch (err) {
    throw new ContractError(`${fileName} is not valid ${/^\s*[{[]/.test(text) ? 'JSON' : 'YAML'}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
  if (!isObj(doc)) throw new ContractError(`${fileName} is not an OpenAPI document.`);
  if (typeof doc.swagger === 'string') throw new ContractError(`${fileName} is Swagger ${doc.swagger}; only OpenAPI 3.x is supported. Convert it with swagger2openapi first.`);
  const version = typeof doc.openapi === 'string' ? doc.openapi : undefined;
  if (!version || !version.startsWith('3.')) throw new ContractError(`${fileName} has no "openapi: 3.x" field.`);
  const resolver = new Resolver(doc);
  const operations = new Map<string, ContractOperation>();
  const paths = isObj(doc.paths) ? doc.paths : {};
  const globalSecurity = doc.security;
  for (const [p, rawItem] of Object.entries(paths)) {
    const item = resolver.deref(rawItem);
    if (!isObj(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = resolver.deref(item[method]);
      if (!isObj(op)) continue;
      const params = new Map<string, ContractParameter>();
      for (const raw of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const param = resolver.deref(raw);
        if (!isObj(param) || typeof param.name !== 'string' || typeof param.in !== 'string') continue;
        params.set(`${param.in}:${param.name}`, { name: param.name, in: param.in, required: param.in === 'path' || param.required === true, schema: param.schema !== undefined ? resolver.schema(param.schema) : undefined });
      }
      let requestBody: ContractOperation['requestBody'];
      const rb = resolver.deref(op.requestBody);
      if (isObj(rb)) requestBody = { required: rb.required === true, schema: mediaSchema(rb.content, resolver) };
      const responses: ContractOperation['responses'] = {};
      if (isObj(op.responses)) {
        for (const [status, raw] of Object.entries(op.responses)) {
          const r = resolver.deref(raw);
          responses[status] = { schema: isObj(r) ? mediaSchema(r.content, resolver) : undefined };
        }
      }
      const security = op.security !== undefined ? op.security : globalSecurity;
      const secured = Array.isArray(security) && security.length > 0 && security.every((req) => isObj(req) && Object.keys(req).length > 0);
      const key = `${method.toUpperCase()} ${normalizePath(p)}`;
      operations.set(key, {
        key,
        method: method.toUpperCase(),
        path: p,
        operationId: typeof op.operationId === 'string' ? op.operationId : undefined,
        deprecated: op.deprecated === true,
        parameters: [...params.values()],
        requestBody,
        responses,
        secured,
      });
    }
  }
  const info = isObj(doc.info) ? doc.info : {};
  return { title: str(info.title), version: str(info.version), openapi: version, operations, unresolved: [...resolver.unresolved] };
}

/** `/users/{userId}/posts/{id}` → `/users/{}/posts/{}`, trailing slash removed. */
export function normalizePath(p: string): string {
  const n = p.replace(/\{[^}]+\}/g, '{}').replace(/\/+$/, '');
  return n === '' ? '/' : n;
}

export function diffContracts(before: Contract, after: Contract): ContractDiff {
  const changes: ContractChange[] = [];
  const add = (severity: ContractSeverity, op: ContractOperation, area: ContractChange['area'], text: string): void => {
    changes.push({ severity, operation: op.key, display: `${op.method} ${op.path}`, area, text });
  };
  const removed = [...before.operations.values()].filter((o) => !after.operations.has(o.key));
  const added = [...after.operations.values()].filter((o) => !before.operations.has(o.key));
  // Same operationId under a new path or method: the operation moved.
  for (const r of [...removed]) {
    const moved = r.operationId ? added.find((a) => a.operationId === r.operationId) : undefined;
    if (!moved) continue;
    add('breaking', moved, 'operation', `Moved from ${r.method} ${r.path} to ${moved.method} ${moved.path} (operationId ${r.operationId})`);
    compareOperations(r, moved, add);
    removed.splice(removed.indexOf(r), 1);
    added.splice(added.indexOf(moved), 1);
  }
  for (const r of removed) add(r.deprecated ? 'potentially-breaking' : 'breaking', r, 'operation', r.deprecated ? 'Removed (was deprecated)' : 'Removed');
  for (const a of added) add('non-breaking', a, 'operation', 'Added');
  for (const [key, a] of before.operations) {
    const b = after.operations.get(key);
    if (b) compareOperations(a, b, add);
  }
  const order: Record<ContractSeverity, number> = { breaking: 0, 'potentially-breaking': 1, 'non-breaking': 2, info: 3 };
  changes.sort((x, y) => order[x.severity] - order[y.severity] || x.operation.localeCompare(y.operation));
  const counts: Record<ContractSeverity, number> = { breaking: 0, 'potentially-breaking': 0, 'non-breaking': 0, info: 0 };
  for (const c of changes) counts[c.severity]++;
  return {
    changes,
    counts,
    before: { title: before.title, version: before.version, operations: before.operations.size },
    after: { title: after.title, version: after.version, operations: after.operations.size },
  };
}

type Add = (severity: ContractSeverity, op: ContractOperation, area: ContractChange['area'], text: string) => void;

function compareOperations(a: ContractOperation, b: ContractOperation, add: Add): void {
  // Security
  if (!a.secured && b.secured) add('breaking', b, 'security', 'Authentication is now required');
  if (a.secured && !b.secured) add('info', b, 'security', 'Authentication is no longer required; check that this is intended');
  if (!a.deprecated && b.deprecated) add('info', b, 'operation', 'Marked deprecated');

  // Parameters
  const pa = new Map(a.parameters.map((p) => [`${p.in}:${p.name}`, p]));
  const pb = new Map(b.parameters.map((p) => [`${p.in}:${p.name}`, p]));
  for (const [k, p] of pb) {
    const old = pa.get(k);
    if (!old) {
      if (p.in !== 'path') add(p.required ? 'breaking' : 'non-breaking', b, 'parameter', `${p.required ? 'New required' : 'New optional'} ${p.in} parameter \`${p.name}\``);
      continue;
    }
    if (!old.required && p.required) add('breaking', b, 'parameter', `${cap(p.in)} parameter \`${p.name}\` is now required`);
    if (old.required && !p.required) add('non-breaking', b, 'parameter', `${cap(p.in)} parameter \`${p.name}\` is now optional`);
    const ta = typeOf(old.schema);
    const tb = typeOf(p.schema);
    if (ta && tb && ta !== tb) add('breaking', b, 'parameter', `${cap(p.in)} parameter \`${p.name}\` changed type: ${ta} → ${tb}`);
    enumChanges(old.schema, p.schema, `${p.in} parameter \`${p.name}\``, 'request', b, add);
  }
  for (const [k, p] of pa) {
    if (!pb.has(k) && p.in !== 'path') add(p.required ? 'potentially-breaking' : 'info', b, 'parameter', `${cap(p.in)} parameter \`${p.name}\` removed${p.required ? '; clients that send it may now get different results' : ''}`);
  }

  // Request body
  if (!a.requestBody && b.requestBody?.required) add('breaking', b, 'request', 'A request body is now required');
  else if (a.requestBody && b.requestBody) {
    if (!a.requestBody.required && b.requestBody.required) add('breaking', b, 'request', 'The request body is now required');
    if (a.requestBody.schema && b.requestBody.schema) compareSchemas(a.requestBody.schema, b.requestBody.schema, 'request', '', b, add);
  } else if (a.requestBody && !b.requestBody) {
    add('potentially-breaking', b, 'request', 'The request body was removed from the contract');
  }

  // Responses
  const success = (r: ContractOperation['responses']): string[] => Object.keys(r).filter((s) => /^2(\d\d|XX)$/i.test(s));
  const sa = success(a.responses);
  const sb = success(b.responses);
  const lost = sa.filter((s) => !sb.includes(s));
  if (lost.length && sb.length) add('potentially-breaking', b, 'status', `Success status changed: ${sa.join(', ')} → ${sb.join(', ')}`);
  else if (lost.length) add('breaking', b, 'status', `Success response ${lost.join(', ')} removed`);
  for (const s of Object.keys(b.responses)) {
    if (!a.responses[s] && !/^2/.test(s)) add('info', b, 'status', `New ${s} response`);
  }
  for (const s of sa.filter((x) => sb.includes(x))) {
    const x = a.responses[s].schema;
    const y = b.responses[s].schema;
    if (x && y) compareSchemas(x, y, 'response', '', b, add, s);
    else if (x && !y) add('breaking', b, 'response', `${s} response no longer has a body schema`);
  }
}

/** Compares two schemas. `direction` decides what breaks: required inputs vs. removed outputs. */
function compareSchemas(a: SchemaNode, b: SchemaNode, direction: 'request' | 'response', at: string, op: ContractOperation, add: Add, status?: string, depth = 0): void {
  if (depth > 12) return;
  const where = (p: string): string => `${direction === 'response' ? `${status} response` : 'Request'} field \`${p}\``;
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta && tb && ta !== tb && !(ta === 'integer' && tb === 'number' && direction === 'response') && !(ta === 'number' && tb === 'integer' && direction === 'request')) {
    add('breaking', op, direction, `${at ? where(at) : direction === 'response' ? `${status} response body` : 'Request body'} changed type: ${ta} → ${tb}`);
    return;
  }
  if (a.nullable === false || a.nullable === undefined) {
    if (b.nullable && direction === 'response' && at) add('potentially-breaking', op, direction, `${where(at)} may now be null`);
  }
  enumChanges(a, b, at ? where(at) : 'value', direction, op, add);
  if (a.items && b.items) compareSchemas(a.items, b.items, direction, at ? `${at}[]` : '[]', op, add, status, depth + 1);
  const pa = a.properties ?? {};
  const pb = b.properties ?? {};
  const ra = new Set(a.required ?? []);
  const rb = new Set(b.required ?? []);
  for (const [name, schema] of Object.entries(pb)) {
    const p = at ? `${at}.${name}` : name;
    if (!Object.prototype.hasOwnProperty.call(pa, name)) {
      if (direction === 'request') add(rb.has(name) ? 'breaking' : 'non-breaking', op, direction, `${rb.has(name) ? 'New required' : 'New optional'} request field \`${p}\``);
      else add('non-breaking', op, direction, `${where(p)} added`);
      continue;
    }
    if (direction === 'request' && !ra.has(name) && rb.has(name)) add('breaking', op, direction, `${where(p)} is now required`);
    if (direction === 'response' && ra.has(name) && !rb.has(name)) add('potentially-breaking', op, direction, `${where(p)} is no longer required (may be missing)`);
    compareSchemas(pa[name], schema, direction, p, op, add, status, depth + 1);
  }
  for (const name of Object.keys(pa)) {
    if (Object.prototype.hasOwnProperty.call(pb, name)) continue;
    const p = at ? `${at}.${name}` : name;
    if (direction === 'response') add('breaking', op, direction, `${where(p)} removed`);
    else add(b.additionalProperties === false ? 'breaking' : 'potentially-breaking', op, direction, `${where(p)} removed${b.additionalProperties === false ? '; requests that send it are rejected (additionalProperties: false)' : '; the server may ignore or reject it'}`);
  }
}

function enumChanges(a: SchemaNode | undefined, b: SchemaNode | undefined, label: string, direction: 'request' | 'response', op: ContractOperation, add: Add): void {
  if (!a?.enum || !b?.enum) return;
  const sa = new Set(a.enum.map((v) => JSON.stringify(v)));
  const sb = new Set(b.enum.map((v) => JSON.stringify(v)));
  const removed = [...sa].filter((v) => !sb.has(v));
  const added = [...sb].filter((v) => !sa.has(v));
  if (removed.length) add(direction === 'request' ? 'breaking' : 'non-breaking', op, direction, `${cap(label)}: enum value(s) ${removed.join(', ')} removed`);
  if (added.length) add(direction === 'response' ? 'potentially-breaking' : 'non-breaking', op, direction, `${cap(label)}: enum value(s) ${added.join(', ')} added${direction === 'response' ? '; clients may not handle them' : ''}`);
}

function typeOf(s: SchemaNode | undefined): string | undefined {
  if (!s) return undefined;
  if (s.opaque) return undefined;
  if (s.type) return s.type;
  if (s.properties) return 'object';
  if (s.items) return 'array';
  return undefined;
}

function mediaSchema(content: unknown, resolver: Resolver): SchemaNode | undefined {
  if (!isObj(content)) return undefined;
  const keys = Object.keys(content);
  const key = keys.find((k) => /json/i.test(k)) ?? keys[0];
  const media = key ? content[key] : undefined;
  return isObj(media) && media.schema !== undefined ? resolver.schema(media.schema) : undefined;
}

class Resolver {
  readonly unresolved = new Set<string>();
  private readonly cache = new Map<string, SchemaNode>();

  constructor(private readonly doc: Record<string, unknown>) {}

  /** Follows a local `$ref` (`#/components/...`); anything else is returned as is. */
  deref(value: unknown, depth = 0): unknown {
    if (!isObj(value) || typeof value.$ref !== 'string' || depth > MAX_REF_DEPTH) return value;
    const target = this.pointer(value.$ref);
    if (target === undefined) {
      this.unresolved.add(value.$ref);
      return undefined;
    }
    return this.deref(target, depth + 1);
  }

  private pointer(ref: string): unknown {
    if (!ref.startsWith('#/')) return undefined;
    let current: unknown = this.doc;
    for (const raw of ref.slice(2).split('/')) {
      const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!isObj(current) || !Object.prototype.hasOwnProperty.call(current, seg)) return undefined;
      current = current[seg];
    }
    return current;
  }

  schema(value: unknown, depth = 0, stack: string[] = []): SchemaNode {
    if (depth > MAX_REF_DEPTH) return { opaque: 'depth' };
    if (isObj(value) && typeof value.$ref === 'string') {
      const ref = value.$ref;
      if (stack.includes(ref)) return { opaque: `recursive ${ref}` };
      const cached = this.cache.get(ref);
      if (cached) return cached;
      const target = this.pointer(ref);
      if (target === undefined) {
        this.unresolved.add(ref);
        return { opaque: ref };
      }
      const s = this.schema(target, depth + 1, [...stack, ref]);
      this.cache.set(ref, s);
      return s;
    }
    if (!isObj(value)) return {};
    if (Array.isArray(value.allOf)) {
      const parts = value.allOf.map((x) => this.schema(x, depth + 1, stack));
      const merged: SchemaNode = { type: 'object', properties: {}, required: [] };
      for (const p of parts) {
        Object.assign(merged.properties!, p.properties ?? {});
        merged.required!.push(...(p.required ?? []));
        if (p.additionalProperties === false) merged.additionalProperties = false;
      }
      const own = this.schema({ ...value, allOf: undefined }, depth + 1, stack);
      Object.assign(merged.properties!, own.properties ?? {});
      merged.required!.push(...(own.required ?? []));
      return merged;
    }
    if (Array.isArray(value.oneOf) || Array.isArray(value.anyOf)) return { opaque: Array.isArray(value.oneOf) ? 'oneOf' : 'anyOf', nullable: value.nullable === true || undefined };
    const out: SchemaNode = {};
    // OpenAPI 3.1 writes nullable types as `type: [string, 'null']`.
    if (Array.isArray(value.type)) {
      const types = value.type.filter((t): t is string => typeof t === 'string');
      const nonNull = types.filter((t) => t !== 'null');
      if (nonNull.length === 1) out.type = nonNull[0];
      if (types.includes('null')) out.nullable = true;
    } else if (typeof value.type === 'string') out.type = value.type;
    if (typeof value.format === 'string') out.format = value.format;
    if (value.nullable === true) out.nullable = true;
    if (Array.isArray(value.enum)) out.enum = value.enum;
    if (Array.isArray(value.required)) out.required = value.required.filter((r): r is string => typeof r === 'string');
    if (isObj(value.properties)) {
      out.properties = {};
      for (const [k, v] of Object.entries(value.properties)) out.properties[k] = this.schema(v, depth + 1, stack);
    }
    if (value.items !== undefined) out.items = this.schema(value.items, depth + 1, stack);
    if (value.additionalProperties === false) out.additionalProperties = false;
    return out;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

const SEVERITY_LABEL: Record<ContractSeverity, string> = {
  breaking: '⚠️ Breaking',
  'potentially-breaking': 'Potentially breaking',
  'non-breaking': 'Non-breaking',
  info: 'Informational',
};

/** Markdown report of a contract diff, grouped by operation. */
export function contractDiffToMarkdown(diff: ContractDiff, beforeLabel: string, afterLabel: string, file?: string): string {
  const lines = [`# API contract diff: ${beforeLabel} → ${afterLabel}`, ''];
  if (file) lines.push(`Contract: \`${file}\``, '');
  lines.push(
    `${diff.before.title ?? 'Before'} ${diff.before.version ?? ''} (${diff.before.operations} operations) → ${diff.after.title ?? 'After'} ${diff.after.version ?? ''} (${diff.after.operations} operations)`.replace(/\s+\(/g, ' ('),
    '',
  );
  if (diff.changes.length === 0) return [...lines, 'No differences between the two contracts.', ''].join('\n');
  lines.push(`**${diff.counts.breaking} breaking · ${diff.counts['potentially-breaking']} potentially breaking · ${diff.counts['non-breaking']} non-breaking · ${diff.counts.info} informational**`, '');
  const compatibility = diff.counts.breaking ? 'Breaking' : diff.counts['potentially-breaking'] ? 'Potentially breaking' : 'Compatible';
  lines.push(`Compatibility: **${compatibility}**`, '');
  const byOp = new Map<string, ContractChange[]>();
  for (const c of diff.changes) byOp.set(c.display, [...(byOp.get(c.display) ?? []), c]);
  for (const [op, list] of byOp) {
    lines.push(`## ${op.replace(/`/g, 'ˋ')}`, '');
    for (const c of list) lines.push(`- **${SEVERITY_LABEL[c.severity]}** (${c.area}): ${c.text}`);
    lines.push('');
  }
  lines.push('_Generated by API Shadow by comparing the two OpenAPI documents. Nothing was executed or fetched._', '');
  return lines.join('\n');
}

/** An endpoint as seen by the drift check: method and OpenAPI-style path. */
export interface ImplementedOperation {
  method: string;
  /** `/users/{id}` (OpenAPI template) */
  path: string;
  /** `GET /users/:id` as discovered, for display. */
  label: string;
}

/**
 * Differences between a contract and the implementation found in code: documented operations
 * with no matching route (clients following the spec will fail), and routes the contract does
 * not document. Only methods and paths are compared; schemas inferred from code are too partial
 * to compare against a specification.
 */
export function contractDrift(contract: Contract, implemented: ImplementedOperation[]): ContractDiff {
  const changes: ContractChange[] = [];
  const impl = new Map<string, ImplementedOperation>();
  for (const op of implemented) impl.set(`${op.method} ${normalizePath(op.path)}`, op);
  for (const op of contract.operations.values()) {
    if (impl.has(op.key)) continue;
    changes.push({ severity: op.deprecated ? 'potentially-breaking' : 'breaking', operation: op.key, display: `${op.method} ${op.path}`, area: 'operation', text: 'Documented in the contract, but no matching route was found in code' });
  }
  for (const [key, op] of impl) {
    if (contract.operations.has(key)) continue;
    changes.push({ severity: 'info', operation: key, display: op.label, area: 'operation', text: 'Implemented in code, but not documented in the contract' });
  }
  const counts: Record<ContractSeverity, number> = { breaking: 0, 'potentially-breaking': 0, 'non-breaking': 0, info: 0 };
  for (const c of changes) counts[c.severity]++;
  return {
    changes,
    counts,
    before: { title: contract.title, version: contract.version, operations: contract.operations.size },
    after: { title: 'Implementation', operations: impl.size },
  };
}
