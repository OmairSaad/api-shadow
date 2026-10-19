import * as path from 'path';
import { normalizeForComparison } from './paths';
import type { AnalysisIssue, DuplicateGroup, Endpoint } from './types';

/**
 * Finds endpoints that would compete for the same request within one project: same method (or
 * an `ALL` route overlapping a specific method) and the same path once parameter names are
 * ignored (`/users/:id` vs `/users/:userId`). Routes are not duplicates when they differ in
 * a version selected outside the path or in request conditions, or when every match is the same
 * declaration reached twice.
 */
/**
 * Unresolved parts whose label omits the arguments (`${getPath()}`, `${(expression)}`): two of
 * them may be entirely different values, so they never make routes equal.
 */
const OPAQUE_PART = /\$\{[^}]*(\(\)|\(expression\)|\(inline function\)|\[…\])[^}]*\}/;

export function findDuplicates(endpoints: Endpoint[]): { groups: DuplicateGroup[]; issues: AnalysisIssue[] } {
  const byPath = new Map<string, Endpoint[]>();
  for (const e of endpoints) {
    if (OPAQUE_PART.test(e.path)) continue;
    const key = [e.projectRoot, e.framework, normalizeForComparison(e.path, e.framework), e.version ?? '', (e.conditions ?? []).join('&')].join('|');
    const list = byPath.get(key) ?? [];
    list.push(e);
    byPath.set(key, list);
  }
  const groups: DuplicateGroup[] = [];
  const issues: AnalysisIssue[] = [];
  for (const [key, list] of byPath) {
    if (list.length < 2) continue;
    const methods = new Set(list.map((e) => e.method));
    const specific = [...methods].filter((m) => m !== 'ALL');
    // Each specific method competes with every ALL route on the same path.
    const candidates = specific.length > 0 ? specific : (['ALL'] as const);
    for (const method of candidates) {
      const group = list.filter((e) => e.method === method || e.method === 'ALL');
      const ids = [...new Set(group.map((e) => e.id))].sort();
      if (ids.length < 2) continue;
      // One declaration reached through two paths of the analysis is not a second route.
      if (new Set(group.map((e) => `${e.location.file}:${e.location.line}:${e.location.column}`)).size < 2) continue;
      const groupKey = `${key}|${ids.join(',')}`;
      if (groups.some((g) => g.key === groupKey)) continue;
      const first = group[0];
      groups.push({ key: groupKey, method, path: first.path, endpointIds: ids });
      const where = group.map((e) => `${path.basename(e.location.file)}:${e.location.line}`).join(', ');
      issues.push({
        kind: 'duplicate',
        severity: 'warning',
        message: `Potential duplicate route ${method} ${normalizeForComparison(first.path, first.framework)} declared ${ids.length} times (${where}).`,
        location: first.location,
        endpointIds: ids,
      });
    }
  }
  return { groups, issues };
}
