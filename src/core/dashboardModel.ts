/**
 * The data the dashboard webview renders. Plain JSON: every value is shown with `textContent`
 * in the webview. Source locations are replaced by indexes into `refs`, which only the extension
 * host can resolve, so the webview never handles file paths it could ask to open.
 */
import { buildGraph, type ApiGraph, type GraphNode } from './graph';
import type { ImpactReport } from './impact';
import { SECURITY_RULES, type SecurityFinding } from './security';
import { describeShape, statusCodes, successShape } from './shapes';
import { summarize, type AnalysisSummary } from './summary';
import type { AnalysisResult, SourceLocation } from './types';

export interface DashboardInput {
  result: AnalysisResult | undefined;
  analyzing: boolean;
  impact: { status: 'off' | 'computing' | 'ready' | 'unavailable'; report?: ImpactReport; baseLabel?: string; reason?: string; note?: string };
  dismissed: ReadonlySet<string>;
  disabledRules: readonly string[];
  graphMaxEndpoints: number;
  /** Search results to focus the graph on. */
  graphFocus?: { query: string; ids: ReadonlySet<string> };
  contracts: { files: string[]; last?: ContractView };
  testProjects: { root: string; label: string; kind: 'node' | 'java'; runner: string }[];
  relativePath: (file: string) => string;
  workspace: string;
}

export interface ContractView {
  title: string;
  beforeLabel: string;
  afterLabel: string;
  bestEffort: boolean;
  counts: Record<string, number>;
  changes: { severity: string; operation: string; area: string; text: string }[];
  file?: string;
}

export interface RefTable {
  refs: SourceLocation[];
  ref(l: SourceLocation | undefined): number | undefined;
}

export function refTable(): RefTable {
  const refs: SourceLocation[] = [];
  const index = new Map<string, number>();
  return {
    refs,
    ref(l) {
      if (!l) return undefined;
      const key = `${l.file}:${l.line}:${l.column}`;
      let i = index.get(key);
      if (i === undefined) {
        i = refs.length;
        refs.push(l);
        index.set(key, i);
      }
      return i;
    },
  };
}

export interface DashboardModel {
  workspace: string;
  generatedAt: string;
  analyzing: boolean;
  ready: boolean;
  summary?: AnalysisSummary;
  endpoints: unknown[];
  calls: unknown[];
  issues: unknown[];
  impact: unknown;
  security: unknown[];
  rules: { id: string; title: string; description: string; mitigation: string; disabled: boolean }[];
  graph?: (Omit<ApiGraph, 'nodes'> & { nodes: (Omit<GraphNode, 'location'> & { ref?: number })[]; focus?: string });
  contracts: { files: { path: string; index: number }[]; last?: ContractView };
  testProjects: DashboardInput['testProjects'];
}

