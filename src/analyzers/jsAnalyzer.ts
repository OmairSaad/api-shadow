/**
 * Extracts Express and NestJS facts from a single JavaScript/TypeScript file using the Babel AST.
 * Nothing here executes code: everything is derived from syntax.
 */
import type * as t from '@babel/types';
import type { HttpMethod, PathExpr, PathPart, ServiceCall } from '../core/types';
import { compactExpr } from '../core/paths';
import {
  forEachChild,
  isFunctionLike,
  keyName,
  memberText,
  parseJs,
  posOf,
  propName,
  shortLabel,
  typeNameOf,
  unwrap,
  type Node,
} from './babelUtils';
import type {
  BodyFacts,
  CallableFact,
  ClassFact,
  ClientCallFact,
  ExpressRouteFact,
  HandlerFact,
  JsFileFacts,
  NestControllerFact,
  NestMethodFact,
  NestParamFact,
  NestRouterModuleRoute,
  RefExpr,
  RouterLib,
} from './facts';
import { own, table } from '../core/records';
import { analyzeBody, handlerParams, looksLikeHandler } from './jsBody';
import { analyzeConsumers } from './jsConsumers';
import { corsRisks, exportedTypes } from './jsFileScan';

const EXPRESS_METHODS = table<HttpMethod>({
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
  del: 'DELETE',
  options: 'OPTIONS',
  head: 'HEAD',
  all: 'ALL',
});

const NEST_METHOD_DECORATORS = table<HttpMethod>({
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  Options: 'OPTIONS',
  Head: 'HEAD',
  All: 'ALL',
});

const NEST_MIDDLEWARE_DECORATORS = new Set(['UseGuards', 'UseInterceptors', 'UsePipes', 'UseFilters']);
const EXPRESS_TYPE_NAMES = new Set(['Router', 'Express', 'Application', 'IRouter']);
/** Router-typed parameters from other libraries: Fastify plugins and Koa routers. */
const ROUTER_TYPE_NAMES: Record<string, Set<string>> = {
  express: EXPRESS_TYPE_NAMES,
  fastify: new Set(['FastifyInstance', 'FastifyPluginAsync', 'FastifyPluginCallback']),
  '@koa/router': new Set(['Router']),
  'koa-router': new Set(['Router']),
};
const ROUTER_PARAM_NAME = /^(app|router|api|server|expressApp|routes|r|fastify|instance|koaRouter)$/;
const CLIENT_LIBS: Record<string, string> = { axios: 'axios', ky: 'ky', superagent: 'superagent', supertest: 'supertest', got: 'got', ofetch: 'ofetch', 'node-fetch': 'fetch', 'cross-fetch': 'fetch', 'isomorphic-fetch': 'fetch' };
/** Global or framework-provided fetch functions. */
const FETCH_FUNCTIONS = new Set(['fetch', '$fetch', 'useFetch', 'ofetch', 'useLazyFetch']);
/** Names of imported API client instances (`import { api } from './api'`); their base URL is not visible. */
const CLIENT_NAME = /^(api|apiClient|http|httpClient|client|axiosInstance|instance|\$http|backend|request|requests|fetcher)$/i;
const HTTP_VERBS: Record<string, HttpMethod> = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', delete: 'DELETE', del: 'DELETE', head: 'HEAD', options: 'OPTIONS' };
/** Arguments that look like request data rather than a route handler. */
const DATA_ARG = /^(data|body|payload|params|config|options|opts|form|formData|values|input|dto|query|headers|item|user|.*(Data|Body|Payload|Dto|Params|Config|Options|Input|Request))$/;
const NON_SERVICE_RECEIVERS = new Set(['req', 'res', 'next', 'request', 'response', 'console', 'JSON', 'Math', 'Promise', 'Object', 'Array', 'Date', 'Number', 'String']);
const SERVICE_NAME = /(service|services|repository|repositories|repo|dao|usecase|useCase|provider|manager|gateway|client|store)$/i;
const SERVICE_SOURCE = /(\/|^)(services?|repositor(y|ies)|daos?|use-?cases?|providers?)(\/|$)|[./-](service|repository|repo|dao)(\.[cm]?[jt]sx?)?$/i;

