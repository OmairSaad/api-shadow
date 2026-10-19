/**
 * Builds the Express router graph across files and expands it into endpoints.
 *
 * Nodes are routers/apps (`express()`, `Router()`, router-typed function parameters). Edges come
 * from `parent.use(path, child)` and from passing a router into a function that registers routes
 * on its parameter (`registerRoutes(app)`). Endpoints are produced by walking from every root
 * (apps and routers that are never mounted) and accumulating prefixes and middleware.
 */
import * as path from 'path';
import type { CallableFact, ExpressRouteFact, HandlerFact, JsFileFacts, Pos, RefExpr, RouterLib, RouterNodeFact } from '../analyzers/facts';
import { exprToDisplay, isStaticExpr, joinUrlPaths } from '../core/paths';
import type { Endpoint, PathExpr, ServiceCall, ServiceRef, SourceLocation } from '../core/types';
import { endpointId, LinkContext, loc, resolveModule, shortFile } from './context';
import { own } from '../core/records';

type Resolved =
  | { t: 'router'; id: string }
  | { t: 'fn'; file: string; key: string }
  | { t: 'class'; file: string; name: string }
  | { t: 'instance'; file: string; className: string };

interface GraphNode {
  id: string;
  file: string;
  fact: RouterNodeFact;
  routes: { file: string; route: ExpressRouteFact }[];
  edges: Edge[];
  uses: { file: string; order: number; paths: PathExpr[]; names: string[] }[];
  incoming: number;
}

interface Edge {
  child: string;
  paths: PathExpr[];
  middleware: string[];
  file: string;
  pos: Pos;
  order: number;
  via: 'use' | 'call' | 'register';
}

type Chain = { scope: string; order: number }[];

const MAX_DEPTH = 24;

export class ExpressLinker {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly endpoints: Endpoint[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly ctx: LinkContext) {}

  link(): Endpoint[] {
    const jsFiles: [string, JsFileFacts][] = [];
    for (const [file, facts] of this.ctx.files()) {
      if (facts.lang === 'js') jsFiles.push([file, facts]);
    }
    for (const [file, facts] of jsFiles) {
      for (const r of facts.routers) {
        const id = nodeId(file, r.key);
        this.nodes.set(id, { id, file, fact: r, routes: [], edges: [], uses: [], incoming: 0 });
      }
    }
    for (const [file, facts] of jsFiles) {
      for (const route of facts.routes) {
        const target = this.resolve(file, route.router);
        if (target?.t === 'router') this.nodes.get(target.id)?.routes.push({ file, route });
      }
      for (const mount of facts.mounts) this.linkMount(file, mount);
      for (const inj of facts.injections) {
        const callee = this.resolve(file, inj.callee);
        const parent = this.resolve(file, inj.parent);
        if (callee?.t !== 'fn' || parent?.t !== 'router') continue;
        const child = this.nodes.get(nodeId(callee.file, `param:${callee.key}:${inj.argIndex}`));
        const parentNode = this.nodes.get(parent.id);
        if (!child || !parentNode) continue;
        parentNode.edges.push({ child: child.id, paths: inj.paths ?? [{ parts: [{ lit: '/' }] }], middleware: [], file, pos: inj.pos, order: Number.MAX_SAFE_INTEGER, via: inj.paths ? 'register' : 'call' });
        child.incoming++;
      }
    }

    for (const node of this.nodes.values()) {
      if (node.incoming > 0) continue;
      if (node.fact.kind !== 'app' && node.routes.length === 0 && node.edges.length === 0) continue;
      const orphan = node.fact.kind !== 'app';
      if (orphan && node.routes.length + node.edges.length > 0) {
        this.ctx.issue(
          'info',
          node.fact.kind === 'param'
            ? `Router parameter "${node.fact.name}" is never called with an app/router that API Shadow could find; its paths are shown relative to the router.`
            : `Router "${node.fact.name}" is not mounted by any analysed app; its paths are shown relative to the router.`,
          node.file,
          node.fact.pos,
        );
      }
      this.walk(node, [], [], [], new Set([node.id]), orphan, 0, node.fact.lib ?? 'express', []);
    }
    return this.endpoints;
  }

