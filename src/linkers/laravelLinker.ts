/**
 * Expands Laravel route files into endpoints. A route file's routes get the prefix and middleware
 * of whatever loads it: `->group(base_path('routes/api.php'))` in a service provider, `require`
 * from another route file, or `withRouting(api: …, apiPrefix: …)` in `bootstrap/app.php`. Without
 * any of those, Laravel's defaults apply: `routes/api.php` gets the `api` prefix and middleware
 * group, `routes/web.php` the `web` group. Controller classes are found by name through the route
 * file's imports and analyzed on demand.
 */
import * as path from 'path';
import type { PhpClassFact, PhpFileFacts, PhpIncludeFact, PhpMethodFact, PhpRouteFact } from '../analyzers/facts';
import { exprToDisplay, isStaticExpr, joinUrlPaths, lit } from '../core/paths';
import type { Endpoint, EndpointParameter, HttpMethod, PathExpr, ServiceRef, SourceLocation, TraceStep } from '../core/types';
import { bodyFields, endpointId, LinkContext, loc, shortFile } from './context';

interface LoadContext {
  key: string;
  paths: PathExpr[];
  middleware: string[];
  /** Steps that add prefixes or middleware, with their locations. */
  trace: TraceStep[];
  /** The file is not loaded from anywhere API Shadow can see: paths are relative to it. */
  relativeTo?: string;
}

interface ClassEntry {
  file: string;
  facts: PhpFileFacts;
  cls: PhpClassFact;
}

const MAX_INCLUDE_DEPTH = 8;

export class LaravelLinker {
  private readonly files: [string, PhpFileFacts][] = [];
  private readonly includedBy = new Map<string, { from: string; include: PhpIncludeFact }[]>();
  private readonly routing = new Map<string, { kind: 'api' | 'web'; prefix?: string; from: string; pos: { line: number; column: number } }>();
  private readonly classCache = new Map<string, ClassEntry | undefined>();

  constructor(private readonly ctx: LinkContext) {}

  link(): Endpoint[] {
    for (const [file, facts] of this.ctx.files()) if (facts.lang === 'php') this.files.push([file, facts]);
    for (const [file, facts] of this.files) {
      for (const inc of facts.includes) {
        const target = this.target(file, inc.target);
        if (!target) continue;
        this.ctx.getFacts(target);
        this.includedBy.set(target, [...(this.includedBy.get(target) ?? []), { from: file, include: inc }]);
      }
      if (facts.routing) {
        for (const kind of ['api', 'web'] as const) {
          const t = facts.routing[kind];
          const target = t ? this.target(file, t) : undefined;
          if (target) {
            this.ctx.getFacts(target);
            this.routing.set(target, { kind, prefix: kind === 'api' ? (facts.routing.apiPrefix ?? 'api') : undefined, from: file, pos: facts.routing.pos });
          }
        }
      }
    }
    const endpoints: Endpoint[] = [];
    for (const [file, facts] of this.files) {
      if (facts.routing?.health) endpoints.push(this.health(file, facts.routing.health, facts.routing.pos));
      if (facts.routes.length === 0) continue;
      for (const context of this.contexts(file, 0, new Set())) {
        for (const route of facts.routes) endpoints.push(...this.expand(file, facts, route, context));
      }
    }
    return endpoints;
  }

  /** Files whose own location says how they are loaded: under routes/, included, or named by withRouting. */
  private isRouteFile(file: string): boolean {
    if (this.includedBy.has(file) || this.routing.has(file)) return true;
    return path.relative(this.ctx.projectRootOf(file), file).split(path.sep).join('/').startsWith('routes/');
  }

  /** `withRouting(health: '/up')` registers a GET health check route. */
  private health(file: string, uri: string, pos: { line: number; column: number }): Endpoint {
    const endpoint: Endpoint = {
      id: '',
      framework: 'laravel',
      method: 'GET',
      path: joinUrlPaths(uri),
      pathIsStatic: true,
      controller: 'Laravel',
      handler: 'health',
      location: loc(file, pos),
      middleware: [],
      services: [],
      parameters: [],
      notes: [`Health check route registered by withRouting in ${shortFile(file)}`],
      projectRoot: this.ctx.projectRootOf(file),
    };
    endpoint.id = endpointId(endpoint, 'health');
    return endpoint;
  }

  /** Absolute path of an included file, if it exists in the workspace. */
  private target(from: string, t: PhpIncludeFact['target']): string | undefined {
    const abs = t.base === 'project' ? path.join(this.ctx.projectRootOf(from), t.path) : path.resolve(path.dirname(from), t.path);
    return this.ctx.allFiles.has(abs) ? abs : undefined;
  }