/** Imports of project modules that usually wrap HTTP calls (`./api`, `@/services/user`, `../hooks/useUser`). */
const CONSUMER_IMPORT = /(from\s*|require\(\s*)['"](\.|[@~#]\/)[^'"]*(api|service|client|request|http|fetch|quer(y|ies)|hooks?\/use)[^'"]*['"]/i;

/** Quick textual check used to decide whether a file is worth parsing. */
export function isJsCandidate(source: string): boolean {
  return (
    /express|fastify|koa|@nestjs\/|Router\s*\(|\.use\s*\(|\.listen\s*\(|\.(get|post|put|patch|delete|all|del)\s*\(\s*['"`/]|\bfetch\s*\(|axios|HttpClient|supertest|\bky\b/.test(source) ||
    // Components and hooks that call API service modules: their reads of response fields count.
    CONSUMER_IMPORT.test(source)
  );
}

type Binding =
  | { kind: 'router'; key: string }
  | { kind: 'fn'; key: string }
  | { kind: 'class'; name: string }
  | { kind: 'instance'; className: string }
  | { kind: 'alias'; ref: RefExpr }
  | { kind: 'const'; expr: PathExpr }
  | { kind: 'shadow' };

/** The HTTP method a constant names (`'POST'`, `'delete'`), if it is one. */
function verbOf(expr: PathExpr | undefined): HttpMethod | undefined {
  const part = expr?.parts.length === 1 ? expr.parts[0] : undefined;
  return part && 'lit' in part ? own(HTTP_VERBS, part.lit.toLowerCase()) : undefined;
}

class Scope {
  private readonly bindings = new Map<string, Binding>();
  constructor(readonly parent?: Scope) {}
  set(name: string, binding: Binding): void {
    this.bindings.set(name, binding);
  }
  get(name: string): Binding | undefined {
    return this.bindings.get(name) ?? this.parent?.get(name);
  }
  hasOwn(name: string): boolean {
    return this.bindings.has(name);
  }
  /** Constant bindings named `prefix.<rest>` visible from this scope, keyed by `<rest>`. */
  constsUnder(prefix: string): Map<string, PathExpr> {
    const out = this.parent?.constsUnder(prefix) ?? new Map<string, PathExpr>();
    for (const [name, b] of this.bindings) {
      if (b.kind === 'const' && name.startsWith(prefix + '.')) out.set(name.slice(prefix.length + 1), b.expr);
    }
    return out;
  }
}

interface ClassContext {
  name: string;
  /** Map of `this.x` property names to bindings (router created as class field). */
  members: Map<string, Binding>;
  deps: Record<string, string>;
}

export function analyzeJs(source: string, filePath: string): JsFileFacts {
  return new JsAnalyzer(source, filePath).run();
}

class JsAnalyzer {
  private readonly facts: JsFileFacts = {
    lang: 'js',
    imports: {},
    exports: {},
    starExports: [],
    routers: [],
    routes: [],
    mounts: [],
    injections: [],
    callables: {},
    classes: {},
    nestControllers: [],
    nestModules: [],
    nestRouterModule: [],
    nestGlobalGuards: [],
    nestGlobalPipes: [],
    clientCalls: [],
    consumers: [],
    risks: [],
    types: {},
    constants: {},
    issues: [],
  };
  /** Function nodes of callables, for the consumer analysis. */
  private readonly callableNodes = new Map<Node, string>();
  private readonly fileScope = new Scope();
  /** Local names bound to the `express` default/namespace import. */
  private readonly expressNames = new Set<string>();
  /** Local names bound to `Router` from express. */
  private readonly routerFactoryNames = new Set<string>();
  /** Factories and constructors from other router libraries. */
  private readonly fastifyNames = new Set<string>();
  private readonly koaAppNames = new Set<string>();
  private readonly koaRouterNames = new Set<string>();
  private readonly fastifyPluginNames = new Set<string>();
  /** local name -> HTTP client library (`axios`, `ky`, `supertest`, ...). */
  private readonly clientLibs = new Map<string, string>();
  /** Variables holding an axios instance, with its `baseURL` when known. */
  private readonly clientInstances = new Map<string, { client: string; base?: PathExpr }>();
  /** Inline plugin functions given to `register()`, whose first parameter is the instance. */
  private readonly pluginFunctions = new Set<Node>();
  /** local name -> imported name for `@nestjs/common` (and `@nestjs/core`) bindings. */
  private readonly nestNames = new Map<string, string>();
  private readonly nestNamespaces = new Set<string>();
  private usesNest = false;
  private order = 0;
  private routerSeq = 0;
  private readonly pendingExports: { name: string; node: Node; scope: Scope }[] = [];
  private classStack: ClassContext[] = [];
  /** Routers created inline without a variable (`Router().use(...)`), keyed by AST node. */
  private readonly anonymousRouters = new Map<Node, string>();
  /** Constants that evaluate to a port number (`const PORT = process.env.PORT || 3000`). */
  private readonly portConsts = new Map<string, number>();

  constructor(
    private readonly source: string,
    private readonly filePath: string,
  ) {}

  run(): JsFileFacts {
    const parsed = parseJs(this.source, this.filePath);
    this.facts.issues.push(...parsed.issues);
    if (!parsed.ast) return this.facts;
    const program = parsed.ast.program;
    this.collectImports(program);
    this.hoist(program.body, this.fileScope);
    for (const stmt of program.body) this.walk(stmt, this.fileScope);
    for (const pending of this.pendingExports) {
      const ref = this.refOf(pending.node, pending.scope);
      if (ref) this.facts.exports[pending.name] = ref;
      this.recordConstantExport(pending.name, pending.node, pending.scope);
    }
    const consumers = analyzeConsumers(program, this.facts, this.callableNodes);
    for (const [key, returnsBody] of consumers.returns) {
      const callable = own(this.facts.callables, key);
      if (callable) callable.returnsBody = returnsBody;
    }
    this.facts.risks.push(...corsRisks(program, this.facts.imports));
    Object.assign(this.facts.types, exportedTypes(program));
    return this.facts;
  }

  /** Records string constants reachable through an export, so other files' paths can use them. */
  private recordConstantExport(exportName: string, node: Node, scope: Scope): void {
    // `module.exports = ROUTES` is imported as a whole; its members are top-level keys.
    const prefix = exportName === '*cjs' ? '' : exportName;
    const key = (rest: string): string => (prefix ? `${prefix}.${rest}` : rest);
    const n = unwrap(node);
    const value = this.constPath(n, scope);
    if (value && prefix) this.facts.constants[prefix] = value;
    if (n.type === 'Identifier') {
      for (const [rest, expr] of scope.constsUnder(n.name)) this.facts.constants[key(rest)] = expr;
    } else if (n.type === 'ObjectExpression') {
      for (const [rest, expr] of this.objectConstants(n, scope)) this.facts.constants[key(rest)] = expr;
    }
  }

  /** String constants in an object literal, nested keys joined by dots: `{ A: { B: '/b' } }` → `A.B`. */
  private objectConstants(node: Node, scope: Scope): Map<string, PathExpr> {
    const out = new Map<string, PathExpr>();
    let n = unwrap(node);
    // `Object.freeze({ ... })`
    if (n.type === 'CallExpression' && memberText(n.callee as Node) === 'Object.freeze' && n.arguments[0]) n = unwrap(n.arguments[0] as Node);
    if (n.type !== 'ObjectExpression') return out;
    for (const prop of n.properties) {
      if (prop.type !== 'ObjectProperty') continue;
      const key = keyName(prop.key);
      if (!key) continue;
      const value = this.constPath(prop.value as Node, scope);
      if (value) out.set(key, value);
      for (const [rest, expr] of this.objectConstants(prop.value as Node, scope)) out.set(`${key}.${rest}`, expr);
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Imports
  // -------------------------------------------------------------------------------------------

  private collectImports(program: t.Program): void {
    for (const stmt of program.body) {
      if (stmt.type === 'ImportDeclaration') {
        const source = stmt.source.value;
        for (const spec of stmt.specifiers) {
          const local = spec.local.name;
          if (spec.type === 'ImportDefaultSpecifier') this.addImport(local, source, 'default');
          else if (spec.type === 'ImportNamespaceSpecifier') this.addImport(local, source, '*');
          else {
            const imported = spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value;
            this.addImport(local, source, imported);
          }
        }
      } else if (stmt.type === 'TSImportEqualsDeclaration' && stmt.moduleReference.type === 'TSExternalModuleReference') {
        this.addImport(stmt.id.name, stmt.moduleReference.expression.value, '*cjs');
      }
    }
    // CommonJS requires anywhere at top level (and nested `const x = require()`), collected during walk.
  }

  private addImport(local: string, source: string, name: string): void {
    this.facts.imports[local] = { source, name };
    if (source === 'express') {
      if (name === 'default' || name === '*' || name === '*cjs') this.expressNames.add(local);
      if (name === 'Router') this.routerFactoryNames.add(local);
    }
    if (source.startsWith('@nestjs/')) {
      this.usesNest = true;
      if (name === '*' || name === '*cjs' || name === 'default') this.nestNamespaces.add(local);
      else this.nestNames.set(local, name);
    }
    const whole = name === 'default' || name === '*cjs' || name === '*';
    if (source === 'fastify' && (whole || name === 'fastify' || name === 'Fastify')) this.fastifyNames.add(local);
    if (source === 'koa' && (whole || name === 'Koa')) this.koaAppNames.add(local);
    if ((source === '@koa/router' || source === 'koa-router') && (whole || name === 'Router')) this.koaRouterNames.add(local);
    if (source === 'fastify-plugin' && (whole || name === 'fastifyPlugin')) this.fastifyPluginNames.add(local);
    const client = CLIENT_LIBS[source];
    if (client && (whole || name === 'fetch' || name === 'ofetch' || name === '$fetch' || name === 'request')) this.clientLibs.set(local, client);
  }

  private requireSource(node: Node): string | undefined {
    const n = unwrap(node);
    if (
      n.type === 'CallExpression' &&
      n.callee.type === 'Identifier' &&
      n.callee.name === 'require' &&
      n.arguments.length === 1 &&
      n.arguments[0].type === 'StringLiteral'
    ) {
      return n.arguments[0].value;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------------------------
  // Hoisting: function declarations and arrow-function constants are callable before definition.
  // -------------------------------------------------------------------------------------------

  private hoist(body: Node[], scope: Scope): void {
    for (const raw of body) {
      let stmt: Node = raw;
      if ((stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') && stmt.declaration) {
        stmt = stmt.declaration;
      }
      if (stmt.type === 'FunctionDeclaration' && stmt.id) {
        scope.set(stmt.id.name, { kind: 'fn', key: this.callableKey(stmt.id.name, stmt, scope) });
      } else if (stmt.type === 'ClassDeclaration' && stmt.id) {
        scope.set(stmt.id.name, { kind: 'class', name: stmt.id.name });
      } else if (stmt.type === 'VariableDeclaration') {
        for (const decl of stmt.declarations) {
          if (decl.id.type === 'Identifier' && decl.init) {
            const init = unwrap(decl.init);
            if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
              scope.set(decl.id.name, { kind: 'fn', key: this.callableKey(decl.id.name, init, scope) });
            }
          }
        }
      }
    }
  }

  private callableKey(name: string, node: Node, scope: Scope): string {
    return scope === this.fileScope ? name : `${name}@${posOf(node).line}`;
  }

  // -------------------------------------------------------------------------------------------
  // Walk
  // -------------------------------------------------------------------------------------------

  private walk(node: Node, scope: Scope, nameHint?: string): void {
    switch (node.type) {
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'ObjectMethod':
        // Plugins given to `register()` were visited there, with their instance parameter.
        if (!this.pluginFunctions.has(node)) this.visitFunction(node, scope, nameHint);
        return;
      case 'ClassDeclaration':
      case 'ClassExpression':
        this.visitClass(node, scope, nameHint);
        return;
      case 'VariableDeclarator':
        this.visitDeclarator(node, scope);
        return;
      case 'AssignmentExpression':
        this.visitAssignment(node, scope);
        return;
      case 'CallExpression':
      case 'OptionalCallExpression':
        this.visitCall(node, scope);
        break;
      case 'ExportNamedDeclaration':
        this.visitExportNamed(node, scope);
        return;
      case 'ExportDefaultDeclaration':
        this.visitExportDefault(node, scope);
        return;
      case 'ExportAllDeclaration':
        this.facts.starExports.push(node.source.value);
        return;
      case 'TSExportAssignment':
        this.pendingExports.push({ name: '*cjs', node: node.expression, scope });
        return;
      case 'BlockStatement':
        this.hoist(node.body, scope);
        break;
      case 'TSEnumDeclaration':
        // `enum Routes { USERS = '/users' }`: members are constants like object properties.
        for (const member of node.members) {
          const key = keyName(member.id as Node);
          const value = member.initializer ? this.constPath(member.initializer as Node, scope) : undefined;
          if (key && value) scope.set(`${node.id.name}.${key}`, { kind: 'const', expr: value });
        }
        return;
      default:
        break;
    }
    forEachChild(node, (child) => this.walk(child, scope));
  }

  private visitDeclarator(node: t.VariableDeclarator, scope: Scope): void {
    const init = node.init ? unwrap(node.init) : undefined;
    if (node.id.type === 'ObjectPattern' && init) {
      const src = this.requireSource(init);
      if (src) {
        for (const prop of node.id.properties) {
          if (prop.type === 'ObjectProperty' && prop.value.type === 'Identifier') {
            const imported = keyName(prop.key);
            if (imported) this.addImport(prop.value.name, src, imported);
          }
        }
        return;
      }
      // `const { Router } = express;`
      if (init.type === 'Identifier' && this.expressNames.has(init.name)) {
        for (const prop of node.id.properties) {
          if (prop.type === 'ObjectProperty' && prop.value.type === 'Identifier' && keyName(prop.key) === 'Router') {
            this.routerFactoryNames.add(prop.value.name);
          }
        }
      }
    }
    if (node.id.type !== 'Identifier') {
      if (init) this.walk(init, scope);
      return;
    }
    const name = node.id.name;
    if (!init) {
      if (!scope.hasOwn(name)) scope.set(name, { kind: 'shadow' });
      return;
    }
    const port = this.portValue(init);
    if (port !== undefined) this.portConsts.set(name, port);
    const src = this.requireSource(init);
    if (src) {
      this.addImport(name, src, '*cjs');
      return;
    }
    // `const Router = require('express').Router`
    if (init.type === 'MemberExpression') {
      const objSrc = this.requireSource(init.object);
      const prop = propName(init);
      if (objSrc && prop) {
        this.addImport(name, objSrc, prop === 'default' ? 'default' : prop);
        return;
      }
    }
    // `const api = axios.create({ baseURL: '/api' })`
    if (init.type === 'CallExpression' && unwrap(init.callee as Node).type === 'MemberExpression') {
      const c = unwrap(init.callee as Node) as t.MemberExpression;
      const objName = unwrap(c.object).type === 'Identifier' ? (unwrap(c.object) as t.Identifier).name : undefined;
      const lib = objName ? this.clientLibs.get(objName) : undefined;
      if (lib && (propName(c) === 'create' || propName(c) === 'extend')) {
        const baseNode = this.objectProp(init.arguments[0] as Node | undefined, 'baseURL') ?? this.objectProp(init.arguments[0] as Node | undefined, 'prefixUrl');
        const base = baseNode ? (this.constPath(baseNode, scope) ?? this.importRef(baseNode, scope) ?? { parts: [{ dynamic: memberText(baseNode) ?? shortLabel(baseNode) }] }) : undefined;
        this.clientInstances.set(name, { client: lib, base });
        scope.set(name, { kind: 'shadow' });
        this.walk(init, scope);
        return;
      }
    }
    const creation = this.routerCreation(init);
    if (creation) {
      const key = this.addRouter(name, creation, init, scope);
      scope.set(name, { kind: 'router', key });
      this.walk(init, scope);
      return;
    }
    if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
      this.visitFunction(init, scope, name);
      return;
    }
    const pathExpr = this.constPath(init, scope);
    if (pathExpr) {
      scope.set(name, { kind: 'const', expr: pathExpr });
      return;
    }
    if (init.type === 'ObjectExpression' && scope === this.fileScope && !own(this.facts.classes, name) && init.properties.some((p) => p.type === 'ObjectMethod' || (p.type === 'ObjectProperty' && isFunctionLike(unwrap(p.value as Node))))) {
      this.objectModule(name, init, scope);
      return;
    }
    // `const ROUTES = { USERS: '/users', ADMIN: { STATS: '/admin/stats' } }`, optionally frozen.
    for (const [key, value] of this.objectConstants(init, scope)) scope.set(`${name}.${key}`, { kind: 'const', expr: value });
    if (init.type === 'NewExpression' && init.callee.type === 'Identifier') {
      scope.set(name, { kind: 'instance', className: init.callee.name });
      this.walk(init, scope);
      return;
    }
    const ref = this.refOf(init, scope);
    scope.set(name, ref ? { kind: 'alias', ref } : { kind: 'shadow' });
    this.walk(init, scope);
  }

  /**
   * `const userService = { async getUser(id) { … } }`: methods become callables of a class-like
   * record, so `userService.getUser()` resolves from other files like a class instance.
   */
  private objectModule(name: string, init: t.ObjectExpression, scope: Scope): void {
    const cls: ClassFact = { name, pos: posOf(init), methods: {}, deps: {} };
    this.facts.classes[name] = cls;
    scope.set(name, { kind: 'instance', className: name });
    for (const [key, value] of this.objectConstants(init, scope)) scope.set(`${name}.${key}`, { kind: 'const', expr: value });
    for (const prop of init.properties) {
      if (prop.type === 'SpreadElement') {
        this.walk(prop.argument, scope);
        continue;
      }
      const key = keyName(prop.key);
      const fn = prop.type === 'ObjectMethod' ? prop : unwrap(prop.value as Node);
      if (key && isFunctionLike(fn)) {
        const fnKey = `${name}.${key}`;
        this.visitFunction(fn, scope, key, fnKey);
        cls.methods[key] = fnKey;
      } else if (prop.type === 'ObjectProperty') {
        this.walk(prop.value as Node, scope);
      }
    }
  }

  private addRouter(name: string, kind: 'app' | 'router', node: Node, scope: Scope): string {
    const base = scope === this.fileScope ? name : `${name}@${posOf(node).line}`;
    const key = this.facts.routers.some((r) => r.key === base) ? `${base}#${++this.routerSeq}` : base;
    const n = unwrap(node);
    const lib = this.routerLib(n);
    // Koa: `new Router({ prefix: '/api' })`
    const prefixArg = lib === 'koa' && (n.type === 'NewExpression' || n.type === 'CallExpression') ? this.objectProp(n.arguments[0] as Node | undefined, 'prefix') : undefined;
    const prefix = prefixArg ? (this.constPath(prefixArg, scope) ?? this.importRef(prefixArg, scope)) : undefined;
    this.facts.routers.push({ key, kind, name, pos: posOf(node), lib, prefix });
    return key;
  }

  private routerLib(n: Node): RouterLib {
    if (n.type !== 'CallExpression' && n.type !== 'NewExpression') return 'express';
    const callee = unwrap(n.callee as Node);
    if (callee.type === 'Identifier' && this.fastifyNames.has(callee.name)) return 'fastify';
    if (callee.type === 'Identifier' && (this.koaAppNames.has(callee.name) || this.koaRouterNames.has(callee.name))) return 'koa';
    const src = this.requireSource(callee);
    if (src === 'fastify') return 'fastify';
    if (src === 'koa' || src === '@koa/router' || src === 'koa-router') return 'koa';
    return 'express';
  }

  /**
   * Detects `express()`, `express.Router()`, `Router()`, `require('express')()`, Fastify
   * `fastify()`, Koa `new Koa()` and `new Router()` from `@koa/router`.
   */
  private routerCreation(node: Node): 'app' | 'router' | undefined {
    const n = unwrap(node);
    if (n.type !== 'CallExpression' && n.type !== 'NewExpression') return undefined;
    const callee = unwrap(n.callee as Node);
    if (callee.type === 'Identifier') {
      if (this.expressNames.has(callee.name) || this.fastifyNames.has(callee.name) || this.koaAppNames.has(callee.name)) return 'app';
      if (this.routerFactoryNames.has(callee.name) || this.koaRouterNames.has(callee.name)) return 'router';
    }
    const src = this.requireSource(callee);
    if (src === 'express' || src === 'fastify' || src === 'koa') return 'app';
    if (src === '@koa/router' || src === 'koa-router') return 'router';
    if (callee.type === 'MemberExpression' && propName(callee) === 'Router') {
      const obj = unwrap(callee.object);
      if (obj.type === 'Identifier' && this.expressNames.has(obj.name)) return 'router';
      if (this.requireSource(obj) === 'express') return 'router';
    }
    return undefined;
  }

  private visitAssignment(node: t.AssignmentExpression, scope: Scope): void {
    const left = node.left;
    const right = unwrap(node.right);
    const leftText = memberText(left as Node);
    // CommonJS exports
    if (leftText === 'module.exports' || leftText === 'exports') {
      if (leftText !== 'module.exports') {
        this.walk(right, scope);
        return;
      }
      this.recordCjsExport(right, scope);
      if (right.type === 'ArrowFunctionExpression' || right.type === 'FunctionExpression') {
        this.visitFunction(right, scope, '<cjs>', '<cjs>');
      } else if (right.type === 'ObjectExpression') {
        for (const prop of right.properties) {
          if (prop.type === 'ObjectProperty') {
            const value = unwrap(prop.value as Node);
            if (value.type !== 'ArrowFunctionExpression' && value.type !== 'FunctionExpression') this.walk(value, scope);
          } else if (prop.type === 'SpreadElement') {
            this.walk(prop.argument, scope);
          }
        }
      } else {
        this.walk(right, scope);
      }
      return;
    }
    if (leftText && /^(module\.)?exports\.[\w$]+$/.test(leftText)) {
      const exportName = leftText.split('.').pop() as string;
      if (right.type === 'ArrowFunctionExpression' || right.type === 'FunctionExpression') {
        const key = `exports.${exportName}`;
        this.visitFunction(right, scope, exportName, key);
        this.facts.exports[exportName] = { k: 'fn', key };
        return;
      }
      this.pendingExports.push({ name: exportName, node: right, scope });
      this.walk(right, scope);
      return;
    }
    // `app = express()` / `this.app = express()`
    const creation = this.routerCreation(right);
    if (creation && leftText) {
      if (leftText.startsWith('this.') && this.classStack.length > 0) {
        const prop = leftText.slice(5);
        const key = this.addRouter(`${this.currentClass()!.name}.${prop}`, creation, right, this.fileScope);
        this.currentClass()!.members.set(prop, { kind: 'router', key });
      } else if (left.type === 'Identifier') {
        const key = this.addRouter(left.name, creation, right, scope);
        this.assignBinding(scope, left.name, { kind: 'router', key });
      }
      this.walk(right, scope);
      return;
    }
    // `this.userService = userService` in JS constructors: track as a dependency when service-like.
    if (leftText?.startsWith('this.') && this.classStack.length > 0) {
      const prop = leftText.slice(5);
      const ctx = this.currentClass()!;
      if (right.type === 'NewExpression' && right.callee.type === 'Identifier') ctx.deps[prop] = right.callee.name;
      else if (SERVICE_NAME.test(prop) && !own(ctx.deps, prop)) ctx.deps[prop] = '';
    }
    forEachChild(node, (child) => this.walk(child, scope));
  }

  private assignBinding(scope: Scope, name: string, binding: Binding): void {
    let s: Scope | undefined = scope;
    while (s) {
      if (s.hasOwn(name)) {
        s.set(name, binding);
        return;
      }
      s = s.parent;
    }
    this.fileScope.set(name, binding);
  }

  private currentClass(): ClassContext | undefined {
    return this.classStack[this.classStack.length - 1];
  }

  private recordCjsExport(right: Node, scope: Scope): void {
    if (right.type === 'ObjectExpression') {
      for (const prop of right.properties) {
        if (prop.type === 'ObjectProperty') {
          const key = keyName(prop.key);
          if (!key) continue;
          const value = unwrap(prop.value as Node);
          if (value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression') {
            const fnKey = `<cjs>.${key}`;
            this.visitFunction(value, scope, key, fnKey);
            this.facts.exports[key] = { k: 'fn', key: fnKey };
          } else {
            this.pendingExports.push({ name: key, node: value, scope });
          }
        } else if (prop.type === 'ObjectMethod') {
          const key = keyName(prop.key);
          if (!key) continue;
          const fnKey = `<cjs>.${key}`;
          this.visitFunction(prop, scope, key, fnKey);
          this.facts.exports[key] = { k: 'fn', key: fnKey };
        }
      }
      return;
    }
    if (right.type === 'ArrowFunctionExpression' || right.type === 'FunctionExpression') {
      this.facts.exports['*cjs'] = { k: 'fn', key: '<cjs>' };
      return;
    }
    this.pendingExports.push({ name: '*cjs', node: right, scope });
  }

  private visitExportNamed(node: t.ExportNamedDeclaration, scope: Scope): void {
    if (node.source) {
      const source = node.source.value;
      for (const spec of node.specifiers) {
        if (spec.type === 'ExportSpecifier') {
          const exported = spec.exported.type === 'Identifier' ? spec.exported.name : spec.exported.value;
          this.facts.exports[exported] = { k: 'import', source, name: spec.local.name };
        } else if (spec.type === 'ExportNamespaceSpecifier') {
          this.facts.exports[spec.exported.name] = { k: 'import', source, name: '*' };
        } else if (spec.type === 'ExportDefaultSpecifier') {
          this.facts.exports[spec.exported.name] = { k: 'import', source, name: 'default' };
        }
      }
      return;
    }
    const decl = node.declaration;
    if (decl) {
      this.walk(decl, scope);
      if (decl.type === 'FunctionDeclaration' && decl.id) {
        this.facts.exports[decl.id.name] = { k: 'fn', key: decl.id.name };
      } else if (decl.type === 'ClassDeclaration' && decl.id) {
        this.facts.exports[decl.id.name] = { k: 'class', name: decl.id.name };
      } else if (decl.type === 'TSEnumDeclaration') {
        this.pendingExports.push({ name: decl.id.name, node: decl.id, scope });
      } else if (decl.type === 'VariableDeclaration') {
        for (const d of decl.declarations) {
          if (d.id.type === 'Identifier') this.pendingExports.push({ name: d.id.name, node: d.id, scope });
        }
      }
    }
    for (const spec of node.specifiers) {
      if (spec.type === 'ExportSpecifier') {
        const exported = spec.exported.type === 'Identifier' ? spec.exported.name : spec.exported.value;
        this.pendingExports.push({ name: exported, node: spec.local, scope });
      }
    }
  }

  private visitExportDefault(node: t.ExportDefaultDeclaration, scope: Scope): void {
    const decl = node.declaration;
    if (decl.type === 'FunctionDeclaration') {
      const name = decl.id?.name ?? '<default>';
      this.visitFunction(decl, scope, name, decl.id ? name : '<default>');
      this.facts.exports.default = { k: 'fn', key: decl.id ? name : '<default>' };
      return;
    }
    if (decl.type === 'ClassDeclaration') {
      this.visitClass(decl, scope, decl.id?.name ?? 'default');
      this.facts.exports.default = { k: 'class', name: decl.id?.name ?? 'default' };
      return;
    }
    const expr = unwrap(decl as Node);
    if (expr.type === 'ArrowFunctionExpression' || expr.type === 'FunctionExpression') {
      this.visitFunction(expr, scope, '<default>', '<default>');
      this.facts.exports.default = { k: 'fn', key: '<default>' };
      return;
    }
    if (expr.type === 'ObjectExpression') {
      for (const prop of expr.properties) {
        if (prop.type === 'ObjectProperty') {
          const key = keyName(prop.key);
          if (key) this.pendingExports.push({ name: `default.${key}`, node: prop.value as Node, scope });
        }
      }
    }
    const creation = this.routerCreation(expr);
    if (creation) {
      const key = this.addRouter('default', creation, expr, scope);
      this.facts.exports.default = { k: 'node', key };
      this.walk(expr, scope);
      return;
    }
    if (expr.type === 'NewExpression' && expr.callee.type === 'Identifier') {
      this.facts.exports.default = { k: 'instance', className: expr.callee.name };
    } else {
      this.pendingExports.push({ name: 'default', node: expr, scope });
    }
    this.walk(expr, scope);
  }

  // -------------------------------------------------------------------------------------------
  // References
  // -------------------------------------------------------------------------------------------

  private refOf(node: Node, scope: Scope): RefExpr | undefined {
    const n = unwrap(node);
    if (n.type === 'Identifier') {
      const binding = scope.get(n.name);
      if (binding) return bindingToRef(binding);
      const imp = own(this.facts.imports, n.name);
      if (imp) return { k: 'import', source: imp.source, name: imp.name };
      return undefined;
    }
    if (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') {
      const prop = propName(n);
      if (!prop) return undefined;
      const obj = unwrap(n.object);
      if (obj.type === 'ThisExpression') {
        for (let i = this.classStack.length - 1; i >= 0; i--) {
          const b = this.classStack[i].members.get(prop);
          if (b) return bindingToRef(b);
        }
        return undefined;
      }
      const src = this.requireSource(obj);
      if (src) return { k: 'import', source: src, name: '*cjs', member: prop };
      if (obj.type === 'Identifier') {
        const binding = scope.get(obj.name);
        if (binding?.kind === 'alias' && binding.ref.k === 'import' && !binding.ref.member) {
          return { ...binding.ref, member: prop };
        }
        if (binding) return undefined;
        const imp = own(this.facts.imports, obj.name);
        if (imp) return { k: 'import', source: imp.source, name: imp.name, member: prop };
      }
      return undefined;
    }
    if (n.type === 'CallExpression' || n.type === 'NewExpression') {
      // Inline router creation: `Router()` used without a variable.
      const creation = this.routerCreation(n);
      if (creation) {
        let key = this.anonymousRouters.get(n);
        if (!key) {
          key = this.addRouter(`(${creation}@${posOf(n).line}:${posOf(n).column})`, creation, n, this.fileScope);
          this.anonymousRouters.set(n, key);
        }
        return { k: 'node', key };
      }
      if (n.type === 'NewExpression') return undefined;
      const callee = unwrap(n.callee as Node);
      // `router.use(...)` and `router.get(path, ...)` return the router itself, so chains resolve to it.
      if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
        const prop = propName(callee);
        // Koa: `router.routes()` and `router.middleware()` mount the router itself.
        if ((prop === 'routes' || prop === 'middleware') && n.arguments.length === 0) {
          const base = this.refOf(callee.object, scope);
          if (base?.k === 'node') return base;
        }
        if (prop === 'use' || prop === 'register' || (prop !== undefined && prop in EXPRESS_METHODS && n.arguments.length >= 2)) {
          const base = this.refOf(callee.object, scope);
          if (base?.k === 'node') return base;
        }
      }
      const src = this.requireSource(n);
      if (src) return { k: 'import', source: src, name: '*cjs' };
      const calleeRef = this.refOf(callee, scope);
      if (calleeRef && (calleeRef.k === 'fn' || calleeRef.k === 'import')) return { k: 'call', callee: calleeRef };
    }
    return undefined;
  }

  // -------------------------------------------------------------------------------------------
  // Path expressions
  // -------------------------------------------------------------------------------------------

  /** Path expressions for a route argument, or undefined if the argument is not path-like. */
  private pathsOf(node: Node, scope: Scope, allowDynamic: boolean): PathExpr[] | undefined {
    const n = unwrap(node);
    if (n.type === 'ArrayExpression') {
      const out: PathExpr[] = [];
      for (const el of n.elements) {
        if (!el || el.type === 'SpreadElement') return allowDynamic ? [{ parts: [{ dynamic: '[…]' }] }] : undefined;
        const sub = this.pathsOf(el, scope, true);
        if (!sub) return undefined;
        out.push(...sub);
      }
      return out.length > 0 ? out : undefined;
    }
    if (n.type === 'RegExpLiteral') return [{ parts: [{ regex: `/${n.pattern}/${n.flags}` }] }];
    const expr = this.constPath(n, scope) ?? this.importRef(n, scope);
    if (expr) return [expr];
    if (!allowDynamic) return undefined;
    if (isFunctionLike(n) || n.type === 'ObjectExpression') return undefined;
    const text = memberText(n) ?? shortLabel(n);
    return [{ parts: [{ dynamic: text }] }];
  }

  /** Evaluates a string-ish expression to a PathExpr if it contains at least one string part. */
  private constPath(node: Node, scope: Scope): PathExpr | undefined {
    const n = unwrap(node);
    switch (n.type) {
      case 'StringLiteral':
        return { parts: [{ lit: n.value }] };
      case 'TemplateLiteral': {
        const parts: PathPart[] = [];
        n.quasis.forEach((q, i) => {
          parts.push({ lit: q.value.cooked ?? q.value.raw });
          const e = n.expressions[i];
          if (e) {
            const sub = this.constPath(e as Node, scope) ?? this.importRef(e as Node, scope);
            if (sub) parts.push(...sub.parts);
            else parts.push({ dynamic: memberText(e as Node) ?? shortLabel(e as Node) });
          }
        });
        return compactExpr({ parts });
      }
      case 'BinaryExpression': {
        if (n.operator !== '+') return undefined;
        const left = this.constPath(n.left as Node, scope);
        const right = this.constPath(n.right, scope);
        // `API + ROUTES.USERS` with both imported is a path as well; the linker resolves it.
        if (!left && !right && !(this.importRef(n.left as Node, scope) && this.importRef(n.right, scope))) return undefined;
        const l = left ?? this.importRef(n.left as Node, scope) ?? { parts: [{ dynamic: memberText(n.left as Node) ?? shortLabel(n.left as Node) }] };
        const r = right ?? this.importRef(n.right, scope) ?? { parts: [{ dynamic: memberText(n.right) ?? shortLabel(n.right) }] };
        return compactExpr({ parts: [...l.parts, ...r.parts] });
      }
      case 'Identifier': {
        const b = scope.get(n.name);
        return b?.kind === 'const' ? b.expr : undefined;
      }
      case 'MemberExpression': {
        const text = memberText(n);
        if (!text) return undefined;
        const b = scope.get(text);
        return b?.kind === 'const' ? b.expr : undefined;
      }
      default:
        return undefined;
    }
  }

  /**
   * A reference to an imported constant (`ROUTES.SHOPIFY` where `ROUTES` is imported), resolved
   * across files by the linkers. Only used where a path is expected.
   */
  private importRef(node: Node, scope: Scope): PathExpr | undefined {
    const text = memberText(node);
    if (!text) return undefined;
    const root = text.split('.')[0];
    if (!own(this.facts.imports, root) || scope.get(root)) return undefined;
    return { parts: [{ ref: text }] };
  }

  // -------------------------------------------------------------------------------------------
  // Calls: routes, mounts, injections, Nest bootstrap configuration
  // -------------------------------------------------------------------------------------------

  private visitCall(node: t.CallExpression | t.OptionalCallExpression, scope: Scope): void {
    const callee = unwrap(node.callee as Node);
    if (this.handleClientCall(node, callee, scope)) {
      for (const a of node.arguments) this.walk(a as Node, scope);
      this.walk(callee, scope);
      return;
    }
    if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
      const prop = propName(callee);
      if (prop) {
        if (prop === 'route' && this.handleRouteObject(node, callee, scope)) return;
        if (prop === 'register' && this.handleRegister(node, callee, scope)) return;
        if (prop === 'prefix') this.handleKoaPrefix(node, callee, scope);
        if (prop in EXPRESS_METHODS && this.handleRouteCall(node, callee, prop, scope)) return;
        if (prop === 'use' && this.handleUse(node, callee, scope)) return;
        if (this.usesNest && prop === 'setGlobalPrefix') this.handleGlobalPrefix(node, scope);
        if (this.usesNest && prop === 'enableVersioning') this.handleVersioning(node);
        if (this.usesNest && prop === 'useGlobalGuards') this.handleGlobalGuards(node, 'useGlobalGuards');
        if (this.usesNest && prop === 'useGlobalPipes') this.handleGlobalGuards(node, 'useGlobalPipes');
        if (prop === 'listen' && !this.facts.listenPort) this.handleListen(node, callee, scope);
        if (this.usesNest && (prop === 'register' || prop === 'forRoutes') && memberText(callee.object) === 'RouterModule') {
          this.handleRouterModule(node);
        }
      }
    }
    // Injection: `registerRoutes(app)`, `require('./routes')(app)`
    node.arguments.forEach((arg, index) => {
      if (arg.type === 'SpreadElement' || arg.type === 'ArgumentPlaceholder') return;
      const argRef = this.refOf(arg as Node, scope);
      if (argRef?.k !== 'node') return;
      const calleeRef = this.refOf(callee, scope);
      if (calleeRef && (calleeRef.k === 'fn' || calleeRef.k === 'import' || calleeRef.k === 'call')) {
        this.facts.injections.push({ callee: calleeRef.k === 'call' ? calleeRef.callee : calleeRef, argIndex: index, parent: argRef, pos: posOf(node) });
      }
    });
  }

  private routerTarget(node: Node, scope: Scope): RefExpr | undefined {
    const ref = this.refOf(node, scope);
    if (!ref) return undefined;
    if (ref.k === 'node' || ref.k === 'import' || ref.k === 'call') return ref;
    return undefined;
  }

  private handleRouteCall(
    node: t.CallExpression | t.OptionalCallExpression,
    callee: t.MemberExpression | t.OptionalMemberExpression,
    prop: string,
    scope: Scope,
  ): boolean {
    const method = EXPRESS_METHODS[prop];
    let target: RefExpr | undefined;
    let paths: PathExpr[] | undefined;
    let args = node.arguments as Node[];
    const object = unwrap(callee.object);
    // `router.route('/x').get(h).post(h)`
    const chain = this.routeChainBase(object, scope);
    if (chain) {
      target = chain.target;
      paths = chain.paths;
    } else {
      target = this.routerTarget(object, scope);
      if (!target || args.length < 2) return false;
      // Koa named routes: `router.get('user', '/users/:id', handler)`
      const [a0, a1] = [unwrap(args[0]), unwrap(args[1])];
      if (args.length >= 3 && a0.type === 'StringLiteral' && !a0.value.startsWith('/') && a1.type === 'StringLiteral' && a1.value.startsWith('/')) args = args.slice(1);
      paths = this.pathsOf(args[0], scope, true);
      if (!paths) return false;
      args = args.slice(1);
    }
    if (!target || !paths || args.length === 0) return false;
    const flat = args.flatMap((a) => (a.type === 'ArrayExpression' ? (a.elements.filter(Boolean) as Node[]) : [a]));
    // Fastify: `app.get(path, { preHandler, schema }, handler)`; options are not middleware.
    const options = flat.filter((a) => unwrap(a).type === 'ObjectExpression');
    const callables = flat.filter((a) => unwrap(a).type !== 'ObjectExpression');
    const handlerNode = callables[callables.length - 1];
    const middleware = [...options.flatMap((o) => this.hookNames(o)), ...callables.slice(0, -1).map((m) => shortLabel(m))];
    const route: ExpressRouteFact = {
      router: target,
      method,
      paths,
      middleware,
      handler: handlerNode ? this.handlerOf(handlerNode, scope) : undefined,
      bodySchema: options.some((o) => this.hasBodySchema(o)) || undefined,
      pos: posOf(callee.property),
      order: this.order++,
    };
    this.facts.routes.push(route);
    // Walk arguments for nested calls / inline handler scopes.
    for (const a of node.arguments) this.walk(a as Node, scope);
    if (chain) this.walk(object, scope);
    return true;
  }

  private routeChainBase(node: Node, scope: Scope): { target: RefExpr; paths: PathExpr[] } | undefined {
    const n = unwrap(node);
    if (n.type !== 'CallExpression') return undefined;
    const callee = unwrap(n.callee as Node);
    if (callee.type !== 'MemberExpression') return undefined;
    const prop = propName(callee);
    if (prop === 'route') {
      const target = this.routerTarget(callee.object, scope);
      const first = n.arguments[0];
      if (!target || !first) return undefined;
      const paths = this.pathsOf(first as Node, scope, true);
      return paths ? { target, paths } : undefined;
    }
    if (prop && prop in EXPRESS_METHODS) return this.routeChainBase(callee.object, scope);
    return undefined;
  }

  private handlerOf(node: Node, scope: Scope): HandlerFact {
    let n = unwrap(node);
    // Unwrap `fn.bind(x)` and single-argument wrappers like `asyncHandler(fn)`.
    for (let i = 0; i < 3; i++) {
      if (n.type === 'CallExpression') {
        const callee = unwrap(n.callee as Node);
        if (callee.type === 'MemberExpression' && propName(callee) === 'bind') {
          n = unwrap(callee.object);
          continue;
        }
        const firstArg = n.arguments[0];
        if (n.arguments.length === 1 && firstArg && firstArg.type !== 'SpreadElement' && firstArg.type !== 'ArgumentPlaceholder') {
          n = unwrap(firstArg as Node);
          continue;
        }
      }
      break;
    }
    const pos = posOf(n);
    if (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression') {
      return {
        name: n.type === 'FunctionExpression' && n.id ? n.id.name : '(anonymous)',
        pos,
        serviceCalls: this.collectServiceCalls(n, scope),
        arity: n.params.length,
        forwards: forwardedParams(n),
        validatesBody: validatesBody(n) || undefined,
        body: analyzeBody(n, { ...handlerParams(n), returns: true }),
      };
    }
    if (n.type === 'Identifier') {
      return { name: n.name, ref: this.refOf(n, scope), pos, serviceCalls: [] };
    }
    if (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') {
      const text = memberText(n) ?? shortLabel(n);
      const member = propName(n);
      const obj = unwrap(n.object);
      let controller = memberText(obj);
      let ref: RefExpr | undefined;
      if (obj.type === 'Identifier') {
        const binding = scope.get(obj.name);
        if (binding?.kind === 'instance') {
          ref = { k: 'instance', className: binding.className };
          controller = binding.className;
        } else if (binding?.kind === 'class') {
          ref = { k: 'class', name: binding.name };
        } else {
          ref = this.refOf(obj, scope);
        }
      } else if (obj.type === 'MemberExpression' && unwrap(obj.object).type === 'ThisExpression') {
        const prop = propName(obj);
        const type = prop ? own(this.currentClass()?.deps, prop) : undefined;
        if (type) ref = { k: 'instance', className: type };
      }
      return { name: text, controller, member, ref, pos, serviceCalls: [] };
    }
    return { name: shortLabel(n), pos, serviceCalls: [] };
  }

  private handleUse(node: t.CallExpression | t.OptionalCallExpression, callee: t.MemberExpression | t.OptionalMemberExpression, scope: Scope): boolean {
    const target = this.routerTarget(callee.object, scope);
    if (!target) return false;
    const args = node.arguments as Node[];
    if (args.length === 0) return false;
    let paths: PathExpr[] = [{ parts: [{ lit: '/' }] }];
    let rest = args;
    const first = unwrap(args[0]);
    const firstPaths =
      first.type === 'StringLiteral' || first.type === 'TemplateLiteral' || first.type === 'ArrayExpression' || first.type === 'RegExpLiteral'
        ? this.pathsOf(first, scope, true)
        : this.constPath(first, scope)
          ? this.pathsOf(first, scope, false)
          : undefined;
    if (firstPaths) {
      paths = firstPaths;
      rest = args.slice(1);
    }
    const maybePath = !firstPaths && args.length > 1 ? this.importRef(first, scope) : undefined;
    this.facts.mounts.push({
      parent: target,
      paths,
      maybePath,
      args: rest.map((a) => ({ ref: this.refOf(a, scope), text: shortLabel(a) })),
      pos: posOf(callee.property),
      order: this.order++,
    });
    for (const a of args) this.walk(a, scope);
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Functions and service calls
  // -------------------------------------------------------------------------------------------

  private visitFunction(node: t.Function, scope: Scope, nameHint?: string, explicitKey?: string): void {
    const name = nameHint ?? ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') && node.id ? node.id.name : undefined);
    const fnScope = new Scope(scope);
    let key: string | undefined;
    if (name) {
      const existing = scope.get(name);
      key = explicitKey ?? (existing?.kind === 'fn' ? existing.key : this.callableKey(name, node, scope));
    }
    const routerParams: number[] = [];
    node.params.forEach((param, index) => {
      const p = param.type === 'TSParameterProperty' ? param.parameter : param;
      const id = p.type === 'AssignmentPattern' ? p.left : p;
      if (id.type !== 'Identifier') return;
      if (key && ((index === 0 && this.pluginFunctions.has(node)) || this.isRouterParam(id, node))) {
        const nodeKey = `param:${key}:${index}`;
        this.facts.routers.push({ key: nodeKey, kind: 'param', name: id.name, pos: posOf(id) });
        fnScope.set(id.name, { kind: 'router', key: nodeKey });
        routerParams.push(index);
      } else {
        fnScope.set(id.name, { kind: 'shadow' });
      }
    });
    if (node.body.type === 'BlockStatement') this.hoist(node.body.body, fnScope);
    this.walk(node.body, fnScope);
    if (key && name) {
      this.callableNodes.set(node, key);
      const callable: CallableFact = {
        key,
        name,
        pos: posOf(node.type === 'ClassMethod' || node.type === 'ObjectMethod' ? node.key : node),
        routerParams,
        returns: this.returnedRouter(node, fnScope),
        serviceCalls: this.collectServiceCalls(node, fnScope),
        arity: node.params.length,
        forwards: forwardedParams(node),
        validatesBody: validatesBody(node) || undefined,
        body: looksLikeHandler(node)
          ? analyzeBody(node, { ...handlerParams(node), returns: true })
          : SERVICE_SOURCE.test(this.filePath) || SERVICE_NAME.test(this.currentClass()?.name ?? '')
            ? dataAccessOnly(analyzeBody(node, {}))
            : undefined,
        owner: this.currentClass()?.name,
      };
      if (!callable.body) delete callable.body;
      if (!callable.owner) delete callable.owner;
      this.facts.callables[key] = callable;
    }
  }

  private isRouterParam(id: t.Identifier, fn: t.Function): boolean {
    const annotation = id.typeAnnotation;
    if (annotation && annotation.type === 'TSTypeAnnotation') {
      const ty = annotation.typeAnnotation;
      if (ty.type === 'TSTypeReference') {
        const tn = ty.typeName;
        if (tn.type === 'Identifier') {
          const imp = own(this.facts.imports, tn.name);
          return !!imp && !!ROUTER_TYPE_NAMES[imp.source]?.has(imp.name === 'default' ? 'Router' : imp.name);
        }
        if (tn.type === 'TSQualifiedName' && tn.left.type === 'Identifier') {
          return this.expressNames.has(tn.left.name) && EXPRESS_TYPE_NAMES.has(tn.right.name);
        }
      }
      return false;
    }
    if (!ROUTER_PARAM_NAME.test(id.name)) return false;
    // Untyped: require at least one `name.method('/path', ...)` or `name.use(...)` call in the body.
    let used = false;
    const visit = (n: Node): void => {
      if (used) return;
      if (n.type === 'CallExpression') {
        const c = unwrap(n.callee as Node);
        if (c.type === 'MemberExpression' && unwrap(c.object).type === 'Identifier' && (unwrap(c.object) as t.Identifier).name === id.name) {
          const prop = propName(c);
          const first = n.arguments[0];
          if (prop === 'use' && n.arguments.length > 0) used = true;
          if (prop && prop in EXPRESS_METHODS && n.arguments.length >= 2 && first && (first.type === 'StringLiteral' || first.type === 'TemplateLiteral')) used = true;
          if (prop === 'route') used = true;
        }
      }
      forEachChild(n, visit);
    };
    visit(fn.body);
    return used;
  }

  private returnedRouter(node: t.Function, scope: Scope): RefExpr | undefined {
    if (node.body.type !== 'BlockStatement') {
      const ref = this.refOf(node.body, scope);
      return ref?.k === 'node' ? ref : undefined;
    }
    let found: RefExpr | undefined;
    const visit = (n: Node): void => {
      if (found || (n !== node.body && isFunctionLike(n))) return;
      if (n.type === 'ReturnStatement' && n.argument) {
        const ref = this.refOf(n.argument, scope);
        if (ref?.k === 'node') found = ref;
        return;
      }
      forEachChild(n, visit);
    };
    visit(node.body);
    return found;
  }

  private collectServiceCalls(fn: t.Function, scope: Scope): ServiceCall[] {
    const calls: ServiceCall[] = [];
    const seen = new Set<string>();
    const ctx = this.currentClass();
    const visit = (n: Node): void => {
      if (n.type === 'ClassDeclaration' || n.type === 'ClassExpression') return;
      if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') {
        const callee = unwrap(n.callee as Node);
        // Direct call of a function imported from a service module: `getTags()` from './tag.service'.
        if (callee.type === 'Identifier' && !scope.get(callee.name)) {
          const imp = own(this.facts.imports, callee.name);
          if (imp && imp.source.startsWith('.') && SERVICE_SOURCE.test(imp.source)) {
            const moduleName = imp.source.split('/').pop()!.replace(/\.[cm]?[jt]sx?$/, '');
            const id = `${moduleName}.${callee.name}`;
            if (!seen.has(id)) {
              seen.add(id);
              calls.push({ receiver: moduleName, method: callee.name, local: callee.name });
            }
          }
        }
        if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
          const method = propName(callee);
          const recv = unwrap(callee.object);
          if (method) {
            let call: ServiceCall | undefined;
            if (recv.type === 'Identifier' && !NON_SERVICE_RECEIVERS.has(recv.name)) {
              const binding = scope.get(recv.name);
              const imp = own(this.facts.imports, recv.name);
              if (binding?.kind === 'instance' && (SERVICE_NAME.test(binding.className) || SERVICE_NAME.test(recv.name))) {
                call = { receiver: recv.name, method, type: binding.className };
              } else if (!binding && imp && imp.source.startsWith('.') && (SERVICE_NAME.test(recv.name) || SERVICE_SOURCE.test(imp.source))) {
                call = { receiver: recv.name, method };
              }
            } else if (recv.type === 'MemberExpression' && unwrap(recv.object).type === 'ThisExpression') {
              const prop = propName(recv);
              if (prop && ctx && (prop in ctx.deps || SERVICE_NAME.test(prop))) {
                const type = own(ctx.deps, prop) || undefined;
                if (type || SERVICE_NAME.test(prop)) call = { receiver: `this.${prop}`, method, type };
              }
            }
            if (call) {
              const id = `${call.receiver}.${call.method}`;
              if (!seen.has(id)) {
                seen.add(id);
                calls.push(call);
              }
            }
          }
        }
      }
      forEachChild(n, visit);
    };
    visit(fn.body);
    return calls;
  }

  // -------------------------------------------------------------------------------------------
  // Classes (Nest controllers, Express controller classes, services)
  // -------------------------------------------------------------------------------------------

  private visitClass(node: t.ClassDeclaration | t.ClassExpression, scope: Scope, nameHint?: string): void {
    const name = node.id?.name ?? nameHint ?? '(anonymous class)';
    if (node.id && scope !== this.fileScope) scope.set(node.id.name, { kind: 'class', name });
    const ctx: ClassContext = { name, members: new Map(), deps: {} };
    const classFact: ClassFact = { name, pos: posOf(node.id ?? node), methods: {}, deps: ctx.deps };
    this.facts.classes[name] = classFact;

    // Dependencies: constructor parameter properties and typed class properties.
    for (const member of node.body.body) {
      if (member.type === 'ClassMethod' && member.kind === 'constructor') {
        for (const param of member.params) {
          if (param.type === 'TSParameterProperty' && param.parameter.type === 'Identifier') {
            const type = typeNameOf(param.parameter.typeAnnotation as Node | undefined);
            ctx.deps[param.parameter.name] = type ?? '';
          }
        }
      } else if (member.type === 'ClassProperty' && member.key.type === 'Identifier') {
        const type = typeNameOf(member.typeAnnotation as Node | undefined);
        if (type && !member.static) ctx.deps[member.key.name] = type;
        const value = member.value ? unwrap(member.value) : undefined;
        if (value) {
          const creation = this.routerCreation(value);
          if (creation) {
            const key = this.addRouter(`${name}.${member.key.name}`, creation, value, this.fileScope);
            ctx.members.set(member.key.name, { kind: 'router', key });
          }
        }
      }
    }

    const controller = this.nestController(node, name);
    this.classStack.push(ctx);
    try {
      for (const member of node.body.body) {
        if ((member.type === 'ClassMethod' || member.type === 'ClassPrivateMethod') && member.kind !== 'constructor') {
          const methodName = member.key.type === 'PrivateName' ? `#${member.key.id.name}` : keyName(member.key);
          if (!methodName) continue;
          const key = `${name}.${methodName}`;
          this.visitFunction(member, scope, methodName, key);
          classFact.methods[methodName] = key;
          if (controller && member.type === 'ClassMethod') this.nestMethod(controller, member, methodName);
        } else if (member.type === 'ClassProperty' && member.value && member.key.type === 'Identifier') {
          const value = unwrap(member.value);
          if (value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression') {
            const key = `${name}.${member.key.name}`;
            this.visitFunction(value, scope, member.key.name, key);
            classFact.methods[member.key.name] = key;
          } else {
            this.walk(value, scope);
          }
        } else if (member.type === 'ClassMethod' && member.kind === 'constructor') {
          this.visitFunction(member, scope);
        } else {
          this.walk(member, scope);
        }
      }
    } finally {
      this.classStack.pop();
    }
    if (controller) this.facts.nestControllers.push(controller);
    this.nestModule(node, name);
  }

  // -------------------------------------------------------------------------------------------
  // NestJS
  // -------------------------------------------------------------------------------------------

  /** `@HttpCode(204)` / `@HttpCode(HttpStatus.NO_CONTENT)` on a Nest method. */
  private httpCode(member: t.ClassMethod): number | undefined {
    for (const dec of member.decorators ?? []) {
      const d = this.nestDecorator(dec.expression);
      if (d?.name !== 'HttpCode' || !d.args[0]) continue;
      const a = unwrap(d.args[0]);
      if (a.type === 'NumericLiteral') return a.value;
      const name = a.type === 'MemberExpression' ? propName(a) : undefined;
      if (name && HTTP_STATUS_NAMES[name]) return HTTP_STATUS_NAMES[name];
    }
    return undefined;
  }

  /** Returns the canonical @nestjs/common name for a decorator expression. */
  private nestDecorator(expr: Node): { name: string; args: Node[] } | undefined {
    if (!this.usesNest) return undefined;
    const n = unwrap(expr);
    const callee = n.type === 'CallExpression' ? unwrap(n.callee as Node) : n;
    const args = n.type === 'CallExpression' ? (n.arguments as Node[]) : [];
    if (callee.type === 'Identifier') {
      const imported = this.nestNames.get(callee.name);
      return imported ? { name: imported, args } : undefined;
    }
    if (callee.type === 'MemberExpression' && unwrap(callee.object).type === 'Identifier') {
      const ns = (unwrap(callee.object) as t.Identifier).name;
      const prop = propName(callee);
      if (prop && this.nestNamespaces.has(ns)) return { name: prop, args };
    }
    return undefined;
  }

  private stringList(node: Node | undefined): string[] {
    if (!node) return [];
    const n = unwrap(node);
    if (n.type === 'StringLiteral') return [n.value];
    if (n.type === 'ArrayExpression') return n.elements.flatMap((e) => (e ? this.stringList(e as Node) : []));
    const text = memberText(n);
    if (text && /VERSION_NEUTRAL$/.test(text)) return ['VERSION_NEUTRAL'];
    return [];
  }

  private nestPaths(arg: Node | undefined): PathExpr[] {
    if (!arg) return [{ parts: [{ lit: '' }] }];
    const n = unwrap(arg);
    if (n.type === 'ObjectExpression') {
      const pathProp = n.properties.find((p): p is t.ObjectProperty => p.type === 'ObjectProperty' && keyName(p.key) === 'path');
      return pathProp ? this.nestPaths(pathProp.value as Node) : [{ parts: [{ lit: '' }] }];
    }
    return this.pathsOf(n, this.fileScope, true) ?? [{ parts: [{ lit: '' }] }];
  }

  private objectProp(arg: Node | undefined, key: string): Node | undefined {
    if (!arg) return undefined;
    const n = unwrap(arg);
    if (n.type !== 'ObjectExpression') return undefined;
    const prop = n.properties.find((p): p is t.ObjectProperty => p.type === 'ObjectProperty' && keyName(p.key) === key);
    return prop?.value as Node | undefined;
  }

  private middlewareFromDecorator(name: string, args: Node[]): string[] {
    return args.map((a) => `${name}(${shortLabel(a)})`);
  }

  private nestController(node: t.ClassDeclaration | t.ClassExpression, name: string): NestControllerFact | undefined {
    const decorators = node.decorators ?? [];
    let controller: NestControllerFact | undefined;
    const middleware: string[] = [];
    let versions: string[] = [];
    const markers: string[] = [];
    for (const dec of decorators) {
      const d = this.nestDecorator(dec.expression);
      if (!d) {
        const marker = this.marker(dec.expression);
        if (marker) markers.push(marker);
        continue;
      }
      if (d.name === 'Controller') {
        controller = {
          className: name,
          pos: posOf(dec),
          paths: this.nestPaths(d.args[0]),
          versions: [],
          middleware: [],
          markers: [],
          methods: [],
          deps: {},
        };
        versions.push(...this.stringList(this.objectProp(d.args[0], 'version')));
      } else if (NEST_MIDDLEWARE_DECORATORS.has(d.name)) {
        middleware.push(...this.middlewareFromDecorator(d.name, d.args));
      } else if (d.name === 'Version') {
        versions = [...versions, ...this.stringList(d.args[0])];
      }
    }
    if (!controller) return undefined;
    controller.middleware = middleware;
    controller.markers = markers;
    controller.versions = versions;
    controller.deps = own(this.facts.classes, name)?.deps ?? {};
    return controller;
  }

  private nestMethod(controller: NestControllerFact, member: t.ClassMethod, methodName: string): void {
    let httpMethod: HttpMethod | undefined;
    let paths: PathExpr[] = [];
    let pos = posOf(member.key);
    const middleware: string[] = [];
    const markers: string[] = [];
    const versions: string[] = [];
    for (const dec of member.decorators ?? []) {
      const d = this.nestDecorator(dec.expression);
      if (!d) {
        const marker = this.marker(dec.expression);
        if (marker) markers.push(marker);
        continue;
      }
      if (d.name in NEST_METHOD_DECORATORS) {
        httpMethod = NEST_METHOD_DECORATORS[d.name];
        paths = this.nestPaths(d.args[0]);
        pos = posOf(dec);
      } else if (NEST_MIDDLEWARE_DECORATORS.has(d.name)) {
        middleware.push(...this.middlewareFromDecorator(d.name, d.args));
      } else if (d.name === 'Version') {
        versions.push(...this.stringList(d.args[0]));
      }
    }
    if (!httpMethod) return;
    const params: NestParamFact[] = [];
    let bodyType: string | undefined;
    let bodyPipes: string[] | undefined;
    const vars: { body: string[]; param: string[]; query: string[]; req?: string; user: boolean } = { body: [], param: [], query: [], user: false };
    for (const param of member.params) {
      const p = param.type === 'TSParameterProperty' ? param.parameter : param;
      const decs = (p as { decorators?: t.Decorator[] }).decorators ?? [];
      const id = p.type === 'AssignmentPattern' ? p.left : p;
      const type = id.type === 'Identifier' ? typeNameOf(id.typeAnnotation as Node | undefined) : undefined;
      const local = id.type === 'Identifier' ? id.name : undefined;
      for (const dec of decs) {
        const d = this.nestDecorator(dec.expression);
        if (!d) {
          // `@CurrentUser() user`, `@AuthUser()`, `@Session()`: the handler knows who is calling.
          if (/user|auth|principal|session/i.test(shortLabel(dec.expression))) vars.user = true;
          continue;
        }
        if (local) {
          if (d.name === 'Body') (d.args[0] ? vars.query : vars.body).push(local);
          else if (d.name === 'Param') vars.param.push(local);
          else if (d.name === 'Query') vars.query.push(local);
          else if (d.name === 'Req' || d.name === 'Request') vars.req = local;
          else if (d.name === 'Session') vars.user = true;
        }
        const keyArg = d.args[0] && unwrap(d.args[0]).type === 'StringLiteral' ? (unwrap(d.args[0]) as t.StringLiteral).value : undefined;
        const optional = (id.type === 'Identifier' && id.optional) || p.type === 'AssignmentPattern';
        if (d.name === 'Param' && keyArg) params.push({ name: keyArg, in: 'path', required: true, type });
        else if (d.name === 'Query' && keyArg) params.push({ name: keyArg, in: 'query', required: !optional, type });
        else if (d.name === 'Headers' && keyArg) params.push({ name: keyArg, in: 'header', required: !optional, type });
        else if (d.name === 'Body') {
          bodyType = keyArg ? bodyType ?? 'object' : type ?? 'object';
          const pipes = d.args.filter((a) => unwrap(a).type !== 'StringLiteral').map((a) => shortLabel(unwrap(a).type === 'NewExpression' ? ((unwrap(a) as t.NewExpression).callee as Node) : a));
          if (pipes.length) bodyPipes = [...(bodyPipes ?? []), ...pipes];
        }
      }
    }
    const callable = own(this.facts.callables, `${controller.className}.${methodName}`);
    const method: NestMethodFact = {
      name: methodName,
      pos,
      method: httpMethod,
      paths,
      versions,
      middleware,
      markers,
      params,
      bodyType,
      bodyPipes,
      serviceCalls: callable?.serviceCalls ?? [],
      httpCode: this.httpCode(member),
      returnType: responseTypeName(member.returnType as Node | null | undefined),
      body: analyzeBody(member, { req: vars.req, bodyVars: vars.body, paramVars: vars.param, queryVars: vars.query, receivesUser: vars.user, returns: true }),
    };
    if (method.httpCode === undefined) delete method.httpCode;
    if (!method.returnType) delete method.returnType;
    if (!method.body) delete method.body;
    controller.methods.push(method);
  }

  private nestModule(node: t.ClassDeclaration | t.ClassExpression, name: string): void {
    for (const dec of node.decorators ?? []) {
      const d = this.nestDecorator(dec.expression);
      if (d?.name !== 'Module') continue;
      const controllers = this.objectProp(d.args[0], 'controllers');
      const names: string[] = [];
      if (controllers && unwrap(controllers).type === 'ArrayExpression') {
        for (const el of (unwrap(controllers) as t.ArrayExpression).elements) {
          if (el && el.type === 'Identifier') names.push(el.name);
        }
      }
      this.facts.nestModules.push({ name, controllers: names, pos: posOf(dec) });
      this.appGuards(this.objectProp(d.args[0], 'providers'));
      // RouterModule.register inside @Module({ imports: [...] }) is handled by visitCall during walk.
      const imports = this.objectProp(d.args[0], 'imports');
      if (imports) this.walk(imports, this.fileScope);
    }
  }

  /** A custom (non-Nest) decorator as `@Name()`. Arguments are dropped, like middleware labels. */
  private marker(expr: Node): string | undefined {
    const label = shortLabel(expr);
    return label === '(expression)' ? undefined : `@${label}`;
  }

  /** `{ provide: APP_GUARD | APP_PIPE, useClass: X }` entries in `@Module({ providers })`. */
  private appGuards(providers: Node | undefined): void {
    if (!providers || unwrap(providers).type !== 'ArrayExpression') return;
    for (const el of (unwrap(providers) as t.ArrayExpression).elements) {
      if (!el || unwrap(el as Node).type !== 'ObjectExpression') continue;
      const provide = this.objectProp(el as Node, 'provide');
      const token = provide ? this.nestNames.get(memberText(provide) ?? '') : undefined;
      if (token !== 'APP_GUARD' && token !== 'APP_PIPE') continue;
      const target = this.objectProp(el as Node, 'useClass') ?? this.objectProp(el as Node, 'useExisting');
      const name = target ? memberText(target) : undefined;
      const list = token === 'APP_GUARD' ? this.facts.nestGlobalGuards : this.facts.nestGlobalPipes;
      list.push({ name: name ?? '(factory)', via: token, pos: posOf(el as Node) });
    }
  }

  private handleGlobalGuards(node: t.CallExpression | t.OptionalCallExpression, via: 'useGlobalGuards' | 'useGlobalPipes'): void {
    for (const arg of node.arguments) {
      if (arg.type === 'SpreadElement' || arg.type === 'ArgumentPlaceholder') continue;
      const a = unwrap(arg as Node);
      const name = a.type === 'NewExpression' ? memberText(a.callee as Node) : memberText(a);
      (via === 'useGlobalGuards' ? this.facts.nestGlobalGuards : this.facts.nestGlobalPipes).push({ name: name ?? shortLabel(a), via, pos: posOf(node) });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Fastify and Koa
  // -------------------------------------------------------------------------------------------

  /** Fastify `app.route({ method, url, handler, preHandler, schema })`. */
  private handleRouteObject(node: t.CallExpression | t.OptionalCallExpression, callee: t.MemberExpression | t.OptionalMemberExpression, scope: Scope): boolean {
    const opts = node.arguments[0] as Node | undefined;
    if (!opts || unwrap(opts).type !== 'ObjectExpression' || node.arguments.length !== 1) return false;
    const target = this.routerTarget(callee.object, scope);
    const urlNode = this.objectProp(opts, 'url') ?? this.objectProp(opts, 'path');
    const methodNode = this.objectProp(opts, 'method');
    if (!target || !urlNode || !methodNode) return false;
    const paths = this.pathsOf(urlNode, scope, true);
    const methods = this.stringList(methodNode).map((m) => EXPRESS_METHODS[m.toLowerCase()]).filter((m): m is HttpMethod => !!m);
    if (!paths || methods.length === 0) return false;
    const handlerNode = this.objectProp(opts, 'handler');
    for (const method of methods) {
      this.facts.routes.push({
        router: target,
        method,
        paths,
        middleware: this.hookNames(opts),
        handler: handlerNode ? this.handlerOf(handlerNode, scope) : undefined,
        bodySchema: this.hasBodySchema(opts),
        pos: posOf(callee.property),
        order: this.order++,
      });
    }
    this.walk(opts, scope);
    return true;
  }

  /** Fastify route-level hooks, shown like middleware. */
  private hookNames(opts: Node): string[] {
    const out: string[] = [];
    for (const hook of ['onRequest', 'preParsing', 'preValidation', 'preHandler']) {
      const v = this.objectProp(opts, hook);
      if (!v) continue;
      const u = unwrap(v);
      const items = u.type === 'ArrayExpression' ? (u.elements.filter(Boolean) as Node[]) : [u];
      out.push(...items.map((i) => shortLabel(i)));
    }
    return out;
  }

  private hasBodySchema(opts: Node): boolean {
    const schema = this.objectProp(opts, 'schema');
    if (!schema) return false;
    const u = unwrap(schema);
    // `schema: { body: ... }`, or a schema object defined elsewhere (assume it may have a body).
    return u.type === 'ObjectExpression' ? !!this.objectProp(u, 'body') : true;
  }

  /** Fastify `app.register(plugin, { prefix: '/v1' })`: the plugin's first parameter is a child router. */
  private handleRegister(node: t.CallExpression | t.OptionalCallExpression, callee: t.MemberExpression | t.OptionalMemberExpression, scope: Scope): boolean {
    const parent = this.routerTarget(callee.object, scope);
    const first = node.arguments[0] as Node | undefined;
    if (!parent || !first || first.type === 'SpreadElement') return false;
    let plugin = unwrap(first);
    // `fp(plugin)` from fastify-plugin, and `import('./routes')`.
    if (plugin.type === 'CallExpression' && unwrap(plugin.callee as Node).type === 'Identifier' && this.fastifyPluginNames.has((unwrap(plugin.callee as Node) as t.Identifier).name) && plugin.arguments[0]) {
      plugin = unwrap(plugin.arguments[0] as Node);
    }
    if (plugin.type === 'CallExpression' && plugin.callee.type === 'Import' && plugin.arguments[0]?.type === 'StringLiteral') {
      plugin = { type: 'CallExpression', callee: { type: 'Identifier', name: 'require' }, arguments: [plugin.arguments[0]] } as unknown as Node;
    }
    const prefixNode = this.objectProp(node.arguments[1] as Node | undefined, 'prefix');
    const prefix = prefixNode ? (this.constPath(prefixNode, scope) ?? this.importRef(prefixNode, scope)) : undefined;
    let ref: RefExpr | undefined;
    if (isFunctionLike(plugin)) {
      const key = `(plugin@${posOf(plugin).line}:${posOf(plugin).column})`;
      this.pluginFunctions.add(plugin);
      this.visitFunction(plugin as t.Function, scope, key, key);
      ref = { k: 'fn', key };
    } else {
      ref = this.refOf(plugin, scope);
    }
    if (!ref || (ref.k !== 'fn' && ref.k !== 'import' && ref.k !== 'call')) return false;
    this.facts.injections.push({ callee: ref.k === 'call' ? ref.callee : ref, argIndex: 0, parent, pos: posOf(callee.property), paths: [prefix ?? { parts: [{ lit: '' }] }] });
    for (const a of node.arguments.slice(1)) this.walk(a as Node, scope);
    return true;
  }

  /** Koa `router.prefix('/v1')` on a router created in this file. */
  private handleKoaPrefix(node: t.CallExpression | t.OptionalCallExpression, callee: t.MemberExpression | t.OptionalMemberExpression, scope: Scope): void {
    const ref = this.refOf(callee.object, scope);
    const arg = node.arguments[0] as Node | undefined;
    if (ref?.k !== 'node' || !arg) return;
    const router = this.facts.routers.find((r) => r.key === ref.key);
    const prefix = this.constPath(arg, scope) ?? this.importRef(arg, scope);
    if (router && router.lib === 'koa' && prefix) router.prefix = prefix;
  }

  // -------------------------------------------------------------------------------------------
  // HTTP clients: fetch, axios, ky, Angular HttpClient, supertest
  // -------------------------------------------------------------------------------------------

  private handleClientCall(node: t.CallExpression | t.OptionalCallExpression, callee: Node, scope: Scope): boolean {
    const args = node.arguments.filter((a): a is t.Expression => a.type !== 'SpreadElement' && a.type !== 'ArgumentPlaceholder') as Node[];
    // `fetch(url, { method })`, `axios(url | config)`, `ky(url)`, `$fetch(url)`
    if (callee.type === 'Identifier' && args[0]) {
      const name = callee.name;
      const lib = this.clientLibs.get(name);
      const isFetch = FETCH_FUNCTIONS.has(name) && (!scope.get(name) || lib === 'fetch');
      if (!isFetch && (!lib || lib === 'supertest')) return false;
      const client = isFetch ? (lib ?? name) : lib!;
      const first = unwrap(args[0]);
      if (first.type === 'ObjectExpression') {
        const url = this.objectProp(first, 'url');
        return url ? this.recordClientCall(client, this.methodFrom(this.objectProp(first, 'method')), url, node, scope, false) : false;
      }
      return this.recordClientCall(client, this.fetchMethod(args[1], scope), args[0], node, scope, false);
    }
    if (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') return false;
    const prop = propName(callee);
    const verb = prop ? HTTP_VERBS[prop.toLowerCase()] : undefined;
    if (!prop || (!verb && prop !== 'request') || !args[0]) return false;
    const recv = unwrap(callee.object);
    // supertest: `request(app).get('/x')`, `request(app.getHttpServer()).post('/x')`
    if (recv.type === 'CallExpression' && unwrap(recv.callee as Node).type === 'Identifier' && this.clientLibs.get((unwrap(recv.callee as Node) as t.Identifier).name) === 'supertest') {
      return verb ? this.recordClientCall('supertest', verb, args[0], node, scope, false) : false;
    }
    const client = this.clientReceiver(recv, scope, args);
    if (!client) return false;
    if (prop === 'request') {
      const cfg = args[0];
      const url = this.objectProp(cfg, 'url');
      return url ? this.recordClientCall(client.client, this.methodFrom(this.objectProp(cfg, 'method')), url, node, scope, client.unknownBase, client.base) : false;
    }
    return this.recordClientCall(client.client, verb, args[0], node, scope, client.unknownBase, client.base);
  }

  /** Identifies `axios`, `ky`, axios instances, `this.http` (Angular HttpClient) and imported API clients. */
  private clientReceiver(recv: Node, scope: Scope, args: Node[]): { client: string; unknownBase: boolean; base?: PathExpr } | undefined {
    if (recv.type === 'Identifier') {
      const lib = this.clientLibs.get(recv.name);
      if (lib && lib !== 'supertest') return { client: lib, unknownBase: false };
      const instance = this.clientInstances.get(recv.name);
      if (instance) return { client: instance.client, unknownBase: false, base: instance.base };
      // An imported client instance: only when the call can't be a route registration.
      const imp = own(this.facts.imports, recv.name);
      if (imp && !scope.get(recv.name) && imp.source.startsWith('.') && CLIENT_NAME.test(recv.name) && !args.slice(1).some((a) => this.looksLikeHandler(a))) {
        return { client: recv.name, unknownBase: true };
      }
      return undefined;
    }
    if (recv.type === 'MemberExpression' && unwrap(recv.object).type === 'ThisExpression') {
      const prop = propName(recv);
      const type = prop ? own(this.currentClass()?.deps, prop) : undefined;
      if (type === 'HttpClient') return { client: 'HttpClient', unknownBase: false };
    }
    return undefined;
  }

  private looksLikeHandler(n: Node): boolean {
    const u = unwrap(n);
    if (isFunctionLike(u)) return true;
    if (u.type === 'Identifier') return !DATA_ARG.test(u.name);
    return u.type === 'MemberExpression' && !/(data|body|payload|params|config|options)$/i.test(propName(u) ?? '');
  }

  private methodFrom(node: Node | undefined, scope?: Scope): HttpMethod | undefined {
    if (!node) return undefined;
    const u = unwrap(node);
    if (u.type === 'StringLiteral') return verbOf({ parts: [{ lit: u.value }] });
    return scope && u.type === 'Identifier' ? verbOf(this.constPath(u, scope)) : undefined;
  }

  /**
   * The method of `fetch(url, options)`: GET without options, otherwise `options.method`, also when
   * `options` is a local object (`const requestOptions = { method: 'POST' }`). Undefined (any
   * method) when the options can't be read.
   */
  private fetchMethod(options: Node | undefined, scope: Scope): HttpMethod | undefined {
    if (!options) return 'GET';
    const n = unwrap(options);
    if (n.type === 'ObjectExpression') {
      const method = this.objectProp(n, 'method');
      return method ? this.methodFrom(method, scope) : 'GET';
    }
    if (n.type !== 'Identifier') return undefined;
    const method = scope.get(`${n.name}.method`);
    if (method?.kind === 'const') return verbOf(method.expr);
    // A local object literal without `method`; anything else (a parameter, a call result) is unknown.
    return scope.constsUnder(n.name).size > 0 ? 'GET' : undefined;
  }

  private recordClientCall(client: string, method: HttpMethod | undefined, urlNode: Node, call: Node, scope: Scope, unknownBase: boolean, base?: PathExpr): boolean {
    const u = unwrap(urlNode);
    if (isFunctionLike(u) || u.type === 'ObjectExpression') return false;
    const url = this.constPath(u, scope) ?? this.importRef(u, scope) ?? { parts: [{ dynamic: memberText(u) ?? shortLabel(u) }] };
    const full = base ? compactExpr({ parts: [...base.parts, ...url.parts] }) : url;
    const end = u.loc?.end;
    const fact: ClientCallFact = {
      client,
      method,
      url: full,
      unknownBase: unknownBase || undefined,
      pos: posOf(call),
      start: posOf(u),
      end: { line: end?.line ?? posOf(u).line, column: (end?.column ?? 0) + 1 },
    };
    this.facts.clientCalls.push(fact);
    return true;
  }

  /** `app.listen(port)` on an Express app, a Nest app, or an app imported from another module. */
  private handleListen(node: t.CallExpression | t.OptionalCallExpression, callee: t.MemberExpression | t.OptionalMemberExpression, scope: Scope): void {
    const receiver = this.refOf(callee.object, scope);
    if (!this.usesNest && receiver?.k !== 'node' && receiver?.k !== 'import') return;
    const arg = node.arguments[0];
    if (!arg || arg.type === 'SpreadElement' || arg.type === 'ArgumentPlaceholder') return;
    const port = this.portValue(arg as Node);
    if (port !== undefined) this.facts.listenPort = { port, pos: posOf(node) };
  }

  /** Evaluates `3000`, `'3000'`, `process.env.PORT || 3000`, `Number(x ?? 3000)` and port constants. */
  private portValue(node: Node): number | undefined {
    const n = unwrap(node);
    let value: number | undefined;
    if (n.type === 'NumericLiteral') value = n.value;
    else if (n.type === 'StringLiteral' && /^\d+$/.test(n.value)) value = Number(n.value);
    else if (n.type === 'LogicalExpression' && (n.operator === '||' || n.operator === '??')) value = this.portValue(n.right) ?? this.portValue(n.left);
    // Fastify: `app.listen({ port: 3000 })`
    else if (n.type === 'ObjectExpression') {
      const port = this.objectProp(n, 'port');
      value = port ? this.portValue(port) : undefined;
    }
    else if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && ['Number', 'parseInt'].includes(n.callee.name) && n.arguments[0]) {
      value = this.portValue(n.arguments[0] as Node);
    } else if (n.type === 'Identifier') value = this.portConsts.get(n.name);
    return value !== undefined && Number.isInteger(value) && value > 0 && value < 65536 ? value : undefined;
  }

  private handleGlobalPrefix(node: t.CallExpression | t.OptionalCallExpression, scope: Scope): void {
    const arg = node.arguments[0];
    if (!arg || arg.type === 'SpreadElement' || arg.type === 'ArgumentPlaceholder') return;
    const prefix = this.constPath(arg as Node, scope) ?? this.importRef(arg as Node, scope) ?? { parts: [{ dynamic: memberText(arg as Node) ?? shortLabel(arg as Node) }] };
    const exclude: { path: string; method?: HttpMethod }[] = [];
    const ex = this.objectProp(node.arguments[1] as Node | undefined, 'exclude');
    if (ex && unwrap(ex).type === 'ArrayExpression') {
      for (const el of (unwrap(ex) as t.ArrayExpression).elements) {
        if (!el) continue;
        const e = unwrap(el as Node);
        if (e.type === 'StringLiteral') exclude.push({ path: e.value });
        else if (e.type === 'ObjectExpression') {
          const p = this.objectProp(e, 'path');
          const m = this.objectProp(e, 'method');
          const methodText = m ? memberText(m)?.split('.').pop() : undefined;
          if (p && unwrap(p).type === 'StringLiteral') {
            exclude.push({
              path: (unwrap(p) as t.StringLiteral).value,
              method: methodText && methodText in NEST_METHOD_DECORATORS_UPPER ? NEST_METHOD_DECORATORS_UPPER[methodText] : undefined,
            });
          }
        }
      }
    }
    this.facts.nestGlobalPrefix = { prefix, exclude, pos: posOf(node) };
  }

  private handleVersioning(node: t.CallExpression | t.OptionalCallExpression): void {
    const opts = node.arguments[0] as Node | undefined;
    const typeNode = this.objectProp(opts, 'type');
    const typeText = typeNode ? memberText(typeNode)?.split('.').pop() : undefined;
    const prefixNode = this.objectProp(opts, 'prefix');
    let prefix: string | false = 'v';
    if (prefixNode) {
      const p = unwrap(prefixNode);
      if (p.type === 'StringLiteral') prefix = p.value;
      else if (p.type === 'BooleanLiteral' && !p.value) prefix = false;
    }
    const type = typeText === 'URI' || typeText === 'HEADER' || typeText === 'MEDIA_TYPE' || typeText === 'CUSTOM' ? typeText : 'UNKNOWN';
    this.facts.nestVersioning = {
      type,
      prefix,
      defaultVersions: this.stringList(this.objectProp(opts, 'defaultVersion')),
      pos: posOf(node),
    };
  }

  private handleRouterModule(node: t.CallExpression | t.OptionalCallExpression): void {
    const arg = node.arguments[0] as Node | undefined;
    if (!arg) return;
    const parse = (n: Node): NestRouterModuleRoute[] => {
      const u = unwrap(n);
      if (u.type !== 'ArrayExpression') return [];
      const out: NestRouterModuleRoute[] = [];
      for (const el of u.elements) {
        if (!el) continue;
        const e = unwrap(el as Node);
        if (e.type === 'Identifier') {
          out.push({ path: '', module: e.name, children: [] });
        } else if (e.type === 'ObjectExpression') {
          const p = this.objectProp(e, 'path');
          const m = this.objectProp(e, 'module');
          const c = this.objectProp(e, 'children');
          out.push({
            path: p && unwrap(p).type === 'StringLiteral' ? (unwrap(p) as t.StringLiteral).value : '',
            module: m && unwrap(m).type === 'Identifier' ? (unwrap(m) as t.Identifier).name : undefined,
            children: c ? parse(c) : [],
          });
        }
      }
      return out;
    };
    this.facts.nestRouterModule.push(...parse(arg));
  }
}

const NEST_METHOD_DECORATORS_UPPER = table<HttpMethod>({
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  PATCH: 'PATCH',
  DELETE: 'DELETE',
  OPTIONS: 'OPTIONS',
  HEAD: 'HEAD',
  ALL: 'ALL',
});

function bindingToRef(binding: Binding): RefExpr | undefined {
  switch (binding.kind) {
    case 'router':
      return { k: 'node', key: binding.key };
    case 'fn':
      return { k: 'fn', key: binding.key };
    case 'class':
      return { k: 'class', name: binding.name };
    case 'instance':
      return { k: 'instance', className: binding.className };
    case 'alias':
      return binding.ref;
    default:
      return undefined;
  }
}

/** Request properties that carry the body: `req.body`, `request.body`, `ctx.request.body`. */
const BODY_ACCESS = /(^|\.)(body|payload)$/;
const SCHEMA_CHECK = /(valid|parse|assert|schema|check|decode|cast)/i;

/** True when the function passes the request body to something that looks like a schema check. */
/** Indexes of parameters the function calls with no arguments, like `next()`; `next(err)` does not count. */
function forwardedParams(fn: t.Function): number[] | undefined {
  const names = new Map<string, number>();
  fn.params.forEach((p, i) => {
    if (p.type === 'Identifier') names.set(p.name, i);
  });
  if (names.size === 0) return undefined;
  const found = new Set<number>();
  const visit = (n: Node): void => {
    if ((n.type === 'CallExpression' || n.type === 'OptionalCallExpression') && n.callee.type === 'Identifier' && n.arguments.length === 0) {
      const i = names.get(n.callee.name);
      if (i !== undefined) found.add(i);
    }
    forEachChild(n, visit);
  };
  visit(fn.body);
  return found.size > 0 ? [...found] : undefined;
}

function validatesBody(fn: t.Function): boolean {
  let found = false;
  const visit = (n: Node): void => {
    if (found) return;
    if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') {
      const calleeText = memberText(n.callee as Node) ?? '';
      if (SCHEMA_CHECK.test(calleeText) && n.arguments.some((a) => BODY_ACCESS.test(memberText(a as Node) ?? ''))) {
        found = true;
        return;
      }
    }
    forEachChild(n, visit);
  };
  visit(fn.body);
  return found;
}

const HTTP_STATUS_NAMES: Record<string, number> = { OK: 200, CREATED: 201, ACCEPTED: 202, NO_CONTENT: 204, MOVED_PERMANENTLY: 301, FOUND: 302, BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409 };

/** The response type of a handler: `Promise<UserDto>` and `Observable<UserDto[]>` unwrap to the inner type. */
function responseTypeName(annotation: Node | null | undefined): string | undefined {
  if (!annotation) return undefined;
  let node: Node = annotation.type === 'TSTypeAnnotation' ? annotation.typeAnnotation : annotation;
  for (let i = 0; i < 3; i++) {
    if (node.type !== 'TSTypeReference' || node.typeName.type !== 'Identifier' || !/^(Promise|Observable)$/.test(node.typeName.name)) break;
    const inner: Node | undefined = node.typeParameters?.params[0];
    if (!inner) return undefined;
    node = inner;
  }
  return typeNameOf(node);
}

/** Service functions only contribute their data access calls. */
function dataAccessOnly(body: BodyFacts | undefined): BodyFacts | undefined {
  return body?.dataAccess ? { dataAccess: body.dataAccess } : undefined;
}
