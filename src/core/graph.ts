/**
 * The API dependency graph, from analysis results:
 *
 *   component → API function → request → endpoint → handler → service → repository/model
 *                                tests ↗
 *
 * Built from real results only: components are the functions that receive a response through a
 * service function (`ClientCall.consumers`), API functions are the functions making the request
 * (`ClientCall.within`), services come from handler calls and repositories from the data access
 * of service methods. Each node knows its source location.
 */
import * as path from 'path';
import type { ImpactReport } from './impact';
import type { AnalysisResult, Endpoint, HttpMethod, SourceLocation } from './types';

export type GraphNodeKind = 'component' | 'client' | 'request' | 'test' | 'endpoint' | 'handler' | 'service' | 'data';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  detail?: string;
  location?: SourceLocation;
  method?: HttpMethod;
  framework?: string;
  endpointId?: string;
  /** A request that matches no endpoint. */
  unmatched?: boolean;
  /** A request that matches several endpoints equally well. */
  ambiguous?: boolean;
  /** An endpoint nothing in the workspace calls (it may still have external clients). */
  uncalled?: boolean;
  /** Affected by the current impact report. */
  impacted?: 'high' | 'medium' | 'low';
  /** Number of security findings on an endpoint. */
  security?: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: 'consumes' | 'calls' | 'matches' | 'ambiguous' | 'handles' | 'uses' | 'stores' | 'tests';
}

export interface ApiGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Endpoints in the graph / in the analysis. */
  endpoints: { shown: number; total: number };
}

export interface GraphOptions {
  /** Keep at most this many endpoints (most connected first). */
  maxEndpoints?: number;
  /** Only these endpoints (and their neighbourhood), e.g. search results. */
  focus?: ReadonlySet<string>;
  impact?: ImpactReport;
  /** Shortens file paths in node details; defaults to the base name. */
  relativePath?: (file: string) => string;
}

