/**
 * Compares the endpoints of two analyses (e.g. `main` and the working tree) and classifies the
 * differences, flagging those that can break existing clients.
 */
import { normalizeForComparison } from './paths';
import type { AnalysisResult, Endpoint } from './types';

export interface EndpointChange {
  before: Endpoint;
  after: Endpoint;
  changes: { text: string; breaking: boolean }[];
}

export interface ApiDiff {
  added: Endpoint[];
  removed: Endpoint[];
  changed: EndpointChange[];
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
  const removed = [...old.values()].flat();
  const breaking = removed.length + changed.reduce((n, c) => n + c.changes.filter((x) => x.breaking).length, 0);
  return { added, removed, changed, breaking };
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
  return out;
}

function code(value: string): string {
  return '`' + value.replace(/`/g, 'ˋ') + '`';
}

/** A Markdown report, suitable for a pull request description. */
export function diffToMarkdown(diff: ApiDiff, baseLabel: string, headLabel: string, relativePath: (file: string) => string): string {
  const lines: string[] = [`# API changes: ${baseLabel} → ${headLabel}`, ''];
  const total = diff.added.length + diff.removed.length + diff.changed.length;
  if (total === 0) return [...lines, 'No endpoint changes.', ''].join('\n');
  lines.push(
    `**${diff.added.length} added · ${diff.removed.length} removed · ${diff.changed.length} changed**` +
      (diff.breaking ? ` · ⚠️ **${diff.breaking} breaking**` : ' · no breaking changes'),
    '',
  );
  const where = (e: Endpoint): string => `${relativePath(e.location.file)}:${e.location.line}`;
  if (diff.removed.length) {
    lines.push('## ⚠️ Removed (breaking)', '');
    for (const e of diff.removed) lines.push(`- **${e.method}** ${code(e.path)} — was in ${where(e)}`);
    lines.push('');
  }
  const breakingChanges = diff.changed.filter((c) => c.changes.some((x) => x.breaking));
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
