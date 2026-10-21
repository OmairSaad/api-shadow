/**
 * API change impact. Compares a baseline analysis (git HEAD, a branch, or the start of the
 * session) with the current one and, for every changed endpoint, finds the client code that may
 * break: calls to it, and reads of response fields that were removed, renamed or retyped.
 *
 * Also checks the current analysis on its own: a client reading a field that the endpoint's
 * (closed) response shape does not contain.
 *
 * Findings are `confirmed` only when the evidence is direct (a read of a field missing from a
 * shape built from literals or declared types); everything else is `heuristic`.
 */
import * as path from 'path';
import { diffApis, type Difference } from './apiDiff';
import { describeShape, lookup, suggestions, successShape } from './shapes';
import type { AnalysisIssue, AnalysisResult, ClientCall, Endpoint, ResponseRead, SourceLocation } from './types';

export type Risk = 'high' | 'medium' | 'low';
export type Evidence = 'confirmed' | 'heuristic';

export interface AffectedRead {
  callId: string;
  path: string;
  location: SourceLocation;
  within?: string;
  /** Replacement for the last segment of the read, when the field was renamed. */
  suggestion?: { from: string; to: string };
}

export interface ImpactChange {
  text: string;
  breaking: boolean;
  risk: Risk;
  evidence: Evidence;
  /** Why the risk was chosen, in one sentence. */
  reason: string;
  reads: AffectedRead[];
}

export interface ImpactCaller {
  callId: string;
  client: string;
  kind: 'app' | 'test';
  location: SourceLocation;
  within?: string;
  /** Components or functions that receive this call's response. */
  consumers: { within?: string; location: SourceLocation }[];
}

export interface EndpointImpact {
  key: string;
  method: string;
  path: string;
  status: 'removed' | 'moved' | 'changed';
  before: Endpoint;
  after?: Endpoint;
  changes: ImpactChange[];
  callers: ImpactCaller[];
  risk: Risk;
}

export interface ImpactReport {
  baseLabel: string;
  endpoints: EndpointImpact[];
  summary: Record<Risk, number>;
  /** Added endpoints (informational). */
  added: Endpoint[];
}

const RANK: Record<Risk, number> = { high: 3, medium: 2, low: 1 };

/** Impact of going from `before` to `after`. Calls and reads come from `after` (the code as it is now). */
export function analyzeImpact(before: AnalysisResult, after: AnalysisResult, baseLabel: string): ImpactReport {
  const diff = diffApis(before, after);
  const callsByEndpoint = indexCalls(after.clientCalls);
  const beforeCalls = indexCalls(before.clientCalls);
  const endpoints: EndpointImpact[] = [];

  const callersOf = (e: Endpoint | undefined, old: Endpoint): ClientCall[] => {
    const now = e ? (callsByEndpoint.get(e.id) ?? []) : [];
    // A removed route's callers: calls at the same place that reached it in the baseline.
    const then = (beforeCalls.get(old.id) ?? []).map((c) => after.clientCalls.find((x) => x.id === c.id) ?? c);
    return dedupe([...now, ...then]);
  };

  for (const e of diff.removed) {
    const callers = callersOf(undefined, e);
    const appCallers = callers.filter((c) => c.kind === 'app');
    const change: ImpactChange = {
      text: `Endpoint removed`,
      breaking: true,
      risk: appCallers.length ? 'high' : callers.length ? 'medium' : 'low',
      evidence: callers.length ? 'confirmed' : 'heuristic',
      reason: appCallers.length ? `${appCallers.length} call(s) in the workspace still request it.` : callers.length ? 'Only tests call it.' : 'No caller found in the workspace; external clients may still use it.',
      reads: [],
    };
    endpoints.push(entry(e, undefined, 'removed', [change], callers));
  }
  for (const c of [...diff.moved, ...diff.changed]) {
    const callers = callersOf(c.after, c.before);
    const changes = c.changes.map((d) => impactOf(d, callers, c.after));
    if (changes.length === 0) continue;
    endpoints.push(entry(c.before, c.after, diff.moved.includes(c) ? 'moved' : 'changed', changes, callers));
  }
  endpoints.sort((a, b) => RANK[b.risk] - RANK[a.risk] || a.path.localeCompare(b.path));
  const summary: Record<Risk, number> = { high: 0, medium: 0, low: 0 };
  for (const e of endpoints) summary[e.risk]++;
  return { baseLabel, endpoints, summary, added: diff.added };
}

function entry(before: Endpoint, after: Endpoint | undefined, status: EndpointImpact['status'], changes: ImpactChange[], calls: ClientCall[]): EndpointImpact {
  const risk = changes.reduce<Risk>((r, c) => (RANK[c.risk] > RANK[r] ? c.risk : r), 'low');
  const e = after ?? before;
  return {
    key: `${e.framework}|${e.method}|${e.path}|${e.location.file}`,
    method: e.method,
    path: e.path,
    status,
    before,
    after,
    changes,
    callers: calls.map((c) => ({ callId: c.id, client: c.client, kind: c.kind, location: c.location, within: c.within, consumers: (c.consumers ?? []).map((x) => ({ within: x.within, location: x.location })) })),
    risk,
  };
}