export function buildGraph(result: AnalysisResult, options: GraphOptions = {}): ApiGraph {
  const rel = options.relativePath ?? ((f: string): string => path.basename(f));
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const node = (n: GraphNode): GraphNode => {
    const existing = nodes.get(n.id);
    if (existing) return existing;
    nodes.set(n.id, n);
    return n;
  };
  const edge = (from: string, to: string, kind: GraphEdge['kind']): void => {
    const key = `${from}>${to}`;
    if (from === to || edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, kind });
  };

  const callsTo = new Map<string, number>();
  for (const c of result.clientCalls) for (const id of c.endpointIds) callsTo.set(id, (callsTo.get(id) ?? 0) + 1);
  const securityCount = new Map<string, number>();
  for (const f of result.security) if (f.endpointId) securityCount.set(f.endpointId, (securityCount.get(f.endpointId) ?? 0) + 1);
  const impacted = new Map<string, 'high' | 'medium' | 'low'>();
  const impactedCalls = new Map<string, 'high' | 'medium' | 'low'>();
  for (const e of options.impact?.endpoints ?? []) {
    if (e.after) impacted.set(e.after.id, e.risk);
    impacted.set(e.before.id, e.risk);
    for (const c of e.callers) impactedCalls.set(c.callId, e.risk);
  }

  // Choose endpoints: focus, else the most connected up to the limit.
  let endpoints = result.endpoints;
  if (options.focus) endpoints = endpoints.filter((e) => options.focus!.has(e.id));
  const limit = options.maxEndpoints ?? Infinity;
  if (endpoints.length > limit) {
    endpoints = [...endpoints].sort((a, b) => (callsTo.get(b.id) ?? 0) - (callsTo.get(a.id) ?? 0) || (impacted.has(b.id) ? 1 : 0) - (impacted.has(a.id) ? 1 : 0)).slice(0, limit);
  }
  const shown = new Set(endpoints.map((e) => e.id));

  for (const e of endpoints) endpointChain(e);
  for (const call of result.clientCalls) {
    const targets = call.endpointIds.filter((id) => shown.has(id));
    // Unmatched calls are shown unless the graph is focused on particular endpoints.
    if (targets.length === 0 && (call.endpointIds.length > 0 || options.focus)) continue;
    const requestId = `request:${call.id}`;
    node({
      id: requestId,
      kind: call.kind === 'test' ? 'test' : 'request',
      label: `${call.method === 'ALL' ? '' : call.method + ' '}${call.url}`,
      detail: `${call.client} · ${rel(call.location.file)}:${call.location.line}`,
      location: call.location,
      method: call.method === 'ALL' ? undefined : call.method,
      unmatched: call.endpointIds.length === 0 || undefined,
      ambiguous: call.endpointIds.length > 1 || undefined,
      impacted: impactedCalls.get(call.id),
    });
    for (const id of targets) edge(requestId, `endpoint:${id}`, call.kind === 'test' ? 'tests' : call.endpointIds.length > 1 ? 'ambiguous' : 'matches');
    if (call.kind === 'test') continue;
    const fileBase = path.basename(call.location.file).replace(/\.[^.]+$/, '');
    const clientId = `client:${call.location.file}:${call.within ?? fileBase}`;
    node({ id: clientId, kind: 'client', label: call.within ?? fileBase, detail: rel(call.location.file), location: call.location });
    edge(clientId, requestId, 'calls');
    for (const c of call.consumers ?? []) {
      const compId = `component:${c.location.file}:${c.within ?? path.basename(c.location.file)}`;
      node({ id: compId, kind: 'component', label: c.within ?? path.basename(c.location.file).replace(/\.[^.]+$/, ''), detail: `${rel(c.location.file)} · calls ${c.callee}`, location: c.location, impacted: impactedCalls.get(call.id) });
      edge(compId, clientId, 'consumes');
    }
  }
  return { nodes: [...nodes.values()], edges, endpoints: { shown: endpoints.length, total: result.endpoints.length } };

  function endpointChain(e: Endpoint): void {
    const id = `endpoint:${e.id}`;
    node({
      id,
      kind: 'endpoint',
      label: `${e.method} ${e.path}`,
      detail: `${e.framework} · ${rel(e.location.file)}:${e.location.line}`,
      location: e.location,
      method: e.method,
      framework: e.framework,
      endpointId: e.id,
      uncalled: (callsTo.get(e.id) ?? 0) === 0 || undefined,
      impacted: impacted.get(e.id),
      security: securityCount.get(e.id),
    });
    const where = e.handlerLocation ?? e.location;
    const handlerName = e.handler && e.handler !== '(anonymous)' ? (e.controller && !e.handler.includes('.') ? `${e.controller}.${e.handler}` : e.handler) : `${path.basename(where.file)}:${where.line}`;
    const handlerId = `handler:${where.file}:${where.line}:${handlerName}`;
    node({ id: handlerId, kind: 'handler', label: handlerName, detail: `${rel(where.file)}:${where.line}`, location: where });
    edge(id, handlerId, 'handles');
    for (const s of e.services) {
      const serviceId = `service:${s.name}`;
      node({ id: serviceId, kind: 'service', label: s.name, detail: s.location ? `${rel(s.location.file)}:${s.location.line}` : 'not found in workspace', location: s.location });
      edge(handlerId, serviceId, 'uses');
      for (const d of s.uses ?? []) {
        const dataId = `data:${d.name.split('.')[0]}`;
        node({ id: dataId, kind: 'data', label: d.name.split('.')[0], detail: d.location ? rel(d.location.file) : 'repository / model', location: d.location });
        edge(serviceId, dataId, 'stores');
      }
    }
    for (const d of e.dataAccess ?? []) {
      const model = d.split('.').slice(0, -1).join('.') || d;
      const dataId = `data:${model}`;
      node({ id: dataId, kind: 'data', label: model, detail: 'data access in handler' });
      edge(handlerId, dataId, 'stores');
    }
  }
}

/** Mermaid flowchart of a graph, for sharing in Markdown. */
export function graphToMermaid(graph: ApiGraph): string {
  const ids = new Map<string, string>();
  graph.nodes.forEach((n, i) => ids.set(n.id, `n${i}`));
  const shape: Record<GraphNodeKind, [string, string]> = {
    component: ['([', '])'],
    client: ['[/', '/]'],
    request: ['>', ']'],
    test: ['>', ']'],
    endpoint: ['[', ']'],
    handler: ['(', ')'],
    service: ['[[', ']]'],
    data: ['[(', ')]'],
  };
  const label = (s: string): string => s.replace(/"/g, "'").replace(/[<>]/g, '');
  const lines = ['flowchart LR'];
  for (const n of graph.nodes) {
    const [open, close] = shape[n.kind];
    lines.push(`  ${ids.get(n.id)}${open}"${label(n.label)}"${close}`);
  }
  for (const e of graph.edges) {
    const a = ids.get(e.from);
    const b = ids.get(e.to);
    if (a && b) lines.push(`  ${a} ${e.kind === 'ambiguous' ? '-.->' : '-->'} ${b}`);
  }
  for (const n of graph.nodes) if (n.unmatched) lines.push(`  style ${ids.get(n.id)} stroke-dasharray: 4 4`);
  return lines.join('\n');
}