  private linkMount(file: string, mount: JsFileFacts['mounts'][number]): void {
    const parent = this.resolve(file, mount.parent);
    if (parent?.t !== 'router') return;
    const parentNode = this.nodes.get(parent.id);
    if (!parentNode) return;
    const middleware: string[] = [];
    let mountedAny = false;
    for (const arg of mount.args) {
      const r = arg.ref ? this.resolve(file, arg.ref) : undefined;
      if (r?.t === 'router' && r.id !== parent.id) {
        const child = this.nodes.get(r.id);
        if (child) {
          parentNode.edges.push({ child: r.id, paths: mount.paths, middleware: [...middleware], file, pos: mount.pos, order: mount.order, via: 'use' });
          child.incoming++;
          mountedAny = true;
          continue;
        }
      }
      if (arg.ref && isRelativeImport(arg.ref) && !r) {
        const spec = importSource(arg.ref);
        const target = spec ? resolveModule(file, spec, this.ctx.allFiles) : undefined;
        if (!target) {
          this.ctx.issue('warning', `Could not resolve module "${spec}" used in ${arg.text}; routes it registers are not shown.`, file, mount.pos);
        } else if (this.ctx.getFacts(target)) {
          // Module analysed but nothing router-like was exported: likely a factory with dynamic logic.
          const mountedAt = mount.paths.map(exprToDisplay).join(', ');
          this.ctx.issue('info', `"${arg.text}" mounted at ${mountedAt} could not be statically resolved to a router.`, file, mount.pos);
        }
      }
      middleware.push(arg.text);
    }
    if (!mountedAny) {
      parentNode.uses.push({ file, order: mount.order, paths: mount.paths, names: middleware });
    }
  }

  // -----------------------------------------------------------------------------------------
  // Reference resolution
  // -----------------------------------------------------------------------------------------

  private js(file: string): JsFileFacts | undefined {
    const f = this.ctx.getFacts(file);
    return f?.lang === 'js' ? f : undefined;
  }

  resolve(file: string, ref: RefExpr, depth = 0): Resolved | undefined {
    if (depth > MAX_DEPTH) return undefined;
    const facts = this.js(file);
    if (!facts) return undefined;
    switch (ref.k) {
      case 'node':
        return { t: 'router', id: nodeId(file, ref.key) };
      case 'fn':
        return own(facts.callables, ref.key) ? { t: 'fn', file, key: ref.key } : undefined;
      case 'class':
        return own(facts.classes, ref.name) ? { t: 'class', file, name: ref.name } : this.resolveImportedName(file, ref.name, depth, true);
      case 'instance': {
        if (own(facts.classes, ref.className)) return { t: 'instance', file, className: ref.className };
        const cls = this.resolveImportedName(file, ref.className, depth, false);
        return cls?.t === 'class' ? { t: 'instance', file: cls.file, className: cls.name } : undefined;
      }
      case 'call': {
        const callee = this.resolve(file, ref.callee, depth + 1);
        if (callee?.t !== 'fn') return undefined;
        const callable = own(this.js(callee.file)?.callables, callee.key);
        return callable?.returns ? this.resolve(callee.file, callable.returns, depth + 1) : undefined;
      }
      case 'import': {
        const target = resolveModule(file, ref.source, this.ctx.allFiles);
        if (!target) return undefined;
        return this.resolveExport(target, ref.name, ref.member, depth + 1);
      }
    }
  }

  private resolveImportedName(file: string, name: string, depth: number, asClass: boolean): Resolved | undefined {
    const imp = own(this.js(file)?.imports, name);
    if (!imp) return undefined;
    const r = this.resolve(file, { k: 'import', source: imp.source, name: imp.name }, depth + 1);
    if (asClass || r?.t === 'class') return r;
    return undefined;
  }

  private resolveExport(file: string, name: string, member: string | undefined, depth: number): Resolved | undefined {
    if (depth > MAX_DEPTH) return undefined;
    const facts = this.js(file);
    if (!facts) return undefined;
    if (member !== undefined) {
      if (name === '*' || name === '*cjs') {
        const direct = this.lookupExport(file, member, depth);
        if (direct) return direct;
        const base = this.lookupExport(file, '*cjs', depth) ?? this.lookupExport(file, 'default', depth);
        return base ? this.memberOf(base, member) : undefined;
      }
      if (name === 'default') {
        const objMember = own(facts.exports, `default.${member}`);
        if (objMember) return this.resolve(file, objMember, depth + 1);
        const base = this.lookupExport(file, 'default', depth) ?? this.lookupExport(file, '*cjs', depth);
        if (base) return this.memberOf(base, member);
        return this.lookupExport(file, member, depth);
      }
      const base = this.lookupExport(file, name, depth);
      return base ? this.memberOf(base, member) : undefined;
    }
    if (name === '*cjs') return this.lookupExport(file, '*cjs', depth) ?? this.lookupExport(file, 'default', depth);
    if (name === 'default') return this.lookupExport(file, 'default', depth) ?? this.lookupExport(file, '*cjs', depth);
    if (name === '*') return undefined;
    return this.lookupExport(file, name, depth);
  }