  /** Every way a route file is loaded, with the prefix and middleware each one adds. */
  private contexts(file: string, depth: number, stack: Set<string>): LoadContext[] {
    if (depth > MAX_INCLUDE_DEPTH || stack.has(file)) return [];
    const nextStack = new Set(stack).add(file);
    const includers = this.includedBy.get(file);
    if (includers?.length) {
      const out: LoadContext[] = [];
      for (const { from, include } of includers) {
        const where = `${shortFile(from)}:${include.pos.line}`;
        // A service provider or bootstrap file only loads route files: it adds nothing itself.
        const parents = this.isRouteFile(from) ? this.contexts(from, depth + 1, nextStack) : [];
        for (const parent of parents.length ? parents : [{ key: from, paths: [], middleware: [], trace: [] }]) {
          out.push({
            key: `${parent.key}>${where}`,
            paths: [...parent.paths, ...include.paths],
            middleware: [...parent.middleware, ...include.middleware],
            trace: [...parent.trace, ...include.trace.map((t) => ({ text: t.text, location: loc(from, t.pos) })), { text: `Route file ${shortFile(file)} loaded`, location: loc(from, include.pos) }],
            relativeTo: parent.relativeTo,
          });
        }
      }
      return out;
    }
    const routed = this.routing.get(file);
    if (routed) {
      const location = loc(routed.from, routed.pos);
      return routed.kind === 'api'
        ? [{ key: file, paths: routed.prefix ? [lit(routed.prefix)] : [], middleware: ['api'], trace: [{ text: `API routes: prefix "${routed.prefix ?? ''}" and the api middleware group (withRouting)`, location }] }]
        : [{ key: file, paths: [], middleware: ['web'], trace: [{ text: 'Web routes: the web middleware group (withRouting)', location }] }];
    }
    const root = this.ctx.projectRootOf(file);
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (rel === 'routes/api.php') return [{ key: file, paths: [lit('api')], middleware: ['api'], trace: [{ text: 'Prefix "api" and the api middleware group (Laravel default for routes/api.php)' }] }];
    if (rel === 'routes/web.php') return [{ key: file, paths: [], middleware: ['web'], trace: [{ text: 'The web middleware group (Laravel default for routes/web.php)' }] }];
    if (rel.startsWith('routes/')) return [{ key: file, paths: [], middleware: [], trace: [] }];
    return [{ key: file, paths: [], middleware: [], trace: [{ text: 'This file is not loaded from routes/ or a route group API Shadow could find; its prefix may be missing.' }], relativeTo: file }];
  }

  private expand(file: string, facts: PhpFileFacts, route: PhpRouteFact, context: LoadContext): Endpoint[] {
    const exprs = [...context.paths, ...route.paths];
    const isStatic = exprs.every(isStaticExpr);
    const fullPath = joinUrlPaths(...exprs.map(exprToDisplay));
    const action = route.action;
    let method: PhpMethodFact | undefined;
    let owner: ClassEntry | undefined;
    let controller: string | undefined;
    let handler: string | undefined;
    let handlerLocation: SourceLocation | undefined;
    const trace: TraceStep[] = [...context.trace, ...route.trace.map((t) => ({ text: t.text, location: loc(file, t.pos) }))];
    const notes = trace.map((t) => (t.location ? `${t.text} (${shortFile(t.location.file)}:${t.location.line})` : t.text));
    if (action?.kind === 'controller') {
      controller = shortName(action.class);
      handler = action.method;
      owner = this.findClass(action.class);
      method = owner ? this.findMethod(owner, action.method) : undefined;
      if (owner && method) handlerLocation = loc(owner.file, method.pos);
      else if (owner) {
        handlerLocation = loc(owner.file, owner.cls.pos);
        notes.push(`${controller} has no ${action.method}() method that API Shadow could find.`);
      } else notes.push(`Controller ${action.class} was not found in the workspace.`);
    } else if (action?.kind === 'closure') {
      controller = path.basename(file, '.php');
      handler = '(closure)';
      handlerLocation = loc(file, action.pos);
    } else if (action?.kind === 'view') {
      controller = path.basename(file, '.php');
      handler = action.view;
      notes.push(action.view.startsWith('redirect') ? `Redirect route (${action.view})` : `Returns the view "${action.view}"`);
    }
    if (route.resource) notes.push(`Resource route ${route.resource.name}.${route.resource.action}`);
    if (route.name) notes.push(`Route name: ${route.name}`);
    if (!isStatic) notes.push('Path contains expressions that could not be resolved statically.');
    if (route.constrained) notes.push('Parameters are constrained with where(); the route only matches some values.');
    const body = method?.body ?? (action?.kind === 'closure' ? action.body : undefined);
    const formRequest = method?.formRequest ?? (action?.kind === 'closure' ? action.formRequest : undefined);
    const validates = method?.validates ?? (action?.kind === 'closure' ? action.validates : undefined);
    const middleware = [...new Set([...context.middleware, ...route.middleware])];
    const out: Endpoint[] = [];
    for (const httpMethod of route.methods) {
      const endpoint: Endpoint = {
        id: '',
        framework: 'laravel',
        method: httpMethod as HttpMethod,
        path: fullPath,
        pathIsStatic: isStatic,
        controller,
        handler,
        location: loc(file, route.pos),
        handlerLocation,
        middleware,
        services: owner && method ? this.services(owner, method) : [],
        parameters: pathParameters(fullPath, method),
        requestBodyType: formRequest,
        validation: formRequest || validates ? { status: 'validated', via: [formRequest ?? 'validate()'] } : undefined,
        notes,
        trace: trace.length ? trace : undefined,
        relativeTo: context.relativeTo,
        projectRoot: this.ctx.projectRootOf(file),
        readsBody: body?.readsInput || undefined,
        ...bodyFields(body, owner && method ? owner.file : file, 'laravel'),
      };
      // Route model binding answers 404 when no record matches the path parameter.
      const bound = method?.params.find((p) => p.type && /^[A-Z]/.test(p.type) && !/Request$|Service$|Repository$/.test(p.type) && endpoint.parameters.some((x) => x.name === p.name));
      if (bound && handlerLocation && !(endpoint.responses ?? []).some((r) => r.status === 404)) {
        endpoint.responses = [...(endpoint.responses ?? []), { status: 404, via: 'throw', location: handlerLocation }];
        endpoint.notes = [...notes, `{${bound.name}} is bound to ${bound.type} (404 when no record matches)`];
      }
      endpoint.id = endpointId(endpoint, `${context.key}|${route.order}`);
      out.push(endpoint);
      // Laravel matches routes in registration order; constrained routes may not match at all.
      if (!route.constrained) this.ctx.registrations.set(endpoint.id, { chain: [{ scope: `${file}|${context.key}`, order: route.order }], passThrough: false });
    }
    return out;
  }

