/** Counts shown in the dashboard overview and the analysis report. */
import type { ImpactReport } from './impact';
import type { Severity } from './security';
import type { AnalysisResult, Confidence, Framework, HttpMethod } from './types';

export interface AnalysisSummary {
  endpoints: number;
  byMethod: Partial<Record<HttpMethod, number>>;
  byFramework: Partial<Record<Framework, number>>;
  confidence: Record<Confidence, number>;
  calls: { total: number; app: number; test: number; matched: number; unmatched: number; ambiguous: number };
  /** Endpoints no app code calls, in projects whose endpoints are called from somewhere. */
  potentiallyUnused: number;
  /** Endpoints no app code calls at all (no frontend in the workspace for that project). */
  withoutCallers: number;
  brokenCalls: number;
  responseMismatches: number;
  duplicates: number;
  unreachable: number;
  security: Record<Severity, number>;
  impact?: { high: number; medium: number; low: number; baseLabel: string };
}

export function summarize(result: AnalysisResult, impact?: ImpactReport): AnalysisSummary {
  const byMethod: Partial<Record<HttpMethod, number>> = {};
  const byFramework: Partial<Record<Framework, number>> = {};
  const confidence: Record<Confidence, number> = { high: 0, medium: 0, low: 0 };
  for (const e of result.endpoints) {
    byMethod[e.method] = (byMethod[e.method] ?? 0) + 1;
    byFramework[e.framework] = (byFramework[e.framework] ?? 0) + 1;
    confidence[e.confidence ?? 'high']++;
  }
  const app = result.clientCalls.filter((c) => c.kind === 'app');
  const calledProjects = new Set(result.endpoints.filter((e) => (e.usage?.calls ?? 0) > 0).map((e) => e.projectRoot));
  const security: Record<Severity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of result.security) security[f.severity]++;
  const count = (kind: string): number => result.issues.filter((i) => i.kind === kind).length;
  return {
    endpoints: result.endpoints.length,
    byMethod,
    byFramework,
    confidence,
    calls: {
      total: result.clientCalls.length,
      app: app.length,
      test: result.clientCalls.length - app.length,
      matched: app.filter((c) => c.endpointIds.length > 0).length,
      unmatched: app.filter((c) => c.endpointIds.length === 0).length,
      ambiguous: app.filter((c) => c.endpointIds.length > 1).length,
    },
    potentiallyUnused: result.endpoints.filter((e) => calledProjects.has(e.projectRoot) && (e.usage?.calls ?? 0) === 0).length,
    withoutCallers: result.endpoints.filter((e) => (e.usage?.calls ?? 0) === 0).length,
    brokenCalls: count('broken-call'),
    responseMismatches: count('response-mismatch'),
    duplicates: result.duplicates.length,
    unreachable: count('unreachable'),
    security,
    impact: impact ? { ...impact.summary, baseLabel: impact.baseLabel } : undefined,
  };
}