  private lookupExport(file: string, name: string, depth: number): Resolved | undefined {
    const facts = this.js(file);
    if (!facts) return undefined;
    const ref = own(facts.exports, name);
    if (ref) return this.resolve(file, ref, depth + 1);
    if (name !== 'default' && name !== '*cjs') {
      for (const star of facts.starExports) {
        const target = resolveModule(file, star, this.ctx.allFiles);
        if (!target) continue;
        const r = this.lookupExport(target, name, depth + 1);
        if (r) return r;
      }
    }
    return undefined;
  }

  private memberOf(base: Resolved, member: string): Resolved | undefined {
    if (base.t === 'instance' || base.t === 'class') {
      const className = base.t === 'instance' ? base.className : base.name;
      const key = own(own(this.js(base.file)?.classes, className)?.methods, member);
      return key ? { t: 'fn', file: base.file, key } : undefined;
    }
    return undefined;
  }

  // -----------------------------------------------------------------------------------------
  // Expansion
  // -----------------------------------------------------------------------------------------

  private walk(node: GraphNode, inherited: PathExpr[], middleware: string[], chain: string[], stack: Set<string>, orphan: boolean, depth: number, parentLib: RouterLib, registered: Chain): void {
    if (depth > MAX_DEPTH) return;
    // Plugin and router parameters take the library of whatever they are attached to.
    const lib = node.fact.kind === 'param' ? parentLib : (node.fact.lib ?? parentLib);
    const prefixes = node.fact.prefix ? [...inherited, node.fact.prefix] : inherited;
    for (const { file, route } of node.routes) {
      const routeMiddleware = [...middleware, ...this.usesBefore(node, file, route.order, route.paths), ...route.middleware];
      const at: Chain = [...registered, { scope: `${node.id}|${file}`, order: route.order }];
      for (const p of route.paths) this.emit(file, route, [...prefixes, p], routeMiddleware, chain, orphan, lib, at);
    }
    for (const edge of node.edges) {
      const child = this.nodes.get(edge.child);
      if (!child) continue;
      if (stack.has(child.id)) {
        this.ctx.issue('warning', `Circular router mount detected (${child.fact.name}); skipped.`, edge.file, edge.pos);
        continue;
      }
      const mw = [...middleware, ...this.usesBefore(node, edge.file, edge.order, edge.paths), ...edge.middleware];
      const nextStack = new Set(stack).add(child.id);
      const at: Chain = [...registered, { scope: `${node.id}|${edge.file}`, order: edge.order }];
      for (const p of edge.paths) {
        const note =
          edge.via === 'use'
            ? `Mounted at "${exprToDisplay(p)}" (${shortFile(edge.file)}:${edge.pos.line})`
            : edge.via === 'register'
              ? `Registered as a plugin${joinUrlPaths(exprToDisplay(p)) === '/' ? '' : ` with prefix "${exprToDisplay(p)}"`} (${shortFile(edge.file)}:${edge.pos.line})`
              : `Registered via function call (${shortFile(edge.file)}:${edge.pos.line})`;
        this.walk(child, [...prefixes, p], mw, [...chain, note], nextStack, orphan, depth + 1, lib, at);
      }
    }
  }

  /** Router-level middleware registered with `router.use(mw)` before the given declaration. */
  private usesBefore(node: GraphNode, file: string, order: number, paths: PathExpr[]): string[] {
    const out: string[] = [];
    const targetPaths = paths.map(exprToDisplay);
    for (const use of node.uses) {
      if (use.file !== file || use.order >= order) continue;
      const scoped = use.paths.map(exprToDisplay);
      const applies = scoped.some((s) => {
        const prefix = joinUrlPaths(s);
        return prefix === '/' || targetPaths.some((t) => joinUrlPaths(t) === prefix || joinUrlPaths(t).startsWith(prefix + '/'));
      });
      if (applies) out.push(...use.names);
    }
    return out;
  }

