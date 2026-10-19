/**
 * Resolves path parts that reference imported constants (`router.get(ROUTES.SHOPIFY)`,
 * `` `${BASE}/orders` ``) to the string they hold in the exporting file. Follows named, default,
 * namespace and CommonJS imports, `export { X } from` and `export *` re-exports. A reference that
 * can't be resolved becomes a `dynamic` part, exactly as if it had never been recorded.
 */
import type { FileFacts, JsFileFacts } from '../analyzers/facts';
import { compactExpr } from '../core/paths';
import type { PathExpr, PathPart } from '../core/types';
import { resolveModule } from './context';
import { own } from '../core/records';

const MAX_DEPTH = 8;

export type FactsLookup = (file: string) => FileFacts | undefined;

function hasRefs(expr: PathExpr): boolean {
  return expr.parts.some((p) => 'ref' in p);
}

/** Facts with every reference in route, mount and prefix paths resolved (or made dynamic). */
export function resolveJsFacts(file: string, facts: JsFileFacts, lookup: FactsLookup, allFiles: ReadonlySet<string>): JsFileFacts {
  const all = [
    ...facts.routes.flatMap((r) => r.paths),
    ...facts.mounts.flatMap((m) => m.paths),
    ...facts.nestControllers.flatMap((c) => [...c.paths, ...c.methods.flatMap((m) => m.paths)]),
    ...(facts.nestGlobalPrefix ? [facts.nestGlobalPrefix.prefix] : []),
  ];
  if (!all.some(hasRefs) && !facts.mounts.some((m) => m.maybePath)) return facts;
  const resolver = new Resolver(lookup, allFiles);
  const r = (expr: PathExpr): PathExpr => (hasRefs(expr) ? resolver.expr(file, facts, expr, 0) : expr);
  return {
    ...facts,
    routes: facts.routes.map((route) => ({ ...route, paths: route.paths.map(r) })),
    mounts: facts.mounts.map((mount) => {
      if (!mount.maybePath) return { ...mount, paths: mount.paths.map(r) };
      const resolved = resolver.expr(file, facts, mount.maybePath, 0);
      // Resolved to a string: it was the mount path, not middleware.
      return resolved.parts.every((p) => !('dynamic' in p)) ? { ...mount, maybePath: undefined, paths: [resolved], args: mount.args.slice(1) } : { ...mount, maybePath: undefined, paths: mount.paths.map(r) };
    }),
    nestControllers: facts.nestControllers.map((c) => ({ ...c, paths: c.paths.map(r), methods: c.methods.map((m) => ({ ...m, paths: m.paths.map(r) })) })),
    nestGlobalPrefix: facts.nestGlobalPrefix ? { ...facts.nestGlobalPrefix, prefix: r(facts.nestGlobalPrefix.prefix) } : undefined,
  };
}

class Resolver {
  constructor(
    private readonly lookup: FactsLookup,
    private readonly allFiles: ReadonlySet<string>,
  ) {}

  expr(file: string, facts: JsFileFacts, expr: PathExpr, depth: number): PathExpr {
    const parts: PathPart[] = [];
    for (const part of expr.parts) {
      if (!('ref' in part)) {
        parts.push(part);
        continue;
      }
      const value = depth < MAX_DEPTH ? this.ref(file, facts, part.ref, depth) : undefined;
      parts.push(...(value?.parts ?? [{ dynamic: part.ref }]));
    }
    return compactExpr({ parts });
  }

  /** `ROUTES.SHOPIFY` in `file`, where `ROUTES` is one of its imports. */
  private ref(file: string, facts: JsFileFacts, ref: string, depth: number): PathExpr | undefined {
    const [root, ...rest] = ref.split('.');
    const imp = own(facts.imports, root);
    if (!imp) return undefined;
    // Namespace and `require()` imports expose the module's exports directly.
    const key = imp.name === '*' || imp.name === '*cjs' ? rest.join('.') : [imp.name, ...rest].join('.');
    if (!key) return undefined;
    return this.exported(file, imp.source, key, depth + 1);
  }

  private exported(fromFile: string, source: string, key: string, depth: number): PathExpr | undefined {
    if (depth >= MAX_DEPTH) return undefined;
    const target = resolveModule(fromFile, source, this.allFiles);
    if (!target) return undefined;
    const facts = this.lookup(target);
    if (facts?.lang !== 'js') return undefined;
    const constant = own(facts.constants, key);
    if (constant) return this.expr(target, facts, constant, depth + 1);
    // Re-exports: `export { ROUTES } from './routes'`, `export * from './routes'`.
    const [head, ...rest] = key.split('.');
    const reexport = own(facts.exports, head);
    if (reexport?.k === 'import') {
      const next = reexport.name === '*' || reexport.name === '*cjs' ? rest.join('.') : [reexport.name, ...rest].join('.');
      if (next) return this.exported(target, reexport.source, next, depth + 1);
    }
    for (const star of facts.starExports) {
      const found = this.exported(target, star, key, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
}
