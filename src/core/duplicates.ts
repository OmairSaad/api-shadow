import * as path from 'path';
import { normalizeForComparison } from './paths';
import type { Registration } from './shadowing';
import type { AnalysisIssue, DuplicateGroup, Endpoint } from './types';

/**
 * Finds endpoints that would compete for the same request within one project: same method and
 * the same path once parameter names are ignored (`/users/:id` vs `/users/:userId`). Routes are
 * not duplicates when they differ in a version selected outside the path or in request
 * conditions, when every match is the same declaration reached twice, or when all but one of them
 * hand the request on with `next()`. Paths of routers whose mount point was not found are only
 * compared within that router. An `ALL` route is only compared with other `ALL` routes: one that
 * catches a later route's requests is reported as unreachable instead, and one registered after
 * (a 405 fallback, `router.all('*', auth)` calling `next()`) does not compete.
 */
/**
 * Unresolved parts whose label omits the arguments (`${getPath()}`, `${(expression)}`): two of
 * them may be entirely different values, so they never make routes equal.
 */
const OPAQUE_PART = /\$\{[^}]*(\(\)|\(expression\)|\(inline function\)|\[…\])[^}]*\}/;

export function findDuplicates(endpoints: Endpoint[], registrations?: ReadonlyMap<string, Registration>): { groups: DuplicateGroup[]; issues: AnalysisIssue[] } {
  const byRoute = new Map<string, Endpoint[]>();
  for (const e of endpoints) {
    if (OPAQUE_PART.test(e.path)) continue;
    const key = [e.projectRoot, e.framework, e.relativeTo ?? '', e.method, normalizeForComparison(e.path, e.framework), e.version ?? '', (e.conditions ?? []).join('&')].join('|');
    const list = byRoute.get(key) ?? [];
    list.push(e);
    byRoute.set(key, list);
  }
  const groups: DuplicateGroup[] = [];
  const issues: AnalysisIssue[] = [];
  for (const [key, group] of byRoute) {
    // One declaration reached through two paths of the analysis is not a second route.
    const answering = new Set(group.filter((e) => !registrations?.get(e.id)?.forwards).map((e) => `${e.location.file}:${e.location.line}:${e.location.column}`));
    if (answering.size < 2) continue;
    if (new Set(group.map((e) => `${e.location.file}:${e.location.line}:${e.location.column}`)).size < 2) continue;
    const ids = [...new Set(group.map((e) => e.id))].sort();
    const first = group[0];
    groups.push({ key: `${key}|${ids.join(',')}`, method: first.method, path: first.path, endpointIds: ids });
    const where = group.map((e) => `${path.basename(e.location.file)}:${e.location.line}`).join(', ');
    issues.push({
      kind: 'duplicate',
      severity: 'warning',
      message: `Potential duplicate route ${first.method} ${normalizeForComparison(first.path, first.framework)} declared ${ids.length} times (${where}).`,
      location: first.location,
      endpointIds: ids,
    });
  }
  return { groups, issues };
}
