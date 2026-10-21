/**
 * Compares the endpoints of two analyses (e.g. `main` and the working tree) and classifies the
 * differences, flagging those that can break existing clients.
 */
import { normalizeForComparison } from './paths';
import { describeShape, diffShapes, statusCodes, successShape } from './shapes';
import type { AnalysisResult, Endpoint } from './types';

/** A response field that changed, for impact analysis. Paths are relative to the response body. */
export interface FieldChange {
  kind: 'removed' | 'renamed' | 'type';
  path: string;
  /** New name (renamed) or new type (type). */
  to?: string;
}

export interface Difference {
  text: string;
  breaking: boolean;
  field?: FieldChange;
}

export interface EndpointChange {
  before: Endpoint;
  after: Endpoint;
  changes: Difference[];
}

export interface ApiDiff {
  added: Endpoint[];
  removed: Endpoint[];
  changed: EndpointChange[];
  /** The same handler now serves a different method or path. */
  moved: EndpointChange[];
  /** Number of breaking differences: removed endpoints plus breaking changes. */
  breaking: number;
}

/** Endpoints are the same route when framework, method and path (ignoring parameter names) match. */
function routeKey(e: Endpoint): string {
  return [e.framework, e.method, normalizeForComparison(e.path, e.framework), e.version ?? '', (e.conditions ?? []).join('&')].join('|');
}

export function diffApis(before: AnalysisResult, after: AnalysisResult): ApiDiff {
  const old = new Map<string, Endpoint[]>();
  for (const e of before.endpoints) old.set(routeKey(e), [...(old.get(routeKey(e)) ?? []), e]);
  const added: Endpoint[] = [];
  const changed: EndpointChange[] = [];
  for (const e of after.endpoints) {
    const list = old.get(routeKey(e));
    const match = list?.shift();
    if (!match) {
      added.push(e);
      continue;
    }
    const changes = compare(match, e);
    if (changes.length > 0) changed.push({ before: match, after: e, changes });
  }
  let removed = [...old.values()].flat();
  // A removed and an added route with the same handler: the route moved (or changed method).
  const moved: EndpointChange[] = [];
  const handlerKey = (e: Endpoint): string | undefined => (e.handler && e.handler !== '(anonymous)' ? `${e.framework}|${e.controller ?? ''}|${e.handler}` : undefined);
  for (const r of [...removed]) {
    const key = handlerKey(r);
    const a = key ? added.find((x) => handlerKey(x) === key) : undefined;
    if (!a) continue;
    const parts: string[] = [];
    if (r.method !== a.method) parts.push(`method ${r.method} → ${a.method}`);
    if (normalizeForComparison(r.path, r.framework) !== normalizeForComparison(a.path, a.framework)) parts.push(`path ${r.path} → ${a.path}`);
    moved.push({ before: r, after: a, changes: [{ text: `Route changed: ${parts.join(', ')}`, breaking: true }, ...compare(r, a)] });
    removed = removed.filter((x) => x !== r);
    added.splice(added.indexOf(a), 1);
  }
  const breaking = removed.length + [...changed, ...moved].reduce((n, c) => n + c.changes.filter((x) => x.breaking).length, 0);
  return { added, removed, changed, moved, breaking };
}

function compare(a: Endpoint, b: Endpoint): { text: string; breaking: boolean }[] {
  const out: { text: string; breaking: boolean }[] = [];
  const authA = a.auth?.status ?? 'none';
  const authB = b.auth?.status ?? 'none';
  const guarded = (s: string): boolean => s === 'protected' || s === 'central';
  if (guarded(authA) && !guarded(authB)) out.push({ text: `Auth removed (was ${a.auth?.via.join(', ') || authA})`, breaking: false });
  if (!guarded(authA) && guarded(authB)) out.push({ text: `Auth added (${b.auth?.via.join(', ') || authB}); existing clients without credentials will fail`, breaking: true });
  const required = (e: Endpoint): Map<string, string> => new Map(e.parameters.filter((p) => p.required && p.in !== 'path').map((p) => [`${p.in}:${p.name}`, `${p.in} parameter "${p.name}"`]));
  const reqA = required(a);
  const reqB = required(b);
  for (const [k, label] of reqB) if (!reqA.has(k)) out.push({ text: `New required ${label}`, breaking: true });
  for (const [k, label] of reqA) if (!reqB.has(k)) out.push({ text: `${label[0].toUpperCase()}${label.slice(1)} is no longer required`, breaking: false });
  if (a.requestBodyType !== b.requestBodyType) {
    if (!a.requestBodyType) out.push({ text: `Now expects a request body (${b.requestBodyType})`, breaking: true });
    else if (!b.requestBodyType) out.push({ text: `No longer reads a request body (was ${a.requestBodyType})`, breaking: false });
    else out.push({ text: `Request body type changed: ${a.requestBodyType} → ${b.requestBodyType}`, breaking: true });
  }
  if (a.path !== b.path) out.push({ text: `Path parameters renamed: ${a.path} → ${b.path}`, breaking: false });
  if (a.validation?.status === 'validated' && b.validation?.status === 'missing') out.push({ text: 'Request body validation removed', breaking: false });
  const mwA = new Set(a.middleware);
  const mwB = new Set(b.middleware);
  const addedMw = [...mwB].filter((m) => !mwA.has(m));
  const removedMw = [...mwA].filter((m) => !mwB.has(m));
  if (addedMw.length) out.push({ text: `Middleware added: ${addedMw.join(', ')}`, breaking: false });
  if (removedMw.length) out.push({ text: `Middleware removed: ${removedMw.join(', ')}`, breaking: false });
  out.push(...responseChanges(a, b));
  return out;
}

