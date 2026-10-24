/**
 * Extracts Laravel facts from one PHP file: route registrations (with the groups, prefixes,
 * middleware and resource expansions written in that file), route files it loads, Laravel 11
 * `withRouting()` configuration, controller classes (methods, validation, responses, services,
 * risks) and HTTP calls in feature tests. Nothing is executed.
 */
import type { HttpMethod, PathExpr, PathPart, ServiceCall, Shape, ShapeProp } from '../core/types';
import { compactExpr } from '../core/paths';
import type { BodyFacts, PhpActionFact, PhpTraceFact, PhpClassFact, PhpFileFacts, PhpIncludeFact, PhpMethodFact, Pos, ResponseFact, RiskFact } from './facts';
import { parsePhp, walkNode, walkStmts, type PArg, type PMethod, type PNode, type PParam, type PStmt } from './phpParser';

/** Quick textual check: route files, `bootstrap/app.php`, route service providers and HTTP tests. */
export function isPhpCandidate(source: string): boolean {
  return /\bRoute::|->withRouting\s*\(|\$router->(get|post|put|patch|delete|group)\s*\(|\$this->(get|post|put|patch|delete|json)(Json)?\s*\(/.test(source);
}

const VERBS: Record<string, HttpMethod> = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', delete: 'DELETE', options: 'OPTIONS', any: 'ALL' };
const RESOURCE_ACTIONS: { action: string; methods: HttpMethod[]; suffix: (p: string) => string; api: boolean }[] = [
  { action: 'index', methods: ['GET'], suffix: () => '', api: true },
  { action: 'create', methods: ['GET'], suffix: () => '/create', api: false },
  { action: 'store', methods: ['POST'], suffix: () => '', api: true },
  { action: 'show', methods: ['GET'], suffix: (p) => `/{${p}}`, api: true },
  { action: 'edit', methods: ['GET'], suffix: (p) => `/{${p}}/edit`, api: false },
  { action: 'update', methods: ['PUT', 'PATCH'], suffix: (p) => `/{${p}}`, api: true },
  { action: 'destroy', methods: ['DELETE'], suffix: (p) => `/{${p}}`, api: true },
];
const SINGLETON_ACTIONS: { action: string; methods: HttpMethod[]; suffix: string; api: boolean }[] = [
  { action: 'show', methods: ['GET'], suffix: '', api: true },
  { action: 'edit', methods: ['GET'], suffix: '/edit', api: false },
  { action: 'update', methods: ['PUT', 'PATCH'], suffix: '', api: true },
];
const STATUS_NAMES: Record<string, number> = {
  HTTP_OK: 200, HTTP_CREATED: 201, HTTP_ACCEPTED: 202, HTTP_NO_CONTENT: 204, HTTP_MOVED_PERMANENTLY: 301, HTTP_FOUND: 302,
  HTTP_BAD_REQUEST: 400, HTTP_UNAUTHORIZED: 401, HTTP_FORBIDDEN: 403, HTTP_NOT_FOUND: 404, HTTP_METHOD_NOT_ALLOWED: 405,
  HTTP_CONFLICT: 409, HTTP_UNPROCESSABLE_ENTITY: 422, HTTP_TOO_MANY_REQUESTS: 429, HTTP_INTERNAL_SERVER_ERROR: 500,
};
const ELOQUENT = new Set(['all', 'find', 'findOrFail', 'findMany', 'where', 'whereIn', 'create', 'forceCreate', 'firstOrCreate', 'updateOrCreate', 'firstOrNew', 'query', 'paginate', 'simplePaginate', 'with', 'latest', 'oldest', 'orderBy', 'first', 'firstOrFail', 'get', 'destroy', 'insert', 'upsert', 'update', 'delete', 'save', 'fill', 'forceFill', 'count', 'exists', 'pluck', 'select']);
const NOT_MODELS = new Set(['DB', 'Auth', 'Gate', 'Validator', 'Storage', 'Route', 'Str', 'Arr', 'Log', 'Cache', 'Response', 'Http', 'Hash', 'Mail', 'Queue', 'Carbon', 'Session', 'Cookie', 'Config', 'App', 'URL', 'Redirect', 'View', 'Request', 'Schema', 'Notification', 'Password', 'Crypt', 'Lang', 'Artisan', 'Bus', 'File', 'Broadcast']);
const INPUT_METHODS = new Set(['input', 'get', 'query', 'post', 'all', 'only', 'except', 'string', 'str', 'integer', 'boolean', 'float', 'json', 'collect', 'header', 'cookie', 'file', 'route', 'date', 'enum']);
const WHOLE_INPUT = new Set(['all', 'input', 'post', 'json']);
const WRITE_METHODS = new Set(['create', 'forceCreate', 'insert', 'upsert', 'firstOrCreate', 'updateOrCreate', 'update', 'fill', 'forceFill', 'make']);
const SQL_STATIC = new Set(['select', 'insert', 'update', 'delete', 'statement', 'unprepared', 'raw', 'selectOne']);
const SQL_METHODS = new Set(['whereRaw', 'orWhereRaw', 'selectRaw', 'orderByRaw', 'havingRaw', 'groupByRaw', 'raw']);
const COMMANDS = new Set(['exec', 'shell_exec', 'system', 'passthru', 'proc_open', 'popen']);
const FILES = new Set(['file_get_contents', 'readfile', 'fopen', 'unlink', 'file', 'file_put_contents']);
const SERVICE_TYPE = /(Service|Repository|Repo|Manager|Gateway|Client|Action|Handler|UseCase|Facade|Provider)$/;
const MAX_DEPTH = 6;

interface Ctx {
  paths: PathExpr[];
  middleware: string[];
  name: string;
  controller?: string;
  namespace?: string;
  trace: PhpTraceFact[];
}

const ROOT: Ctx = { paths: [], middleware: [], name: '', trace: [] };

export function analyzePhp(source: string, _file: string): PhpFileFacts {
  return new PhpAnalyzer(source).run();
}

class PhpAnalyzer {
  private readonly facts: PhpFileFacts = { lang: 'php', namespace: '', uses: {}, routes: [], includes: [], classes: [], clientCalls: [], risks: [], issues: [] };
  private order = 0;
  private readonly routeNames = new Set(['Route', 'Illuminate\\Support\\Facades\\Route']);

  constructor(private readonly source: string) {}

  run(): PhpFileFacts {
    const parsed = parsePhp(this.source);
    if (parsed.errors.length) {
      this.facts.issues.push({ kind: 'limitation', severity: 'info', message: `${parsed.errors.length} PHP statement(s) could not be parsed and were skipped; routes in them are not shown.`, pos: parsed.errors[0] });
    }
    this.collectDeclarations(parsed.stmts);
    for (const [alias, fqn] of Object.entries(this.facts.uses)) if (fqn === 'Illuminate\\Support\\Facades\\Route') this.routeNames.add(alias);
    this.visitStmts(parsed.stmts, ROOT);
    return this.facts;
  }

  // -------------------------------------------------------------------------------------------
  // Namespaces, imports and classes
  // -------------------------------------------------------------------------------------------

  private collectDeclarations(stmts: PStmt[]): void {
    walkStmts(stmts, (s) => {
      if (s.k === 'namespace') this.facts.namespace = s.name;
      else if (s.k === 'use') this.facts.uses[s.alias] = s.fqn;
      else if (s.k === 'class') this.facts.classes.push(this.classFact(s));
    });
  }

  /** `ArticleController` → `App\Http\Controllers\ArticleController` through imports and the namespace. */
  private resolveClass(name: string): string {
    if (name.includes('\\')) {
      const [head, ...rest] = name.split('\\');
      const imported = Object.prototype.hasOwnProperty.call(this.facts.uses, head) ? this.facts.uses[head] : undefined;
      return imported ? [imported, ...rest].join('\\') : name;
    }
    if (Object.prototype.hasOwnProperty.call(this.facts.uses, name)) return this.facts.uses[name];
    return this.facts.namespace ? `${this.facts.namespace}\\${name}` : name;
  }

  private classFact(s: Extract<PStmt, { k: 'class' }>): PhpClassFact {
    const deps: Record<string, string> = {};
    const ctor = s.methods.find((m) => m.name.toLowerCase() === '__construct');
    if (ctor) {
      for (const p of ctor.params) if (p.promoted && p.type) deps[p.name] = shortName(p.type);
      // `$this->users = $users;` with a typed constructor parameter.
      walkStmts(ctor.body, (st) => {
        if (st.k !== 'expr' || st.e.k !== 'assign' || st.e.target.k !== 'prop' || st.e.target.target.k !== 'var' || st.e.target.target.name !== 'this' || st.e.value.k !== 'var') return;
        const value = st.e.value;
        const param = ctor.params.find((p) => p.name === value.name);
        if (param?.type) deps[st.e.target.name] = shortName(param.type);
      });
    }
    return {
      name: s.name,
      namespace: this.facts.namespace,
      extends: s.extends,
      pos: s.pos,
      deps,
      methods: s.methods.filter((m) => m.name.toLowerCase() !== '__construct').map((m) => this.methodFact(m, deps)),
    };
  }

  private methodFact(m: PMethod, deps: Record<string, string>): PhpMethodFact {
    const fn = new PhpBody(m.params, m.body);
    const facts: PhpMethodFact = { name: m.name, pos: m.pos, params: m.params.map((p) => ({ name: p.name, type: p.type ? shortName(p.type) : undefined })), calls: serviceCalls(m.body, deps) };
    const formRequest = m.params.find((p) => p.type && /Request$/.test(p.type) && !/(^|\\)Request$/.test(p.type))?.type;
    if (formRequest) facts.formRequest = shortName(formRequest);
    // Analyze the body first: it sets `validates`.
    const body = fn.facts();
    if (body) facts.body = body;
    if (fn.validates) facts.validates = true;
    return facts;
  }

  // -------------------------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------------------------

  private visitStmts(stmts: PStmt[], ctx: Ctx): void {
    for (const s of stmts) {
      if (s.k === 'expr' || s.k === 'return') {
        if (s.e) this.visitExpr(s.e, ctx);
      } else if (s.k === 'block' || s.k === 'catch') this.visitStmts(s.body, ctx);
      else if (s.k === 'namespace' && s.body) this.visitStmts(s.body, ctx);
      else if (s.k === 'function') this.visitStmts(s.body, ctx);
      else if (s.k === 'class') for (const m of s.methods) this.visitStmts(m.body, ROOT);
    }
  }

  private visitExpr(e: PNode, ctx: Ctx): void {
    const chain = this.routeChain(e);
    if (chain) {
      this.interpret(chain, ctx);
      return;
    }
    if (e.k === 'call' && /^(require|include)(_once)?$/.test(e.name) && e.args[0]) {
      const target = includeTarget(e.args[0].value);
      if (target) this.addInclude(target, ctx, e.pos);
      return;
    }
    if (e.k === 'mcall' && e.method === 'withRouting') this.routing(e);
    this.testCall(e);
    // Closures passed to other calls (`$this->routes(function () { … })`, `then: fn () => …`).
    const visitArgs = (args: PArg[]): void => {
      for (const a of args) {
        if (a.value.k === 'closure') this.visitStmts(a.value.body, ctx);
        else this.visitExpr(a.value, ctx);
      }
    };
    if (e.k === 'mcall') {
      this.visitExpr(e.target, ctx);
      visitArgs(e.args);
    } else if (e.k === 'scall' || e.k === 'call' || e.k === 'new') visitArgs(e.args);
    else if (e.k === 'dcall') visitArgs(e.args);
    else if (e.k === 'assign') this.visitExpr(e.value, ctx);
  }

  /** The calls of `Route::a(…)->b(…)->c(…)` (or `$router->a(…)`), outermost last. */
  private routeChain(e: PNode): { method: string; args: PArg[]; pos: Pos }[] | undefined {
    const calls: { method: string; args: PArg[]; pos: Pos }[] = [];
    let n: PNode = e;
    for (let i = 0; i < 40; i++) {
      if (n.k === 'mcall') {
        calls.unshift({ method: n.method, args: n.args, pos: n.pos });
        if (n.target.k === 'var' && n.target.name === 'router') return calls;
        n = n.target;
        continue;
      }
      if (n.k === 'scall' && this.routeNames.has(n.cls)) {
        calls.unshift({ method: n.method, args: n.args, pos: n.pos });
        return calls;
      }
      return undefined;
    }
    return undefined;
  }

  private interpret(calls: { method: string; args: PArg[]; pos: Pos }[], ctx: Ctx): void {
    const pending: Ctx = { paths: [], middleware: [], name: '', trace: [], controller: undefined };
    let constrained = false;
    const without: string[] = [];
    for (let i = 0; i < calls.length; i++) {
      const { method, args, pos } = calls[i];
      const m = method.toLowerCase();
      const rest = calls.slice(i + 1);
      switch (m) {
        case 'prefix':
          if (args[0]) {
            pending.paths.push(this.pathOf(args[0].value));
            pending.trace.push({ text: `Prefix "${exprText(this.pathOf(args[0].value))}"`, pos });
          }
          continue;
        case 'middleware': {
          const names = this.strings(args);
          pending.middleware.push(...names);
          if (names.length) pending.trace.push({ text: `Middleware ${names.join(', ')}`, pos });
          continue;
        }
        case 'withoutmiddleware':
          without.push(...this.strings(args));
          continue;
        case 'name':
        case 'as':
          if (args[0]?.value.k === 'str') pending.name += args[0].value.v;
          continue;
        case 'controller':
          if (args[0]) pending.controller = this.className(args[0].value);
          continue;
        case 'namespace':
          if (args[0]?.value.k === 'str') pending.namespace = args[0].value.v;
          continue;
        case 'domain':
          if (args[0]) pending.trace.push({ text: `Domain ${args[0].value.k === 'str' ? args[0].value.v : '(expression)'}`, pos });
          continue;
        case 'scopebindings':
        case 'withouttrashed':
          continue;
        case 'group':
          this.group(args, this.merge(ctx, pending, without), pos);
          return;
        case 'resource':
        case 'apiresource':
          this.resource(args, rest, this.merge(ctx, pending, without), pos, m === 'apiresource');
          return;
        case 'resources':
        case 'apiresources': {
          const map = args[0]?.value;
          if (map?.k === 'arr') {
            for (const it of map.items) if (it.key) this.resource([{ value: it.key }, { value: it.value }, ...args.slice(1)], rest, this.merge(ctx, pending, without), pos, m === 'apiresources');
          }
          return;
        }
        case 'singleton':
        case 'apisingleton':
          this.singleton(args, rest, this.merge(ctx, pending, without), pos, m === 'apisingleton');
          return;
        case 'match': {
          const verbs = args[0]?.value.k === 'arr' ? args[0].value.items.map((x) => (x.value.k === 'str' ? VERBS[x.value.v.toLowerCase()] : undefined)).filter((x): x is HttpMethod => !!x) : [];
          if (verbs.length && args[1]) this.route(verbs, args[1].value, args[2]?.value, rest, this.merge(ctx, pending, without), pos, constrained);
          return;
        }
        case 'view':
          if (args[0]) this.route(['GET'], args[0].value, undefined, rest, this.merge(ctx, pending, without), pos, constrained, { kind: 'view', view: args[1]?.value.k === 'str' ? args[1].value.v : 'view' });
          return;
        case 'redirect':
        case 'permanentredirect':
          if (args[0]) this.route(['ALL'], args[0].value, undefined, rest, this.merge(ctx, pending, without), pos, constrained, { kind: 'view', view: `redirect to ${args[1]?.value.k === 'str' ? args[1].value.v : '…'}` });
          return;
        case 'fallback':
          if (args[0]) this.route(['ALL'], { k: 'str', v: '{fallbackPlaceholder}', dyn: false, pos }, args[0].value, rest, this.merge(ctx, pending, without), pos, true);
          return;
        default:
          if (VERBS[m] && args[0]) {
            this.route([VERBS[m]], args[0].value, args[1]?.value, rest, this.merge(ctx, pending, without), pos, constrained);
            return;
          }
          if (m.startsWith('where')) {
            constrained = true;
            continue;
          }
          return;
      }
    }
  }

  private merge(ctx: Ctx, add: Ctx, without: string[]): Ctx {
    return {
      paths: [...ctx.paths, ...add.paths],
      middleware: [...ctx.middleware, ...add.middleware].filter((m) => !without.includes(m)),
      name: ctx.name + add.name,
      controller: add.controller ?? ctx.controller,
      namespace: add.namespace ?? ctx.namespace,
      trace: [...ctx.trace, ...add.trace],
    };
  }

  private group(args: PArg[], ctx: Ctx, pos: Pos): void {
    let c = ctx;
    const attrs = args.length > 1 ? args[0]?.value : undefined;
    if (attrs?.k === 'arr') {
      const add: Ctx = { paths: [], middleware: [], name: '', trace: [] };
      for (const it of attrs.items) {
        const key = it.key?.k === 'str' ? it.key.v : undefined;
        if (key === 'prefix') {
          add.paths.push(this.pathOf(it.value));
          add.trace.push({ text: `Group prefix "${exprText(this.pathOf(it.value))}"`, pos });
        } else if (key === 'middleware') {
          const names = this.strings([{ value: it.value }]);
          add.middleware.push(...names);
          if (names.length) add.trace.push({ text: `Group middleware ${names.join(', ')}`, pos });
        }
        else if (key === 'as' && it.value.k === 'str') add.name += it.value.v;
        else if (key === 'namespace' && it.value.k === 'str') add.namespace = it.value.v;
        else if (key === 'controller') add.controller = this.className(it.value);
      }
      c = this.merge(ctx, add, []);
    }
    const callback = args[args.length - 1]?.value;
    if (!callback) return;
    if (callback.k === 'closure') this.visitStmts(callback.body, c);
    else {
      const target = includeTarget(callback);
      if (target) this.addInclude(target, c, pos);
    }
  }

  private addInclude(target: PhpIncludeFact['target'], ctx: Ctx, pos: Pos): void {
    this.facts.includes.push({ target, paths: ctx.paths, middleware: ctx.middleware, trace: ctx.trace, pos });
  }

  private route(methods: HttpMethod[], uri: PNode, action: PNode | undefined, modifiers: { method: string; args: PArg[]; pos: Pos }[], ctx: Ctx, pos: Pos, constrained: boolean, fixed?: PhpActionFact): void {
    const middleware = [...ctx.middleware];
    let name: string | undefined;
    let isConstrained = constrained;
    for (const mod of modifiers) {
      const m = mod.method.toLowerCase();
      if (m === 'middleware') middleware.push(...this.strings(mod.args));
      else if (m === 'withoutmiddleware') {
        const drop = this.strings(mod.args);
        for (let i = middleware.length - 1; i >= 0; i--) if (drop.includes(middleware[i])) middleware.splice(i, 1);
      } else if (m === 'name' && mod.args[0]?.value.k === 'str') name = ctx.name + mod.args[0].value.v;
      else if (m.startsWith('where')) isConstrained = true;
      else if (m === 'can' && mod.args[0]?.value.k === 'str') middleware.push(`can:${mod.args[0].value.v}`);
    }
    const path = this.pathOf(uri);
    this.facts.routes.push({
      methods,
      paths: [...ctx.paths, path],
      middleware: [...new Set(middleware)],
      name,
      action: fixed ?? (action ? this.action(action, ctx) : undefined),
      constrained: isConstrained || undefined,
      trace: ctx.trace,
      pos,
      order: this.order++,
    });
  }

  private resource(args: PArg[], modifiers: { method: string; args: PArg[]; pos: Pos }[], ctx: Ctx, pos: Pos, api: boolean): void {
    const nameNode = args[0]?.value;
    if (!nameNode || nameNode.k !== 'str') return;
    const controller = args[1] ? this.className(args[1].value) : undefined;
    let only: string[] | undefined;
    let except: string[] = [];
    const parameters: Record<string, string> = {};
    let names: Record<string, string> = {};
    const middleware: string[] = [];
    const options = args[2]?.value;
    const readOptions = (arr: PNode): void => {
      if (arr.k !== 'arr') return;
      for (const it of arr.items) {
        const key = it.key?.k === 'str' ? it.key.v : undefined;
        if (key === 'only') only = this.strings([{ value: it.value }]);
        else if (key === 'except') except = this.strings([{ value: it.value }]);
        else if (key === 'parameters' && it.value.k === 'arr') {
          for (const p of it.value.items) if (p.key?.k === 'str' && p.value.k === 'str') parameters[p.key.v] = p.value.v;
        } else if (key === 'names' && it.value.k === 'arr') names = this.stringMap(it.value);
        else if (key === 'middleware') middleware.push(...this.strings([{ value: it.value }]));
      }
    };
    if (options) readOptions(options);
    let constrained = false;
    for (const mod of modifiers) {
      const m = mod.method.toLowerCase();
      if (m === 'only') only = this.strings(mod.args);
      else if (m === 'except') except = this.strings(mod.args);
      else if (m === 'middleware') middleware.push(...this.strings(mod.args));
      else if (m === 'parameters' && mod.args[0]?.value.k === 'arr') {
        for (const p of mod.args[0].value.items) if (p.key?.k === 'str' && p.value.k === 'str') parameters[p.key.v] = p.value.v;
      } else if (m === 'parameter' && mod.args[0]?.value.k === 'str' && mod.args[1]?.value.k === 'str') parameters[mod.args[0].value.v] = mod.args[1].value.v;
      else if (m === 'names' && mod.args[0]?.value.k === 'arr') names = this.stringMap(mod.args[0].value);
      else if (m.startsWith('where')) constrained = true;
    }
    // `photos.comments` → `photos/{photo}/comments/{comment}`
    const segments = nameNode.v.split('.');
    let base = '';
    for (let i = 0; i < segments.length - 1; i++) base += `/${segments[i]}/{${parameters[segments[i]] ?? paramName(segments[i])}}`;
    const last = segments[segments.length - 1];
    const param = parameters[last] ?? paramName(last);
    for (const a of RESOURCE_ACTIONS) {
      if (api && !a.api) continue;
      if (only && !only.includes(a.action)) continue;
      if (except.includes(a.action)) continue;
      this.facts.routes.push({
        methods: a.methods,
        paths: [...ctx.paths, { parts: [{ lit: `${base}/${last}${a.suffix(param)}` }] }],
        middleware: [...new Set([...ctx.middleware, ...middleware])],
        name: ctx.name + (names[a.action] ?? `${nameNode.v}.${a.action}`),
        action: controller ? { kind: 'controller', class: controller, method: a.action } : undefined,
        constrained: constrained || undefined,
        resource: { name: nameNode.v, action: a.action },
        trace: ctx.trace,
        pos,
        order: this.order++,
      });
    }
  }

  private singleton(args: PArg[], modifiers: { method: string; args: PArg[]; pos: Pos }[], ctx: Ctx, pos: Pos, api: boolean): void {
    const nameNode = args[0]?.value;
    if (!nameNode || nameNode.k !== 'str') return;
    const controller = args[1] ? this.className(args[1].value) : undefined;
    let only: string[] | undefined;
    let except: string[] = [];
    const middleware: string[] = [];
    for (const mod of modifiers) {
      const m = mod.method.toLowerCase();
      if (m === 'only') only = this.strings(mod.args);
      else if (m === 'except') except = this.strings(mod.args);
      else if (m === 'middleware') middleware.push(...this.strings(mod.args));
    }
    for (const a of SINGLETON_ACTIONS) {
      if ((api && !a.api) || (only && !only.includes(a.action)) || except.includes(a.action)) continue;
      this.facts.routes.push({
        methods: a.methods,
        paths: [...ctx.paths, { parts: [{ lit: `/${nameNode.v.replace(/\./g, '/')}${a.suffix}` }] }],
        middleware: [...new Set([...ctx.middleware, ...middleware])],
        name: `${ctx.name}${nameNode.v}.${a.action}`,
        action: controller ? { kind: 'controller', class: controller, method: a.action } : undefined,
        resource: { name: nameNode.v, action: a.action },
        trace: ctx.trace,
        pos,
        order: this.order++,
      });
    }
  }

  private action(n: PNode, ctx: Ctx): PhpActionFact | undefined {
    if (n.k === 'arr' && n.items[0]) {
      const cls = this.className(n.items[0].value);
      const method = n.items[1]?.value.k === 'str' ? n.items[1].value.v : '__invoke';
      return cls ? { kind: 'controller', class: cls, method } : undefined;
    }
    if (n.k === 'class') return { kind: 'controller', class: this.resolveClass(n.name), method: '__invoke' };
    if (n.k === 'str') {
      const at = n.v.indexOf('@');
      if (at > 0) return { kind: 'controller', class: ctx.namespace ? `${ctx.namespace}\\${n.v.slice(0, at)}` : this.resolveClass(n.v.slice(0, at)), method: n.v.slice(at + 1) };
      if (ctx.controller) return { kind: 'controller', class: ctx.controller, method: n.v };
      return undefined;
    }
    if (n.k === 'closure') {
      const body = new PhpBody(n.params, n.body);
      const formRequest = n.params.find((p) => p.type && /Request$/.test(p.type) && !/(^|\\)Request$/.test(p.type))?.type;
      return { kind: 'closure', pos: n.pos, body: body.facts(), formRequest: formRequest ? shortName(formRequest) : undefined, validates: body.validates || undefined };
    }
    // `['uses' => 'Ctrl@m', 'as' => 'name']` (old style)
    return undefined;
  }

  private className(n: PNode): string | undefined {
    if (n.k === 'class') return this.resolveClass(n.name);
    if (n.k === 'str') return n.v.replace(/^\\/, '');
    return undefined;
  }

  /** A URI as a path expression; variables and calls become dynamic parts. */
  private pathOf(n: PNode): PathExpr {
    const parts: PathPart[] = [];
    const add = (x: PNode): void => {
      if (x.k === 'str') parts.push(x.dyn ? { dynamic: `"${x.v}"` } : { lit: x.v });
      else if (x.k === 'concat') x.parts.forEach(add);
      else if (x.k === 'var') parts.push({ dynamic: `$${x.name}` });
      else if (x.k === 'sconst') parts.push({ dynamic: `${x.cls}::${x.name}` });
      else if (x.k === 'call') parts.push({ dynamic: `${x.name}()` });
      else parts.push({ dynamic: '(expression)' });
    };
    add(n);
    return compactExpr({ parts });
  }

  /** Strings from arguments: `'a'`, `['a', 'b']`, `'a', 'b'`, `Middleware::class`. */
  private strings(args: PArg[]): string[] {
    const out: string[] = [];
    const add = (n: PNode): void => {
      if (n.k === 'str') out.push(n.v);
      else if (n.k === 'class') out.push(shortName(n.name));
      else if (n.k === 'arr') n.items.forEach((it) => add(it.value));
      else if (n.k === 'concat' && n.parts.every((p) => p.k === 'str' || p.k === 'class')) out.push(n.parts.map((p) => (p.k === 'str' ? p.v : p.k === 'class' ? shortName(p.name) : '')).join(''));
    };
    for (const a of args) add(a.value);
    return out;
  }

  private stringMap(arr: Extract<PNode, { k: 'arr' }>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const it of arr.items) if (it.key?.k === 'str' && it.value.k === 'str') out[it.key.v] = it.value.v;
    return out;
  }

  private routing(e: Extract<PNode, { k: 'mcall' }>): void {
    const fact: NonNullable<PhpFileFacts['routing']> = { pos: e.pos };
    for (const a of e.args) {
      if (a.name === 'web' || a.name === 'api') {
        const target = includeTarget(a.value);
        if (target) fact[a.name] = target;
      } else if (a.name === 'apiPrefix' && a.value.k === 'str') fact.apiPrefix = a.value.v;
      else if (a.name === 'health' && a.value.k === 'str') fact.health = a.value.v;
    }
    this.facts.routing = fact;
  }

  /** `$this->getJson('/api/articles')`, `$this->json('POST', '/api/x')` in feature tests. */
  private testCall(e: PNode): void {
    if (e.k !== 'mcall') return;
    let base: PNode = e;
    while (base.k === 'mcall') base = base.target;
    if (base.k !== 'var' || base.name !== 'this') return;
    // The request itself is the innermost call on `$this` (assertions are chained after it).
    let n: PNode = e;
    while (n.k === 'mcall' && n.target.k === 'mcall') n = n.target;
    if (n.k !== 'mcall') return;
    const verb = /^(get|post|put|patch|delete|options)(Json)?$/i.exec(n.method);
    let method: HttpMethod | undefined;
    let uri: PNode | undefined;
    if (verb) {
      method = VERBS[verb[1].toLowerCase()];
      uri = n.args[0]?.value;
    } else if (n.method === 'json' && n.args[0]?.value.k === 'str') {
      method = VERBS[n.args[0].value.v.toLowerCase()];
      uri = n.args[1]?.value;
    }
    if (!method || !uri || (uri.k !== 'str' && uri.k !== 'concat')) return;
    const url = this.pathOf(uri);
    if (this.facts.clientCalls.some((c) => c.pos.line === n.pos.line && c.pos.column === n.pos.column)) return;
    const start = uri.pos;
    const text = uri.k === 'str' ? uri.v : exprText(url);
    this.facts.clientCalls.push({ client: 'Laravel test', method, url, pos: n.pos, start, end: { line: start.line, column: start.column + text.length + 2 } });
  }

}

// ---------------------------------------------------------------------------------------------
// Handler bodies: validation, responses, data access, risks
// ---------------------------------------------------------------------------------------------

class PhpBody {
  validates = false;
  private readonly requestVars = new Set<string>();
  private readonly modelParams = new Map<string, string>();
  private readonly env = new Map<string, PNode | null>();
  private readonly tainted = new Set<string>();
  private readonly responses: ResponseFact[] = [];
  private readonly risks: RiskFact[] = [];
  private readonly dataAccess = new Set<string>();
  private readsUser = false;
  private paramIdToData = false;
  private readsInput = false;

  constructor(
    private readonly params: PParam[],
    private readonly body: PStmt[],
  ) {
    for (const p of params) {
      if (p.type && /Request$/.test(p.type)) this.requestVars.add(p.name);
      else if (p.type && /^[A-Z]/.test(shortName(p.type)) && !SERVICE_TYPE.test(p.type) && !/^(int|string|bool|float|array|mixed|object|callable|iterable|self|static)$/i.test(p.type)) this.modelParams.set(p.name, shortName(p.type));
    }
    // Route model binding loads the record by the path parameter.
    if (this.modelParams.size) this.paramIdToData = true;
  }

  facts(): BodyFacts | undefined {
    walkStmts(this.body, (s) => {
      if (s.k === 'expr' && s.e.k === 'assign' && s.e.target.k === 'var') {
        const name = s.e.target.name;
        this.env.set(name, this.env.has(name) ? null : s.e.value);
      }
    });
    for (let i = 0; i < 3; i++) {
      for (const [name, value] of this.env) if (value && !this.tainted.has(name) && this.hasInput(value)) this.tainted.add(name);
    }
    walkStmts(this.body, (s, inCatch) => {
      if (s.k === 'return' && s.e) this.returned(s.e, inCatch);
      if (s.k === 'throw') this.thrown(s.e);
      if (s.k === 'expr' || s.k === 'return' || s.k === 'throw') if (s.e) walkNode(s.e, (n) => this.node(n, inCatch));
    });
    const out: BodyFacts = {};
    if (this.responses.length) out.responses = this.responses.slice(0, 24);
    if (this.risks.length) out.risks = this.risks.slice(0, 24);
    if (this.dataAccess.size) out.dataAccess = [...this.dataAccess].slice(0, 12);
    if (this.readsUser) out.readsUser = true;
    if (this.paramIdToData) out.paramIdToData = true;
    if (this.readsInput) out.readsInput = true;
    return Object.keys(out).length ? out : undefined;
  }

  private returned(e: PNode, inCatch: string | undefined): void {
    const r = this.response(e);
    if (r) {
      this.responses.push(r);
      if (inCatch) this.errorDetails(e, inCatch);
    }
  }

  private thrown(e: PNode): void {
    if (e.k === 'new' && /NotFound/.test(e.cls)) this.responses.push({ status: 404, via: 'throw', pos: e.pos });
    if (e.k === 'new' && /(Authorization|AccessDenied)/.test(e.cls)) this.responses.push({ status: 403, via: 'throw', pos: e.pos });
    if (e.k === 'new' && /Validation/.test(e.cls)) this.responses.push({ status: 422, via: 'throw', pos: e.pos });
  }

  /** `response()->json($data, 201)`, `response($data, 201)`, `response()->noContent()`, `return [...]`. */
  private response(e: PNode): ResponseFact | undefined {
    let n = e;
    let status: number | undefined;
    // Unwrap `->header()`, `->withHeaders()`, `->setStatusCode(n)`.
    while (n.k === 'mcall' && /^(header|withHeaders|cookie|withCookie|setStatusCode|setEncodingOptions)$/.test(n.method)) {
      if (n.method === 'setStatusCode') status = statusOf(n.args[0]?.value);
      n = n.target;
    }
    if (n.k === 'mcall' && n.target.k === 'call' && n.target.name === 'response') {
      if (n.method === 'json') return { status: status ?? statusOf(n.args[1]?.value), shape: n.args[0] ? this.shape(n.args[0].value, 0) : undefined, via: 'json', pos: n.pos };
      if (n.method === 'noContent') return { status: status ?? 204, via: 'status', pos: n.pos };
      if (n.method === 'download' || n.method === 'file' || n.method === 'stream' || n.method === 'streamDownload') return { status, via: 'send', pos: n.pos };
      return undefined;
    }
    if (n.k === 'call' && n.name === 'response') return { status: status ?? statusOf(n.args[1]?.value), shape: n.args[0] ? this.shape(n.args[0].value, 0) : undefined, via: 'send', pos: n.pos };
    if (n.k === 'call' && (n.name === 'redirect' || n.name === 'back' || n.name === 'view')) return n.name === 'view' ? undefined : { status: 302, via: 'status', pos: n.pos };
    if (n.k === 'mcall' && n.target.k === 'call' && n.target.name === 'redirect') return { status: 302, via: 'status', pos: n.pos };
    return { status, shape: this.shape(n, 0), via: 'return', pos: e.pos };
  }

  private node(n: PNode, inCatch: string | undefined): void {
    if (!this.readsInput && this.isInput(n) && !(n.k === 'mcall' && /^(route|header|cookie)$/.test(n.method))) this.readsInput = true;
    // Not-found and authorization outcomes.
    if (n.k === 'call' && (n.name === 'abort' || n.name === 'abort_if' || n.name === 'abort_unless')) {
      const status = statusOf(n.args[n.name === 'abort' ? 0 : 1]?.value);
      if (status) this.responses.push({ status, via: 'throw', pos: n.pos });
    }
    if ((n.k === 'mcall' || n.k === 'scall') && (n.method === 'findOrFail' || n.method === 'firstOrFail')) this.responses.push({ status: 404, via: 'throw', pos: n.pos });
    // Validation.
    if (n.k === 'mcall' && n.method === 'validate' && ((n.target.k === 'var' && (this.requestVars.has(n.target.name) || n.target.name === 'this')) || (n.target.k === 'call' && n.target.name === 'request'))) this.validates = true;
    if (n.k === 'scall' && shortName(n.cls) === 'Validator' && n.method === 'make') this.validates = true;
    if (n.k === 'call' && n.name === 'validator') this.validates = true;
    // The current user and authorization checks.
    if (n.k === 'mcall' && ((n.target.k === 'var' && this.requestVars.has(n.target.name) && n.method === 'user') || (n.target.k === 'call' && n.target.name === 'auth') || (n.target.k === 'var' && n.target.name === 'this' && /^authorize/.test(n.method)) || n.method === 'can' || n.method === 'cannot')) this.readsUser = true;
    if (n.k === 'scall' && ((shortName(n.cls) === 'Auth' && /^(user|id|check)$/.test(n.method)) || (shortName(n.cls) === 'Gate' && /^(authorize|allows|denies|inspect|check)$/.test(n.method)))) this.readsUser = true;
    // Data access.
    if (n.k === 'scall' && ELOQUENT.has(n.method) && /^[A-Z]/.test(shortName(n.cls)) && !NOT_MODELS.has(shortName(n.cls)) && !/^(self|static|parent)$/.test(n.cls)) {
      this.dataAccess.add(`${shortName(n.cls)}.${n.method}`);
      if (n.args.some((a) => a.value.k === 'var' && /id$/i.test(a.value.name) && this.params.some((p) => p.name === (a.value as { name: string }).name))) this.paramIdToData = true;
    }
    if (n.k === 'scall' && shortName(n.cls) === 'DB' && n.method === 'table') this.dataAccess.add(`DB.table`);
    if (n.k === 'mcall' && n.target.k === 'var' && this.modelParams.has(n.target.name) && ELOQUENT.has(n.method)) this.dataAccess.add(`${this.modelParams.get(n.target.name)}.${n.method}`);
    // Risks.
    const args = n.k === 'call' || n.k === 'scall' || n.k === 'mcall' || n.k === 'new' ? n.args : [];
    if ((n.k === 'scall' || n.k === 'mcall') && WRITE_METHODS.has(n.method) && args.some((a) => this.wholeInput(a.value))) {
      const label = n.k === 'scall' ? `${shortName(n.cls)}::${n.method}(…all())` : `->${n.method}(…all())`;
      this.risk('mass-assignment', n.pos, `${label} — unless $fillable or $guarded restrict the fields`, 'laravel');
    }
    if (n.k === 'new' && /^[A-Z]/.test(shortName(n.cls)) && args.some((a) => this.wholeInput(a.value))) this.risk('mass-assignment', n.pos, `new ${shortName(n.cls)}(…all())`, 'laravel');
    if (((n.k === 'scall' && shortName(n.cls) === 'DB' && SQL_STATIC.has(n.method)) || (n.k === 'mcall' && SQL_METHODS.has(n.method))) && args[0] && this.builtWithInput(args[0].value)) {
      this.risk('injection', n.pos, `${n.k === 'scall' ? `DB::${n.method}` : `->${n.method}`}("…" . $input)`, 'sql');
    }
    if (n.k === 'call' && COMMANDS.has(n.name) && args[0] && this.hasInput(args[0].value)) this.risk('injection', n.pos, `${n.name}(… request input …)`, 'command');
    if (n.k === 'call' && n.name === 'eval' && args[0] && this.hasInput(args[0].value)) this.risk('injection', n.pos, 'eval(… request input …)', 'code');
    if (((n.k === 'call' && n.name === 'redirect') || (n.k === 'mcall' && n.target.k === 'call' && n.target.name === 'redirect' && (n.method === 'to' || n.method === 'away'))) && args[0] && this.hasInput(args[0].value)) {
      this.risk('open-redirect', n.pos, `redirect(${n.k === 'mcall' ? `)->${n.method}(` : ''}… request input …)`);
    }
    if (((n.k === 'call' && FILES.has(n.name)) || (n.k === 'scall' && shortName(n.cls) === 'Storage' && /^(get|download|delete|path|readStream)$/.test(n.method)) || (n.k === 'mcall' && n.target.k === 'call' && n.target.name === 'response' && (n.method === 'download' || n.method === 'file'))) && args[0] && this.hasInput(args[0].value)) {
      this.risk('path-traversal', n.pos, `${n.k === 'call' ? n.name : n.k === 'scall' ? `Storage::${n.method}` : `response()->${n.method}`}(… request input …)`);
    }
    if (inCatch && n.k === 'mcall' && n.target.k === 'call' && n.target.name === 'response' && n.method === 'json') this.errorDetails(n, inCatch);
  }

  /** Exception messages or traces in a response built inside `catch (Exception $e)`. */
  private errorDetails(e: PNode, errVar: string): void {
    let detail: string | undefined;
    walkNode(e, (n) => {
      if (n.k === 'mcall' && n.target.k === 'var' && n.target.name === errVar) {
        if (/^getTrace/.test(n.method)) detail = 'stack';
        else if ((n.method === 'getMessage' || n.method === 'getFile' || n.method === 'getLine') && detail !== 'stack') detail = 'message';
      }
    });
    if (detail) this.risk('error-details', e.pos, `response()->json([… $${errVar}->${detail === 'stack' ? 'getTraceAsString' : 'getMessage'}() …])`, detail);
  }

  private risk(rule: RiskFact['rule'], pos: Pos, evidence: string, detail?: string): void {
    if (this.risks.some((r) => r.rule === rule && r.pos.line === pos.line)) return;
    this.risks.push({ rule, pos, evidence, detail });
  }

  /** `$request->input('x')`, `$request->title`, `request('x')`, `$_GET[...]`, or a tainted local. */
  private isInput(n: PNode): boolean {
    if (n.k === 'var') return this.tainted.has(n.name) || /^_(GET|POST|REQUEST|COOKIE)$/.test(n.name);
    if (n.k === 'mcall' && n.target.k === 'var' && this.requestVars.has(n.target.name) && INPUT_METHODS.has(n.method)) return true;
    if (n.k === 'prop' && n.target.k === 'var' && this.requestVars.has(n.target.name)) return true;
    if (n.k === 'call' && n.name === 'request' && n.args.length > 0) return true;
    if (n.k === 'mcall' && n.target.k === 'call' && n.target.name === 'request' && INPUT_METHODS.has(n.method)) return true;
    if (n.k === 'index' && n.target.k === 'var' && /^_(GET|POST|REQUEST|COOKIE)$/.test(n.target.name)) return true;
    return false;
  }

  private hasInput(n: PNode): boolean {
    let found = false;
    walkNode(n, (x) => {
      if (!found && x.k !== 'closure' && this.isInput(x)) found = true;
      if (!found && x.k === 'str' && x.dyn && (/\$(request|_GET|_POST|_REQUEST)\b/.test(x.v) || [...this.tainted].some((t) => x.v.includes(`$${t}`)))) found = true;
    });
    return found;
  }

  /** A string built with `.` or interpolation that contains request input. */
  private builtWithInput(n: PNode): boolean {
    return (n.k === 'concat' || (n.k === 'str' && n.dyn) || (n.k === 'var' && this.tainted.has(n.name))) && this.hasInput(n);
  }

  /** `$request->all()`, `$request->input()`, `request()->all()`. */
  private wholeInput(n: PNode): boolean {
    if (n.k === 'mcall' && WHOLE_INPUT.has(n.method) && n.args.length === 0) {
      if (n.target.k === 'var' && this.requestVars.has(n.target.name)) return true;
      if (n.target.k === 'call' && n.target.name === 'request') return true;
    }
    if (n.k === 'call' && n.name === 'request' && n.args.length === 0) return false;
    if (n.k === 'var') {
      const init = this.env.get(n.name);
      return !!init && this.wholeInput(init);
    }
    return false;
  }

  shape(n: PNode, depth: number): Shape {
    if (depth > MAX_DEPTH) return { t: 'unknown' };
    switch (n.k) {
      case 'arr': {
        if (n.items.length === 0) return { t: 'array' };
        const keyed = n.items.every((it) => it.key?.k === 'str' || it.key?.k === 'num');
        if (n.items.every((it) => !it.key && !it.spread)) return { t: 'array', items: this.shape(n.items[0].value, depth + 1) };
        const props: Record<string, ShapeProp> = Object.create(null) as Record<string, ShapeProp>;
        let open = !keyed;
        for (const it of n.items) {
          if (it.spread) {
            const inner = this.shape(it.value, depth + 1);
            if (inner.t === 'object') Object.assign(props, inner.props);
            open = open || inner.t !== 'object' || !!inner.open;
            continue;
          }
          if (it.key?.k !== 'str') continue;
          props[it.key.v] = { shape: this.shape(it.value, depth + 1), src: srcText(it.value) };
        }
        const shape: Shape = { t: 'object', props };
        if (open) shape.open = true;
        return shape;
      }
      case 'str':
      case 'concat':
        return { t: 'string' };
      case 'num':
        return { t: 'number' };
      case 'name':
        if (/^(true|false)$/i.test(n.name)) return { t: 'boolean' };
        if (/^null$/i.test(n.name)) return { t: 'null' };
        return { t: 'unknown', expr: n.name };
      case 'bin':
        if (['==', '===', '!=', '!==', '<', '>', '<=', '>=', '&&', '||', 'and', 'or', 'instanceof'].includes(n.op)) return { t: 'boolean' };
        if (['+', '-', '*', '/', '%', '**'].includes(n.op)) return { t: 'number' };
        return { t: 'unknown' };
      case 'var': {
        const init = this.env.get(n.name);
        return init ? this.shape(init, depth + 1) : { t: 'unknown', expr: `$${n.name}` };
      }
      case 'call':
        if (/^(count|intval|floatval|strlen|round|abs)$/.test(n.name)) return { t: 'number' };
        if (/^(strval|trim|ucfirst|strtolower|strtoupper|__|trans|route|url|now)$/.test(n.name)) return { t: 'string' };
        if (/^(boolval|is_\w+)$/.test(n.name)) return { t: 'boolean' };
        return { t: 'unknown', expr: `${n.name}()` };
      case 'new':
        return { t: 'unknown', expr: shortName(n.cls) };
      case 'scall':
        return { t: 'unknown', expr: `${shortName(n.cls)}::${n.method}()` };
      case 'mcall':
        if (/^(count|sum|avg|max|min)$/.test(n.method)) return { t: 'number' };
        if (/^(toDateString|toDateTimeString|toIso8601String|format|toJson)$/.test(n.method)) return { t: 'string' };
        return { t: 'unknown', expr: srcText(n) };
      default:
        return { t: 'unknown', expr: srcText(n) };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** `$this->users->find($id)` with `users` an injected dependency. */
function serviceCalls(body: PStmt[], deps: Record<string, string>): ServiceCall[] {
  const out: ServiceCall[] = [];
  const seen = new Set<string>();
  walkStmts(body, (s) => {
    if (s.k !== 'expr' && s.k !== 'return') return;
    walkNode(s.e, (n) => {
      if (n.k !== 'mcall' || n.target.k !== 'prop' || n.target.target.k !== 'var' || n.target.target.name !== 'this') return;
      const prop = n.target.name;
      const type = Object.prototype.hasOwnProperty.call(deps, prop) ? deps[prop] : undefined;
      if (!type) return;
      const key = `${prop}.${n.method}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ receiver: `this.${prop}`, method: n.method, type });
    });
  });
  return out;
}

/** `base_path('routes/x.php')`, `__DIR__.'/x.php'`, `dirname(__DIR__).'/routes/x.php'`, `'routes/x.php'`. */
function includeTarget(n: PNode): PhpIncludeFact['target'] | undefined {
  if (n.k === 'call' && n.name === 'base_path' && n.args[0]?.value.k === 'str') return { base: 'project', path: n.args[0].value.v.replace(/^\//, '') };
  if (n.k === 'str') return n.v.endsWith('.php') ? { base: 'project', path: n.v.replace(/^\//, '') } : undefined;
  if (n.k === 'concat' && n.parts.length === 2 && n.parts[1].k === 'str') {
    const head = n.parts[0];
    const rest = n.parts[1].v.replace(/^\//, '');
    if (head.k === 'name' && head.name === '__DIR__') return { base: 'dir', path: rest };
    if (head.k === 'call' && head.name === 'dirname' && head.args[0]?.value.k === 'name' && head.args[0].value.name === '__DIR__') return { base: 'dir', path: `../${rest}` };
    if (head.k === 'call' && head.name === 'base_path' && head.args.length === 0) return { base: 'project', path: rest };
  }
  return undefined;
}

function statusOf(n: PNode | undefined): number | undefined {
  if (!n) return undefined;
  if (n.k === 'num') return n.v;
  if (n.k === 'sconst') return STATUS_NAMES[n.name];
  return undefined;
}

/** Laravel's parameter name for a resource: `categories` → `category`, `blog-posts` → `blog_post`. */
export function paramName(resource: string): string {
  const snake = resource.replace(/-/g, '_');
  const parts = snake.split('_');
  parts[parts.length - 1] = singular(parts[parts.length - 1]);
  return parts.join('_');
}

function singular(word: string): string {
  if (/ies$/i.test(word) && word.length > 3) return word.slice(0, -3) + 'y';
  if (/(ss|us|is)$/i.test(word)) return word;
  if (/(ss|x|ch|sh|zz)es$/i.test(word) || /uses$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word) && word.length > 1) return word.slice(0, -1);
  return word;
}

function shortName(fqn: string): string {
  return fqn.replace(/^\\/, '').split('\\').pop()!;
}

function exprText(e: PathExpr): string {
  return e.parts.map((p) => ('lit' in p ? p.lit : 'dynamic' in p ? `\${${p.dynamic}}` : 'ref' in p ? p.ref : '')).join('');
}

/** `$user->name` → `user.name`, `$user['name']` → `user.name`, for rename detection. */
function srcText(n: PNode): string | undefined {
  if (n.k === 'var') return n.name;
  if (n.k === 'prop') {
    const base = srcText(n.target);
    return base ? `${base}.${n.name}` : undefined;
  }
  if (n.k === 'index' && n.index?.k === 'str') {
    const base = srcText(n.target);
    return base ? `${base}.${n.index.v}` : undefined;
  }
  if (n.k === 'mcall') {
    const base = srcText(n.target);
    return base ? `${base}.${n.method}()` : undefined;
  }
  return undefined;
}
