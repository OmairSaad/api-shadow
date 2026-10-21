/**
 * Operations on inferred response shapes: the success shape of an endpoint, looking up a field
 * path, flattening, diffing two shapes (with rename detection) and a compact display form.
 *
 * Absence is only claimed when every object on the way is *closed* (built from a literal or a
 * declared type, with no spreads). Anything else is `unknown`, never `absent`.
 */
import type { Endpoint, Shape, ShapeProp } from './types';

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export type Lookup = { found: 'present'; shape: Shape } | { found: 'absent'; parent: Shape & { t: 'object' }; at: string } | { found: 'unknown' };

/** Merged shape of an endpoint's success responses (2xx or default status), if any is known. */
export function successShape(e: Endpoint): Shape | undefined {
  const ok = (e.responses ?? []).filter((r) => r.shape && (r.status === undefined || (r.status >= 200 && r.status < 300)) && r.via !== 'throw' && r.via !== 'status');
  if (ok.length === 0) return undefined;
  // A declared type describes the contract; literals in the handler refine opaque returns only.
  const typed = ok.find((r) => r.via === 'type' && r.shape && r.shape.t !== 'unknown');
  if (typed) return typed.shape;
  let shape: Shape | undefined;
  for (const r of ok) shape = shape ? merge(shape, r.shape!) : r.shape;
  return shape?.t === 'unknown' ? undefined : shape;
}

/** Status codes an endpoint is seen to respond with, defaults included. */
export function statusCodes(e: Endpoint): number[] {
  const out = new Set<number>();
  for (const r of e.responses ?? []) {
    if (r.status !== undefined) out.add(r.status);
    else if (r.via !== 'throw') out.add(e.framework === 'nestjs' && e.method === 'POST' ? 201 : 200);
  }
  return [...out].sort((a, b) => a - b);
}

/** Looks up `user.name` or `items.[].title` in a shape. */
export function lookup(shape: Shape, path: string): Lookup {
  let current: Shape = shape;
  for (const seg of path.split('.')) {
    if (seg === '[]') {
      if (current.t !== 'array' || !current.items) return { found: 'unknown' };
      current = current.items;
      continue;
    }
    if (current.t === 'array') {
      // `items.length`-like reads on arrays, or a numeric index already normalised to `[]`.
      return { found: 'unknown' };
    }
    if (current.t !== 'object') return { found: 'unknown' };
    if (!own(current.props, seg)) {
      return current.open ? { found: 'unknown' } : { found: 'absent', parent: current, at: seg };
    }
    current = current.props[seg].shape;
  }
  return { found: 'present', shape: current };
}

export interface FlatField {
  path: string;
  shape: Shape;
  prop: ShapeProp;
  /** The object holding this field may have unlisted properties. */
  parentOpen: boolean;
}

/** All field paths of a shape: `user`, `user.id`, `items.[].title`. */
export function flatten(shape: Shape, prefix = '', out = new Map<string, FlatField>(), depth = 0): Map<string, FlatField> {
  if (depth > 8) return out;
  if (shape.t === 'object') {
    for (const [k, prop] of Object.entries(shape.props)) {
      const path = prefix ? `${prefix}.${k}` : k;
      out.set(path, { path, shape: prop.shape, prop, parentOpen: !!shape.open });
      flatten(prop.shape, path, out, depth + 1);
    }
  } else if (shape.t === 'array' && shape.items) {
    flatten(shape.items, prefix ? `${prefix}.[]` : '[]', out, depth + 1);
  }
  return out;
}

export type ShapeChange =
  | { kind: 'removed'; path: string; was: Shape }
  | { kind: 'renamed'; path: string; to: string; evidence: string }
  | { kind: 'type'; path: string; from: string; to: string }
  | { kind: 'added'; path: string; now: Shape }
  | { kind: 'optional'; path: string };

/**
 * Differences between two response shapes. A field that disappears from a closed object while a
 * sibling appears with the same value expression (`name: user.name` → `fullName: user.name`) or a
 * closely related name is reported as renamed.
 */