export function buildDashboardModel(input: DashboardInput, table: RefTable): DashboardModel {
  const rel = input.relativePath;
  const at = (l: SourceLocation | undefined): string | undefined => (l ? `${rel(l.file)}:${l.line}` : undefined);
  const r = input.result;
  const report = input.impact.report;
  const impactedEndpoint = new Map<string, string>();
  for (const e of report?.endpoints ?? []) {
    if (e.after) impactedEndpoint.set(e.after.id, e.risk);
  }
  const securityCount = new Map<string, number>();
  for (const f of r?.security ?? []) if (f.endpointId && !input.dismissed.has(f.id)) securityCount.set(f.endpointId, (securityCount.get(f.endpointId) ?? 0) + 1);

  const endpoints = (r?.endpoints ?? []).map((e) => ({
    id: e.id,
    method: e.method,
    path: e.path,
    framework: e.framework,
    controller: e.controller,
    handler: e.handler,
    where: at(e.location),
    ref: table.ref(e.location),
    handlerRef: e.handlerLocation ? table.ref(e.handlerLocation) : undefined,
    auth: e.auth?.status ?? 'none',
    authVia: e.auth?.via ?? [],
    validation: e.validation?.status,
    confidence: e.confidence ?? 'high',
    callers: e.usage?.calls ?? 0,
    tests: e.usage?.tests ?? 0,
    response: successShape(e) ? describeShape(successShape(e)) : undefined,
    statuses: statusCodes(e),
    params: e.parameters,
    body: e.requestBodyType,
    middleware: e.middleware,
    services: e.services.map((s) => ({ name: s.name, ref: table.ref(s.location), uses: (s.uses ?? []).map((u) => u.name) })),
    dataAccess: e.dataAccess ?? [],
    security: securityCount.get(e.id) ?? 0,
    impacted: impactedEndpoint.get(e.id),
    notes: e.notes,
    version: e.version,
  }));

  const calls = (r?.clientCalls ?? []).map((c) => ({
    id: c.id,
    kind: c.kind,
    client: c.client,
    method: c.method,
    url: c.url,
    where: at(c.location),
    ref: table.ref(c.location),
    within: c.within,
    endpointIds: c.endpointIds,
    reads: [...new Set((c.reads ?? []).map((x) => x.path))].slice(0, 40),
    consumers: (c.consumers ?? []).map((x) => ({ within: x.within, callee: x.callee, where: at(x.location), ref: table.ref(x.location) })),
  }));

  const coverageKinds = new Set(['broken-call', 'response-mismatch', 'duplicate', 'unreachable', 'uncalled', 'limitation', 'parse-error', 'skipped', 'no-validation', 'no-auth']);
  const issues = (r?.issues ?? [])
    .filter((i) => coverageKinds.has(i.kind))
    .map((i) => ({ kind: i.kind, severity: i.severity, message: i.message, where: at(i.location), ref: table.ref(i.location), endpointIds: i.endpointIds ?? [] }));

  const impact = {
    status: input.impact.status,
    baseLabel: report?.baseLabel ?? input.impact.baseLabel,
    reason: input.impact.reason,
    note: input.impact.note,
    summary: report?.summary,
    added: report?.added.length ?? 0,
    endpoints: (report?.endpoints ?? []).map((e) => ({
      key: e.key,
      method: e.method,
      path: e.path,
      status: e.status,
      risk: e.risk,
      endpointId: e.after?.id,
      ref: table.ref((e.after ?? e.before).location),
      before: e.status === 'moved' ? `${e.before.method} ${e.before.path}` : undefined,
      changes: e.changes.map((c) => ({
        text: c.text,
        breaking: c.breaking,
        risk: c.risk,
        evidence: c.evidence,
        reason: c.reason,
        reads: c.reads.map((x) => ({ path: x.path, within: x.within, where: at(x.location), ref: table.ref(x.location), suggestion: x.suggestion })),
      })),
      callers: e.callers.map((c) => ({ kind: c.kind, client: c.client, within: c.within, where: at(c.location), ref: table.ref(c.location), consumers: c.consumers.map((x) => ({ within: x.within, where: at(x.location), ref: table.ref(x.location) })) })),
    })),
  };

  const security = (r?.security ?? []).map((f: SecurityFinding) => ({
    id: f.id,
    rule: f.rule,
    title: f.title,
    severity: f.severity,
    confidence: f.confidence,
    message: f.message,
    evidence: f.evidence,
    mitigation: f.mitigation,
    endpoint: f.endpoint,
    endpointId: f.endpointId,
    where: at(f.location),
    ref: table.ref(f.location),
    dismissed: input.dismissed.has(f.id),
  }));

  let graph: DashboardModel['graph'];
  if (r) {
    const g = buildGraph(r, { maxEndpoints: input.graphMaxEndpoints, focus: input.graphFocus?.ids, impact: report, relativePath: rel });
    // Node ids contain file paths; the webview gets stable hashes instead.
    const ids = new Map(g.nodes.map((n) => [n.id, `${n.kind}-${hash(n.id)}`]));
    graph = {
      endpoints: g.endpoints,
      edges: g.edges.map((e) => ({ ...e, from: ids.get(e.from) ?? e.from, to: ids.get(e.to) ?? e.to })),
      nodes: g.nodes.map(({ location, ...n }) => ({ ...n, id: ids.get(n.id)!, ref: table.ref(location) })),
      focus: input.graphFocus?.query,
    };
  }

  return {
    workspace: input.workspace,
    generatedAt: new Date().toISOString(),
    analyzing: input.analyzing,
    ready: !!r,
    summary: r ? summarize(r, report) : undefined,
    endpoints,
    calls,
    issues,
    impact,
    security,
    rules: Object.values(SECURITY_RULES).map((rule) => ({ ...rule, disabled: input.disabledRules.includes(rule.id) })),
    graph,
    contracts: { ...input.contracts, files: input.contracts.files.map((path, index) => ({ path, index })) },
    testProjects: input.testProjects,
  };
}

function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