  /** A class by fully qualified name (or short name), searching `<Name>.php` files. */
  private findClass(name: string): ClassEntry | undefined {
    if (this.classCache.has(name)) return this.classCache.get(name);
    const short = shortName(name);
    let found: ClassEntry | undefined;
    let fallback: ClassEntry | undefined;
    for (const f of this.ctx.filesNamed(`${short}.php`)) {
      const facts = this.ctx.getFacts(f);
      if (facts?.lang !== 'php') continue;
      for (const cls of facts.classes) {
        if (cls.name !== short) continue;
        const fqn = cls.namespace ? `${cls.namespace}\\${cls.name}` : cls.name;
        if (fqn === name) found ??= { file: f, facts, cls };
        else fallback ??= { file: f, facts, cls };
      }
    }
    const result = found ?? fallback;
    // Only cache hits: a miss may be a file the engine has not analyzed yet.
    if (result) this.classCache.set(name, result);
    return result;
  }

  /** A method of the class or a parent class in the workspace. */
  private findMethod(entry: ClassEntry, name: string, depth = 0): PhpMethodFact | undefined {
    const m = entry.cls.methods.find((x) => x.name === name);
    if (m || depth > 4 || !entry.cls.extends) return m;
    const parent = this.findClass(resolveIn(entry.facts, entry.cls.extends));
    return parent ? this.findMethod(parent, name, depth + 1) : undefined;
  }

  private services(owner: ClassEntry, method: PhpMethodFact): ServiceRef[] {
    return method.calls.map((call) => {
      const target = call.type ? this.findClass(resolveIn(owner.facts, call.type)) : undefined;
      const m = target?.cls.methods.find((x) => x.name === call.method);
      const location = target ? loc(target.file, m?.pos ?? target.cls.pos) : undefined;
      const uses = m?.body?.dataAccess?.map((name) => ({ name }));
      return uses?.length ? { name: `${call.type}.${call.method}`, location, uses } : { name: `${call.type}.${call.method}`, location };
    });
  }
}

/** Path parameters (`{article}`, `{id?}`), typed from the controller method's parameters. */
function pathParameters(p: string, method: PhpMethodFact | undefined): EndpointParameter[] {
  const out: EndpointParameter[] = [];
  for (const m of p.matchAll(/\{(\w+)(\?)?\}/g)) {
    const param = method?.params.find((x) => x.name === m[1]);
    out.push({ name: m[1], in: 'path', required: !m[2], type: param?.type });
  }
  return out;
}

function resolveIn(facts: PhpFileFacts, name: string): string {
  if (name.includes('\\')) return name.replace(/^\\/, '');
  if (Object.prototype.hasOwnProperty.call(facts.uses, name)) return facts.uses[name];
  return facts.namespace ? `${facts.namespace}\\${name}` : name;
}

function shortName(fqn: string): string {
  return fqn.replace(/^\\/, '').split('\\').pop()!;
}