export function diffShapes(before: Shape, after: Shape): ShapeChange[] {
  const a = flatten(before);
  const b = flatten(after);
  const changes: ShapeChange[] = [];
  const removed: FlatField[] = [];
  for (const [path, fa] of a) {
    const fb = b.get(path);
    if (!fb) {
      // Only claim removal when the new parent is closed and the old field's parent still exists.
      const r = lookup(after, path);
      if (r.found === 'absent' && r.at === path.split('.').pop()) removed.push(fa);
      continue;
    }
    const ta = typeName(fa.shape);
    const tb = typeName(fb.shape);
    if (ta && tb && ta !== tb && !(ta === 'null' || tb === 'null')) changes.push({ kind: 'type', path, from: ta, to: tb });
    if (!fa.prop.optional && fb.prop.optional) changes.push({ kind: 'optional', path });
  }
  const added = [...b.values()].filter((f) => !a.has(f.path));
  const taken = new Set<string>();
  for (const r of removed) {
    // Skip children of a field already reported.
    if (removed.some((o) => o !== r && r.path.startsWith(o.path + '.'))) continue;
    const parent = r.path.includes('.') ? r.path.slice(0, r.path.lastIndexOf('.')) : '';
    const siblings = added.filter((f) => (f.path.includes('.') ? f.path.slice(0, f.path.lastIndexOf('.')) : '') === parent && !taken.has(f.path));
    const name = r.path.split('.').pop()!;
    const bySource = r.prop.src ? siblings.find((f) => f.prop.src === r.prop.src) : undefined;
    const byName = bySource ?? siblings.find((f) => similarNames(name, f.path.split('.').pop()!));
    if (byName) {
      taken.add(byName.path);
      changes.push({ kind: 'renamed', path: r.path, to: byName.path, evidence: bySource ? `both take their value from ${r.prop.src}` : 'similar name in the same object' });
    } else {
      changes.push({ kind: 'removed', path: r.path, was: r.shape });
    }
  }
  for (const f of added) {
    if (taken.has(f.path) || added.some((o) => o !== f && f.path.startsWith(o.path + '.'))) continue;
    changes.push({ kind: 'added', path: f.path, now: f.shape });
  }
  const order: Record<ShapeChange['kind'], number> = { removed: 0, renamed: 1, type: 2, optional: 3, added: 4 };
  return changes.sort((x, y) => order[x.kind] - order[y.kind] || x.path.localeCompare(y.path));
}

/** `name`/`fullName`, `userId`/`user_id`, `createdAt`/`created`: one contains the other or they share a word. */
export function similarNames(a: string, b: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/[_-]/g, '');
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  if (x.length >= 3 && y.length >= 3 && (x.includes(y) || y.includes(x))) return true;
  const words = (s: string): string[] => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_-]+/).filter((w) => w.length >= 3);
  const wa = words(a);
  return words(b).some((w) => wa.includes(w));
}

/** Closest field names in an object to a missing one, for "did you mean" hints. */
export function suggestions(parent: Shape & { t: 'object' }, missing: string): string[] {
  return Object.keys(parent.props).filter((k) => similarNames(missing, k)).slice(0, 3);
}

export function typeName(s: Shape): string | undefined {
  if (s.t === 'unknown') return undefined;
  if (s.t === 'array') return 'array';
  return s.t;
}

/** Compact display: `{ user: { id, fullName, tags: [] } }`. */
export function describeShape(s: Shape | undefined, depth = 0): string {
  if (!s) return 'unknown';
  switch (s.t) {
    case 'object': {
      const keys = Object.keys(s.props);
      if (depth > 3) return keys.length ? '{ … }' : '{}';
      const shown = keys.slice(0, 8).map((k) => {
        const p = s.props[k];
        const inner = p.shape.t === 'object' || p.shape.t === 'array' ? `: ${describeShape(p.shape, depth + 1)}` : '';
        return `${k}${p.optional ? '?' : ''}${inner}`;
      });
      if (keys.length > 8) shown.push(`…${keys.length - 8} more`);
      if (s.open) shown.push('…');
      return `{ ${shown.join(', ')} }`.replace('{  }', '{}');
    }
    case 'array':
      return s.items ? `${describeShape(s.items, depth + 1)}[]` : '[]';
    case 'unknown':
      return s.expr ? `(${s.expr})` : 'unknown';
    default:
      return s.t;
  }
}

function merge(a: Shape, b: Shape): Shape {
  if (a.t === 'unknown') return b;
  if (b.t === 'unknown') return a;
  if (a.t === 'object' && b.t === 'object') {
    const props: Record<string, ShapeProp> = Object.create(null) as Record<string, ShapeProp>;
    for (const k of new Set([...Object.keys(a.props), ...Object.keys(b.props)])) {
      const x = own(a.props, k) ? a.props[k] : undefined;
      const y = own(b.props, k) ? b.props[k] : undefined;
      props[k] = x && y ? { ...x, shape: merge(x.shape, y.shape), optional: x.optional || y.optional || undefined } : { ...(x ?? y)!, optional: true };
    }
    const out: Shape = { t: 'object', props };
    if (a.open || b.open) out.open = true;
    return out;
  }
  if (a.t === 'array' && b.t === 'array') return { t: 'array', items: a.items && b.items ? merge(a.items, b.items) : (a.items ?? b.items) };
  return a.t === b.t ? a : { t: 'unknown' };
}
