import * as path from 'path';
import { normalizeForComparison } from './paths';
import { parseRoute, shadows } from './routeMatch';
import type { AnalysisIssue, Endpoint } from './types';

/**
 * Where an endpoint was registered, from the root app down: one entry per router it passes
 * through. `order` is the position of the registration (route or mount) within `scope`, a router
 * in one file. Recorded by the linkers.
 */
export interface Registration {
  chain: { scope: string; order: number }[];
  /** The handler may call `next()`, so later routes can still be reached. */
  passThrough: boolean;
  /** The handler calls `next()`, so it hands requests on rather than answering them. */
  forwards?: boolean;
}

/** Frameworks that try routes in registration order and stop at the first match. */
const ORDERED = new Set(['express', 'koa', 'nestjs', 'laravel']);

/**
 * Reports routes that can never run because a route registered earlier on the same router
 * accepts every request they would get: `GET /users/:id` declared before `GET /users/me`.
 */
export function findUnreachable(endpoints: Endpoint[], registrations: ReadonlyMap<string, Registration>): AnalysisIssue[] {
  const groups = new Map<string, Endpoint[]>();
  for (const e of endpoints) {
    if (!ORDERED.has(e.framework) || !registrations.has(e.id)) continue;
    const key = `${e.projectRoot}|${e.framework}`;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  const issues: AnalysisIssue[] = [];
  for (const list of groups.values()) {
    const parsed = new Map(list.map((e) => [e.id, parseRoute(e.path, e.framework)]));
    for (const later of list) {
      const b = parsed.get(later.id);
      if (!b) continue;
      const rb = registrations.get(later.id)!;
      const blocker = list.find((earlier) => {
        if (earlier === later || (earlier.method !== later.method && earlier.method !== 'ALL')) return false;
        const ra = registrations.get(earlier.id)!;
        if (ra.passThrough || !registeredBefore(ra, rb)) return false;
        const a = parsed.get(earlier.id);
        if (!a) return false;
        // Identical routes of one method are duplicates; an identical ALL route is reported here.
        const sameAll = earlier.method === 'ALL' && later.method !== 'ALL' && normalizeForComparison(earlier.path, earlier.framework) === normalizeForComparison(later.path, later.framework);
        return sameAll || shadows(a, b, later.framework);
      });
      if (!blocker) continue;
      const where = `${path.basename(blocker.location.file)}:${blocker.location.line}`;
      issues.push({
        kind: 'unreachable',
        severity: 'warning',
        message: `${later.method} ${later.path} is unreachable: ${blocker.method} ${blocker.path} (${where}) is registered first and matches every request it would get. Declare it before that route.`,
        location: later.location,
        endpointIds: [later.id, blocker.id],
        related: [{ location: blocker.location, message: `${blocker.method} ${blocker.path} catches these requests first` }],
      });
    }
  }
  return issues;
}

/** True when `a` was registered before `b` on a router they share. */
function registeredBefore(a: Registration, b: Registration): boolean {
  for (let i = 0; i < Math.min(a.chain.length, b.chain.length); i++) {
    const x = a.chain[i];
    const y = b.chain[i];
    if (x.scope !== y.scope) return false;
    if (x.order !== y.order) return x.order < y.order;
  }
  return false;
}
