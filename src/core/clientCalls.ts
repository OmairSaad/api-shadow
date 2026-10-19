import * as path from 'path';
import type { ClientCallFact } from '../analyzers/facts';
import { exprToDisplay } from './paths';
import { matchScore, parseClientUrl, parseRoute, type Segment } from './routeMatch';
import type { AnalysisIssue, ClientCall, Endpoint, SourceLocation } from './types';

export interface ClientCallInput {
  file: string;
  fact: ClientCallFact;
  kind: 'app' | 'test';
}

export interface ClientCallOptions {
  enabled: boolean;
  /** Report endpoints no app code calls, when the workspace has app calls at all. */
  reportUncalled: boolean;
}

function hashId(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const at = (file: string, p: { line: number; column: number }): SourceLocation => ({ file, line: p.line, column: p.column });

/**
 * Matches client calls to endpoints, counts usage per endpoint, and reports calls that no route
 * accepts. Only calls that clearly target this workspace's API are reported: their first fixed
 * path segment must appear in some route.
 */
export function matchClientCalls(inputs: ClientCallInput[], endpoints: Endpoint[], options: ClientCallOptions): { calls: ClientCall[]; issues: AnalysisIssue[] } {
  if (!options.enabled) {
    for (const e of endpoints) delete e.usage;
    return { calls: [], issues: [] };
  }
  const routes: { e: Endpoint; segments: Segment[] }[] = [];
  const knownSegments = new Set<string>();
  for (const e of endpoints) {
    const segments = parseRoute(e.path, e.framework);
    if (segments) routes.push({ e, segments });
    for (const s of e.path.split('/')) if (s && !s.startsWith(':') && !s.startsWith('{')) knownSegments.add(s.toLowerCase());
  }
  const usage = new Map<string, { calls: number; tests: number }>(endpoints.map((e) => [e.id, { calls: 0, tests: 0 }]));
  const calls: ClientCall[] = [];
  const issues: AnalysisIssue[] = [];
  for (const { file, fact, kind } of inputs) {
    const display = exprToDisplay(fact.url);
    const url = parseClientUrl(display, fact.unknownBase);
    const method = fact.method ?? 'ALL';
    const location = at(file, fact.pos);
    let best = -Infinity;
    let matched: Endpoint[] = [];
    let otherMethods: Endpoint[] = [];
    if (url) {
      for (const { e, segments } of routes) {
        const score = matchScore(url, segments, e.framework);
        if (score === undefined) continue;
        if (method !== 'ALL' && e.method !== 'ALL' && e.method !== method) {
          otherMethods.push(e);
          continue;
        }
        if (score > best) {
          best = score;
          matched = [e];
        } else if (score === best) matched.push(e);
      }
    }
    for (const e of matched) {
      const u = usage.get(e.id)!;
      if (kind === 'test') u.tests++;
      else u.calls++;
    }
    calls.push({
      id: hashId(`${file}|${fact.pos.line}|${fact.pos.column}`),
      kind,
      client: fact.client,
      method,
      url: display,
      location,
      range: { start: at(file, fact.start), end: at(file, fact.end) },
      endpointIds: matched.map((e) => e.id),
    });
    const firstFixed = url?.segments.find((s): s is string => s !== null);
    const targetsThisApi = !!url && !url.external && !!firstFixed && knownSegments.has(firstFixed.toLowerCase());
    if (matched.length === 0 && targetsThisApi) {
      otherMethods = [...new Set(otherMethods)];
      const hint = otherMethods.length ? ` Routes with this path exist for ${[...new Set(otherMethods.map((e) => e.method))].join(', ')}.` : '';
      issues.push({
        kind: 'broken-call',
        severity: 'warning',
        message: `No route matches ${method === 'ALL' ? '' : method + ' '}${display} (${fact.client}, ${path.basename(file)}:${fact.pos.line}).${hint}`,
        location,
        endpointIds: otherMethods.map((e) => e.id),
      });
    }
  }
  for (const e of endpoints) e.usage = usage.get(e.id);
  // Never-called endpoints are only meaningful when the workspace contains a client for them.
  if (options.reportUncalled) {
    const calledProjects = new Set(endpoints.filter((e) => (e.usage?.calls ?? 0) > 0).map((e) => e.projectRoot));
    for (const e of endpoints) {
      if (!calledProjects.has(e.projectRoot) || (e.usage?.calls ?? 0) > 0) continue;
      issues.push({ kind: 'uncalled', severity: 'info', message: `${e.method} ${e.path} is not called from any code in the workspace.`, location: e.location, endpointIds: [e.id] });
    }
  }
  return { calls, issues };
}