/** Risk of one difference given who calls the endpoint and which fields they read. */
function impactOf(d: Difference, callers: ClientCall[], after: Endpoint): ImpactChange {
  const app = callers.filter((c) => c.kind === 'app');
  if (d.field) {
    const reads = readsOf(callers, d.field.path).map((r) => ({
      ...r,
      suggestion: d.field!.kind === 'renamed' && d.field!.to ? renameSuggestion(r.path, d.field!.path, d.field!.to) : undefined,
    }));
    if (reads.length) {
      return { ...d, risk: 'high', evidence: 'confirmed', reason: `${reads.length} read(s) of \`${d.field.path}\` in client code.`, reads };
    }
    const anyReads = callers.some((c) => (c.reads ?? []).length > 0);
    return {
      ...d,
      risk: app.length ? 'medium' : 'low',
      evidence: 'heuristic',
      reason: app.length
        ? anyReads
          ? `Callers read other fields of this response, not \`${d.field.path}\`; code that receives the data indirectly may still use it.`
          : `${app.length} caller(s) found, but how they use the response could not be traced.`
        : 'No caller found in the workspace.',
      reads: [],
    };
  }
  if (!d.breaking) return { ...d, risk: 'low', evidence: 'heuristic', reason: 'Not expected to break existing clients.', reads: [] };
  return {
    ...d,
    risk: app.length ? 'high' : callers.length ? 'medium' : 'low',
    evidence: callers.length ? 'confirmed' : 'heuristic',
    reason: app.length ? `${app.length} call(s) to ${after.method} ${after.path} in the workspace.` : callers.length ? 'Only tests call it.' : 'No caller found in the workspace; external clients may still be affected.',
    reads: [],
  };
}

/** Reads of a field or anything below it: `user.name` is affected by a change to `user`. */
function readsOf(callers: ClientCall[], field: string): AffectedRead[] {
  const out: AffectedRead[] = [];
  const seen = new Set<string>();
  for (const c of callers) {
    for (const r of c.reads ?? []) {
      if (r.path !== field && !r.path.startsWith(field + '.')) continue;
      const key = `${r.location.file}:${r.location.line}:${r.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ callId: c.id, path: r.path, location: r.location, within: r.within });
    }
  }
  return out;
}

/** For a read of `user.name` when `user.name` became `user.fullName`: replace `name` with `fullName`. */
function renameSuggestion(read: string, from: string, to: string): AffectedRead['suggestion'] {
  if (read !== from) return undefined;
  const a = from.split('.');
  const b = to.split('.');
  if (a.length !== b.length || a.slice(0, -1).join('.') !== b.slice(0, -1).join('.')) return undefined;
  return { from: a[a.length - 1], to: b[b.length - 1] };
}

function indexCalls(calls: ClientCall[]): Map<string, ClientCall[]> {
  const out = new Map<string, ClientCall[]>();
  for (const c of calls) {
    // Ambiguous calls (several best matches) are counted for each candidate.
    for (const id of c.endpointIds) out.set(id, [...(out.get(id) ?? []), c]);
  }
  return out;
}

function dedupe(calls: ClientCall[]): ClientCall[] {
  const seen = new Set<string>();
  return calls.filter((c) => !seen.has(c.id) && seen.add(c.id));
}

// ---------------------------------------------------------------------------------------------
// Reads that do not match the current response shape
// ---------------------------------------------------------------------------------------------

/**
 * `response-mismatch` issues: client code reads a field that the endpoint's response does not
 * contain. Only calls that match exactly one endpoint, and shapes that are closed along the path,
 * are considered.
 */
export function checkResponseReads(endpoints: Endpoint[], calls: ClientCall[]): AnalysisIssue[] {
  const byId = new Map(endpoints.map((e) => [e.id, e]));
  const issues: AnalysisIssue[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    if (call.endpointIds.length !== 1 || !call.reads?.length) continue;
    const e = byId.get(call.endpointIds[0]);
    const shape = e ? successShape(e) : undefined;
    if (!e || !shape) continue;
    for (const r of call.reads) {
      const found = lookup(shape, r.path);
      if (found.found !== 'absent') continue;
      const key = `${r.location.file}:${r.location.line}:${r.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(mismatch(e, call, r, found.parent, found.at));
    }
  }
  return issues;
}

function mismatch(e: Endpoint, call: ClientCall, r: ResponseRead, parent: Parameters<typeof suggestions>[0], missing: string): AnalysisIssue {
  const hints = suggestions(parent, missing);
  const responseAt = (e.responses ?? []).find((x) => x.shape && (x.status === undefined || x.status < 300))?.location ?? e.location;
  const where = `${path.basename(responseAt.file)}:${responseAt.line}`;
  const parentPath = r.path.split('.').slice(0, r.path.split('.').indexOf(missing)).join('.');
  return {
    kind: 'response-mismatch',
    severity: 'warning',
    message:
      `\`${r.path}\` is read${r.within ? ` in ${r.within}` : ''}, but ${e.method} ${e.path} responds with ${parentPath ? `\`${parentPath}\` = ` : ''}${describeShape(parent)} (${where}) without \`${missing}\`.` +
      (hints.length ? ` Did you mean ${hints.map((h) => `\`${h}\``).join(' or ')}?` : ''),
    location: r.location,
    endpointIds: [e.id],
    related: [
      { location: responseAt, message: `${e.method} ${e.path} response` },
      ...(r.indirect ? [{ location: call.location, message: `request made here (${call.client})` }] : []),
    ],
  };
}