  private emit(file: string, route: ExpressRouteFact, exprs: PathExpr[], middleware: string[], chain: string[], orphan: boolean, lib: RouterLib, registered: Chain): void {
    const isStatic = exprs.every(isStaticExpr);
    const hasRegex = exprs.some((e) => e.parts.some((p) => 'regex' in p));
    // Regex routes cannot be joined like strings: show the prefix followed by the pattern.
    const fullPath = hasRegex
      ? `${joinUrlPaths(...exprs.filter((e) => !e.parts.some((p) => 'regex' in p)).map(exprToDisplay))} ~ ${exprs
          .flatMap((e) => e.parts.filter((p): p is { regex: string } => 'regex' in p).map((p) => p.regex))
          .join(' ')}`
      : joinUrlPaths(...exprs.map(exprToDisplay));
    const location = loc(file, route.pos);
    const notes = [...chain];
    if (!isStatic) notes.push(hasRegex ? 'Route uses a regular expression.' : 'Path contains expressions that could not be resolved statically.');
    if (orphan) notes.push('Mount point not found: path is relative to its router.');
    const handler = route.handler;
    const resolved = handler ? this.resolveHandler(file, handler) : undefined;
    const services = this.services(resolved?.file ?? file, [...(handler?.serviceCalls ?? []), ...(resolved?.callable?.serviceCalls ?? [])]);
    const validated = route.bodySchema ? 'route schema' : handler?.validatesBody || resolved?.callable?.validatesBody ? 'schema check in handler' : undefined;
    const endpoint: Endpoint = {
      id: '',
      framework: lib,
      method: route.method,
      path: fullPath,
      pathIsStatic: isStatic,
      controller: handler?.controller ?? path.basename(file).replace(/\.[^.]+$/, ''),
      handler: handler?.name,
      location,
      handlerLocation: resolved?.location,
      middleware: dedupe(middleware),
      services,
      parameters: [],
      validation: validated ? { status: 'validated', via: [validated] } : undefined,
      notes,
      projectRoot: this.ctx.projectRootOf(file),
    };
    endpoint.id = endpointId(endpoint, chain.join('>'));
    if (this.seen.has(endpoint.id)) return;
    this.seen.add(endpoint.id);
    this.endpoints.push(endpoint);
    // Express passes `next` third, Koa second; a handler that takes it may let requests through.
    const arity = handler?.arity ?? resolved?.callable?.arity ?? 0;
    this.ctx.registrations.set(endpoint.id, { chain: registered, passThrough: arity >= (lib === 'koa' ? 2 : 3) });
  }

  private resolveHandler(file: string, handler: HandlerFact): { file: string; callable?: CallableFact; location?: SourceLocation } | undefined {
    if (!handler.ref) return undefined;
    let r = this.resolve(file, handler.ref);
    if (r && handler.member !== undefined && r.t !== 'fn') r = this.memberOf(r, handler.member);
    if (!r && handler.member !== undefined && handler.ref.k === 'import' && !handler.ref.member) {
      r = this.resolve(file, { ...handler.ref, member: handler.member });
    }
    if (r?.t !== 'fn') return undefined;
    const callable = own(this.js(r.file)?.callables, r.key);
    if (!callable) return undefined;
    return { file: r.file, callable, location: loc(r.file, callable.pos) };
  }

  private services(file: string, calls: ServiceCall[]): ServiceRef[] {
    const out: ServiceRef[] = [];
    const seen = new Set<string>();
    for (const call of calls) {
      let location: SourceLocation | undefined;
      let owner = call.type || call.receiver.replace(/^this\./, '');
      if (call.type) {
        const cls = this.resolve(file, { k: 'class', name: call.type });
        if (cls?.t === 'class') {
          const key = own(own(this.js(cls.file)?.classes, cls.name)?.methods, call.method);
          const callable = key ? own(this.js(cls.file)?.callables, key) : undefined;
          location = callable ? loc(cls.file, callable.pos) : loc(cls.file, own(this.js(cls.file)?.classes, cls.name)?.pos);
        }
      } else if (call.local) {
        const imp = own(this.js(file)?.imports, call.local);
        const r = imp ? this.resolve(file, { k: 'import', source: imp.source, name: imp.name }) : undefined;
        const callable = r?.t === 'fn' ? own(this.js(r.file)?.callables, r.key) : undefined;
        if (r?.t === 'fn' && callable) location = loc(r.file, callable.pos);
      } else {
        const imp = own(this.js(file)?.imports, call.receiver);
        if (imp) {
          const r = this.resolve(file, { k: 'import', source: imp.source, name: imp.name, member: call.method });
          if (r?.t === 'fn') {
            const callable = own(this.js(r.file)?.callables, r.key);
            if (callable) location = loc(r.file, callable.pos);
          }
          owner = call.receiver;
        }
      }
      const name = `${owner}.${call.method}`;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, location });
    }
    return out;
  }
}

function nodeId(file: string, key: string): string {
  return `${file}::${key}`;
}

function isRelativeImport(ref: RefExpr): boolean {
  const src = importSource(ref);
  return !!src && src.startsWith('.');
}

function importSource(ref: RefExpr): string | undefined {
  if (ref.k === 'import') return ref.source;
  if (ref.k === 'call') return importSource(ref.callee);
  return undefined;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