/** Changes to the inferred success response: removed, renamed and retyped fields, status codes. */
function responseChanges(a: Endpoint, b: Endpoint): Difference[] {
  const out: Difference[] = [];
  const sa = successShape(a);
  const sb = successShape(b);
  if (sa && sb) {
    for (const c of diffShapes(sa, sb)) {
      if (c.kind === 'removed') out.push({ text: `Response field \`${c.path}\` removed`, breaking: true, field: { kind: 'removed', path: c.path } });
      else if (c.kind === 'renamed') out.push({ text: `Response field \`${c.path}\` renamed to \`${c.to}\` (${c.evidence})`, breaking: true, field: { kind: 'renamed', path: c.path, to: c.to } });
      else if (c.kind === 'type') out.push({ text: `Response field \`${c.path}\` changed from ${c.from} to ${c.to}`, breaking: true, field: { kind: 'type', path: c.path, to: c.to } });
      else if (c.kind === 'added') out.push({ text: `Response field \`${c.path}\` added`, breaking: false });
      else out.push({ text: `Response field \`${c.path}\` is no longer always present`, breaking: true, field: { kind: 'removed', path: c.path } });
    }
  } else if (sa && !sb && (b.responses ?? []).length > 0) {
    out.push({ text: `Response shape is no longer known statically (was ${describeShape(sa)})`, breaking: false });
  }
  const ca = statusCodes(a).filter((s) => s < 400);
  const cb = statusCodes(b).filter((s) => s < 400);
  const lost = ca.filter((s) => !cb.includes(s));
  if (ca.length && cb.length && lost.length) out.push({ text: `Success status changed: ${ca.join(', ')} → ${cb.join(', ')}`, breaking: true });
  return out;
}

function code(value: string): string {
  return '`' + value.replace(/`/g, 'ˋ') + '`';
}

/** A Markdown report, suitable for a pull request description. */
export function diffToMarkdown(diff: ApiDiff, baseLabel: string, headLabel: string, relativePath: (file: string) => string): string {
  const lines: string[] = [`# API changes: ${baseLabel} → ${headLabel}`, ''];
  const total = diff.added.length + diff.removed.length + diff.changed.length + diff.moved.length;
  if (total === 0) return [...lines, 'No endpoint changes.', ''].join('\n');
  lines.push(
    `**${diff.added.length} added · ${diff.removed.length} removed · ${diff.changed.length + diff.moved.length} changed**` +
      (diff.breaking ? ` · ⚠️ **${diff.breaking} breaking**` : ' · no breaking changes'),
    '',
  );
  const where = (e: Endpoint): string => `${relativePath(e.location.file)}:${e.location.line}`;
  if (diff.removed.length) {
    lines.push('## ⚠️ Removed (breaking)', '');
    for (const e of diff.removed) lines.push(`- **${e.method}** ${code(e.path)} — was in ${where(e)}`);
    lines.push('');
  }
  const breakingChanges = [...diff.moved, ...diff.changed.filter((c) => c.changes.some((x) => x.breaking))];
  const otherChanges = diff.changed.filter((c) => !c.changes.some((x) => x.breaking));
  const listChanges = (list: EndpointChange[]): void => {
    for (const c of list) {
      lines.push(`- **${c.after.method}** ${code(c.after.path)} — ${where(c.after)}`);
      for (const x of c.changes) lines.push(`  - ${x.breaking ? '⚠️ ' : x.text.startsWith('Auth removed') ? '🔓 ' : ''}${x.text}`);
    }
    lines.push('');
  };
  if (breakingChanges.length) {
    lines.push('## ⚠️ Breaking changes', '');
    listChanges(breakingChanges);
  }
  if (diff.added.length) {
    lines.push('## Added', '');
    for (const e of diff.added) lines.push(`- **${e.method}** ${code(e.path)} — ${where(e)}${e.auth?.status === 'none' ? ' (no auth)' : ''}`);
    lines.push('');
  }
  if (otherChanges.length) {
    lines.push('## Changed', '');
    listChanges(otherChanges);
  }
  lines.push('_Generated by API Shadow from static analysis of both versions._', '');
  return lines.join('\n');
}
