/**
 * What a request handler does with the request and response, from its syntax alone: the shapes it
 * responds with (`res.status(404).json({ error })`, `ctx.body = x`, `return x`), the data access
 * calls it makes, and evidence for security rules (request input reaching a query, a redirect, a
 * file path or a model write; error details in responses).
 *
 * Shapes are derived from object and array literals and from local constants; anything else is
 * `unknown`. Nothing is executed, and no string values are kept except status codes.
 */
import type * as t from '@babel/types';
import { forEachChild, isFunctionLike, keyName, memberText, posOf, propName, shortLabel, unwrap, type Node } from './babelUtils';
import type { BodyFacts, ResponseFact, RiskFact, Shape, ShapeProp } from './facts';

export interface BodyOptions {
  /** Request parameter (`req`, `request`) or Koa context (`ctx`). */
  req?: string;
  /** Response parameter (`res`, `reply`). */
  res?: string;
  koa?: boolean;
  /** Local names holding the whole request body (Nest `@Body() dto`). */
  bodyVars?: string[];
  /** Local names holding path parameters (Nest `@Param('id') id`). */
  paramVars?: string[];
  /** Local names holding query values. */
  queryVars?: string[];
  /** The handler receives the authenticated user (Nest `@CurrentUser()`, `@Req()`). */
  receivesUser?: boolean;
  /** Record `return` values as responses (Nest, Fastify, Koa-style async handlers). */
  returns?: boolean;
}

const MAX_DEPTH = 6;
const MAX_PROPS = 80;
const MAX_RESPONSES = 24;
const MAX_RISKS = 24;

const DATA_METHODS = new Set([
  'find', 'findOne', 'findById', 'findByPk', 'findAll', 'findMany', 'findUnique', 'findFirst', 'findOneBy', 'findBy', 'findAndCountAll',
  'create', 'createMany', 'insert', 'insertOne', 'insertMany', 'bulkCreate', 'build',
  'update', 'updateOne', 'updateMany', 'findByIdAndUpdate', 'findOneAndUpdate', 'upsert', 'save', 'merge', 'replaceOne',
  'delete', 'deleteOne', 'deleteMany', 'destroy', 'remove', 'findByIdAndDelete', 'findOneAndDelete', 'findByIdAndRemove',
  'aggregate', 'count', 'countDocuments',
]);
const WRITE_METHODS = new Set(['create', 'createMany', 'insert', 'insertOne', 'insertMany', 'bulkCreate', 'build', 'update', 'updateOne', 'updateMany', 'findByIdAndUpdate', 'findOneAndUpdate', 'upsert', 'save', 'merge', 'replaceOne']);
const FILTER_METHODS = new Set(['find', 'findOne', 'findAll', 'findMany', 'findFirst', 'count', 'countDocuments', 'deleteMany', 'updateMany', 'deleteOne']);
/** Capitalised globals that are not models. */
const NOT_MODELS = new Set(['Object', 'Array', 'JSON', 'Promise', 'Math', 'Number', 'String', 'Boolean', 'Date', 'Map', 'Set', 'Reflect', 'Buffer', 'Error', 'URL', 'Intl', 'Symbol', 'RegExp']);
const MODEL_RECEIVER = /(repository|repo|model|dao|collection|table)$/i;
const SQL_CALLEE = /^(query|raw|execute|exec|\$queryRawUnsafe|\$executeRawUnsafe|unsafe|whereRaw|orderByRaw|havingRaw)$/;
const COMMAND_CALLEE = /^(exec|execSync|spawn|spawnSync|execFile|execFileSync)$/;
const FILE_CALLEE = /^(sendFile|download|readFile|readFileSync|createReadStream|unlink|unlinkSync|writeFile|writeFileSync|rm|rmSync|readdir|readdirSync)$/;
const USER_FIELD = /^(user|auth|session|currentUser|principal|claims)$/;
const SENSITIVE_MODEL = /^(user|users|account|accounts|customer|customers|member|members|admin|admins|employee|employees|profile|profiles)$/i;
const NEST_EXCEPTIONS: Record<string, number> = {
  BadRequestException: 400,
  UnauthorizedException: 401,
  ForbiddenException: 403,
  NotFoundException: 404,
  MethodNotAllowedException: 405,
  NotAcceptableException: 406,
  RequestTimeoutException: 408,
  ConflictException: 409,
  GoneException: 410,
  PayloadTooLargeException: 413,
  UnsupportedMediaTypeException: 415,
  UnprocessableEntityException: 422,
  InternalServerErrorException: 500,
  NotImplementedException: 501,
  BadGatewayException: 502,
  ServiceUnavailableException: 503,
  GatewayTimeoutException: 504,
};

type Taint = 'body' | 'param' | 'query' | 'input';

/** Facts for one handler function, or undefined when there is nothing to report. */
export function analyzeBody(fn: t.Function, options: BodyOptions): BodyFacts | undefined {
  return new BodyAnalyzer(fn, options).run();
}

/** The conventional request/response parameter names of a handler, by position. */
export function handlerParams(fn: t.Function): { req?: string; res?: string; koa: boolean } {
  const name = (i: number): string | undefined => {
    const p = fn.params[i];
    const id = p && (p.type === 'AssignmentPattern' ? p.left : p);
    return id && id.type === 'Identifier' ? id.name : undefined;
  };
  // Express error middleware: `(err, req, res, next)`.
  if (fn.params.length === 4) return { req: name(1), res: name(2), koa: false };
  const first = name(0);
  const koa = !!first && /^(ctx|context)$/.test(first);
  return { req: first, res: koa ? undefined : name(1), koa };
}

/** True when the parameters look like a request handler: `(req, res)`, `(request, reply)`, `(ctx)`. */
export function looksLikeHandler(fn: t.Function): boolean {
  const { req, res, koa } = handlerParams(fn);
  if (koa) return true;
  return !!req && /^(req|request|_req|_request|_)$/.test(req) && (!res || /^(res|reply|response|_res|h)$/.test(res));
}

class BodyAnalyzer {
  private readonly env = new Map<string, Node | null>();
  /** Assignments `obj.key = value` to local objects. */
  private readonly memberWrites = new Map<string, { key: string; value: Node }[]>();
  private readonly taint = new Map<string, Taint>();
  private readonly responses: ResponseFact[] = [];
  private readonly risks: RiskFact[] = [];
  private readonly dataAccess = new Set<string>();
  private readsUser = false;
  private paramIdToData = false;
  /** Catch-clause and error-middleware parameter names. */
  private readonly errorNames = new Set<string>();

  constructor(
    private readonly fn: t.Function,
    private readonly o: BodyOptions,
  ) {
    for (const v of o.bodyVars ?? []) this.taint.set(v, 'body');
    for (const v of o.paramVars ?? []) this.taint.set(v, 'param');
    for (const v of o.queryVars ?? []) this.taint.set(v, 'query');
    if (o.receivesUser) this.readsUser = true;
    if (fn.params.length === 4) {
      const p = fn.params[0];
      if (p.type === 'Identifier') this.errorNames.add(p.name);
    }
  }

  run(): BodyFacts | undefined {
    this.collect(this.fn.body as Node);
    // Taint flows through aliases declared in any order: iterate to a fixpoint.
    for (let i = 0; i < 3; i++) if (!this.propagateTaint()) break;
    this.visit(this.fn.body as Node, false);
    if (this.o.returns) this.collectReturns();
    const out: BodyFacts = {};
    if (this.responses.length) out.responses = this.responses.slice(0, MAX_RESPONSES);
    if (this.risks.length) out.risks = this.risks.slice(0, MAX_RISKS);
    if (this.dataAccess.size) out.dataAccess = [...this.dataAccess].slice(0, 12);
    if (this.readsUser) out.readsUser = true;
    if (this.paramIdToData) out.paramIdToData = true;
    return Object.keys(out).length ? out : undefined;
  }

  // -------------------------------------------------------------------------------------------
  // Declarations and taint
  // -------------------------------------------------------------------------------------------

  private collect(node: Node): void {
    if (node.type === 'VariableDeclarator') {
      if (node.id.type === 'Identifier') this.declare(node.id.name, node.init ? unwrap(node.init) : null);
      else if (node.init) this.declarePattern(node.id as Node, unwrap(node.init));
    } else if (node.type === 'AssignmentExpression' && node.operator === '=') {
      const left = node.left as Node;
      if (left.type === 'Identifier') this.declare(left.name, null);
      else if (left.type === 'MemberExpression' && unwrap(left.object).type === 'Identifier') {
        const obj = (unwrap(left.object) as t.Identifier).name;
        const key = propName(left);
        if (key) this.memberWrites.set(obj, [...(this.memberWrites.get(obj) ?? []), { key, value: unwrap(node.right) }]);
      }
    } else if (node.type === 'CatchClause' && node.param?.type === 'Identifier') {
      this.errorNames.add(node.param.name);
    }
    forEachChild(node, (c) => this.collect(c));
  }

  /** A name declared once keeps its initialiser; a reassigned name is ambiguous (`null`). */
  private declare(name: string, init: Node | null): void {
    this.env.set(name, this.env.has(name) ? null : init);
  }

  private declarePattern(pattern: Node, init: Node): void {
    const source = this.inputKind(init);
    if (pattern.type === 'ObjectPattern') {
      for (const p of pattern.properties) {
        if (p.type === 'RestElement') {
          if (p.argument.type === 'Identifier') {
            this.declare(p.argument.name, null);
            if (source) this.taint.set(p.argument.name, source);
          }
          continue;
        }
        const value = p.value.type === 'AssignmentPattern' ? p.value.left : p.value;
        if (value.type === 'Identifier') {
          this.declare(value.name, null);
          if (source) this.taint.set(value.name, source === 'body' ? 'input' : source);
        } else {
          this.declarePattern(value as Node, init);
        }
      }
    } else if (pattern.type === 'ArrayPattern') {
      for (const el of pattern.elements) if (el?.type === 'Identifier') this.declare(el.name, null);
    }
  }

  private propagateTaint(): boolean {
    let changed = false;
    for (const [name, init] of this.env) {
      if (!init || this.taint.has(name)) continue;
      const kind = this.inputKind(init) ?? (this.containsInput(init) ? 'input' : undefined);
      if (kind) {
        this.taint.set(name, kind);
        changed = true;
      }
    }
    return changed;
  }

  /** `req.body` (whole), `req.params.id`, `ctx.request.body`, a tainted alias; undefined otherwise. */
  private inputKind(node: Node): Taint | undefined {
    const n = unwrap(node);
    if (n.type === 'AwaitExpression') return this.inputKind(n.argument);
    if (n.type === 'Identifier') return this.taint.get(n.name);
    const text = memberText(n);
    if (!text) return undefined;
    const { req } = this.o;
    if (!req) return undefined;
    const rest = text.startsWith(req + '.') ? text.slice(req.length + 1) : undefined;
    if (rest === undefined) {
      const root = text.split('.')[0];
      const t = this.taint.get(root);
      return t ? (t === 'body' ? 'input' : t) : undefined;
    }
    if (this.o.koa) {
      if (rest === 'request.body') return 'body';
      if (rest.startsWith('request.body.')) return 'input';
      if (rest === 'params' || rest.startsWith('params.')) return 'param';
      if (/^(request\.)?query(\.|$)/.test(rest)) return 'query';
      return undefined;
    }
    if (rest === 'body') return 'body';
    if (rest.startsWith('body.')) return 'input';
    if (rest === 'params' || rest.startsWith('params.')) return 'param';
    if (rest === 'query' || rest.startsWith('query.')) return 'query';
    if (/^(headers|cookies|signedCookies)(\.|$)/.test(rest)) return 'input';
    return undefined;
  }

  private containsInput(node: Node, depth = 0): boolean {
    if (depth > 8) return false;
    const n = unwrap(node);
    if (isFunctionLike(n)) return false;
    if (this.inputKind(n)) return true;
    // `path.basename(x)` and `Number(x)` neutralise path and injection payloads.
    if (n.type === 'CallExpression') {
      const callee = memberText(n.callee as Node) ?? '';
      if (/(^|\.)basename$|^(Number|parseInt|parseFloat|Boolean|encodeURIComponent|escape|sanitize\w*|validator\.\w+)$/.test(callee)) return false;
    }
    let found = false;
    forEachChild(n, (c) => {
      if (!found && this.containsInput(c, depth + 1)) found = true;
    });
    return found;
  }

  // -------------------------------------------------------------------------------------------
  // Visit: responses, data access, risks
  // -------------------------------------------------------------------------------------------

  private visit(node: Node, inCatch: boolean): void {
    switch (node.type) {
      case 'CallExpression':
      case 'OptionalCallExpression':
        this.call(node, inCatch);
        break;
      case 'NewExpression':
        this.newExpr(node);
        break;
      case 'AssignmentExpression':
        this.koaAssignment(node);
        break;
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        this.member(node);
        break;
      case 'ThrowStatement':
        this.throwStatement(node);
        break;
      case 'CatchClause':
        forEachChild(node, (c) => this.visit(c, true));
        return;
      default:
        break;
    }
    forEachChild(node, (c) => this.visit(c, inCatch));
  }

  private member(node: t.MemberExpression | t.OptionalMemberExpression): void {
    if (this.readsUser) return;
    const text = memberText(node);
    if (!text) return;
    const parts = text.split('.');
    const { req } = this.o;
    if (req && parts[0] === req && (USER_FIELD.test(parts[1] ?? '') || (parts[1] === 'state' && USER_FIELD.test(parts[2] ?? '')) || (parts[1] === 'session' && USER_FIELD.test(parts[2] ?? '')))) {
      this.readsUser = true;
    }
    if (parts[0] === 'res' && parts[1] === 'locals' && USER_FIELD.test(parts[2] ?? '')) this.readsUser = true;
  }

  private call(node: t.CallExpression | t.OptionalCallExpression, inCatch: boolean): void {
    const callee = unwrap(node.callee as Node);
    const args = node.arguments.filter((a): a is t.Expression => a.type !== 'SpreadElement' && a.type !== 'ArgumentPlaceholder') as Node[];
    const calleeText = memberText(callee);
    const prop = callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression' ? propName(callee) : callee.type === 'Identifier' ? callee.name : undefined;

    const site = this.responseSite(node);
    if (site) {
      const status = site.status;
      if (site.kind === 'status') this.addResponse({ status, via: 'status', pos: posOf(node) });
      else if (site.kind === 'redirect') this.risk('open-redirect', node, args[args.length - 1]);
      else {
        const arg = args[0];
        this.addResponse({ status, shape: arg ? this.shape(arg, 0) : undefined, via: site.kind, pos: posOf(node) });
        if (arg) this.errorDetails(arg, node, inCatch);
        if (arg) this.recordResponse(arg, node);
      }
    }

    // Data access.
    if (prop && DATA_METHODS.has(prop) && callee.type !== 'Identifier') {
      const recv = unwrap((callee as t.MemberExpression).object);
      const recvText = memberText(recv);
      const root = recvText?.split('.')[0];
      const last = recvText?.split('.').pop() ?? '';
      const isModel =
        (recv.type === 'Identifier' && /^[A-Z]/.test(recv.name) && !NOT_MODELS.has(recv.name)) ||
        (!!recvText && (MODEL_RECEIVER.test(last) || /^(prisma|db|knex|this\.prisma|this\.db)\.\w+$/.test(recvText) || /^this\.\w*(repository|repo|model)$/i.test(recvText))) ||
        (!!root && /^(prisma|db)$/.test(root));
      if (isModel && recvText) {
        this.dataAccess.add(`${recvText.replace(/^this\./, '')}.${prop}`);
        if (args.some((a) => this.taintOf(a) === 'param' || (unwrap(a).type === 'ObjectExpression' && this.containsTaint(a, 'param')))) this.paramIdToData = true;
        if (WRITE_METHODS.has(prop)) {
          const whole = args.find((a) => this.isWholeBody(a));
          if (whole) this.risk('mass-assignment', node, whole);
        }
        if (FILTER_METHODS.has(prop) && args[0] && this.isWholeInputObject(args[0])) this.risk('injection', node, args[0], 'nosql');
      }
    }
    if (calleeText === 'Object.assign' && args.slice(1).some((a) => this.isWholeBody(a))) this.risk('mass-assignment', node, args.find((a, i) => i > 0 && this.isWholeBody(a)));

    // Injection.
    if (prop && SQL_CALLEE.test(prop) && args[0] && this.isBuiltString(args[0]) && this.containsInput(args[0])) this.risk('injection', node, args[0], 'sql');
    if (prop && COMMAND_CALLEE.test(prop) && args[0] && this.containsInput(args[0])) this.risk('injection', node, args[0], 'command');
    if ((calleeText === 'eval' || calleeText === 'Function' || /^vm\.run/.test(calleeText ?? '')) && args[0] && this.containsInput(args[0])) this.risk('injection', node, args[0], 'code');
    // File paths from request input.
    if (prop && FILE_CALLEE.test(prop) && args[0] && this.containsInput(args[0])) this.risk('path-traversal', node, args[0]);
  }

  private newExpr(node: t.NewExpression): void {
    const callee = unwrap(node.callee as Node);
    if (callee.type === 'Identifier') {
      const status = NEST_EXCEPTIONS[callee.name];
      if (status) return; // recorded by throwStatement
      if (/^[A-Z]/.test(callee.name) && !NOT_MODELS.has(callee.name) && node.arguments[0] && this.isWholeBody(node.arguments[0] as Node)) {
        this.risk('mass-assignment', node, node.arguments[0] as Node);
      }
      if (callee.name === 'Function' && node.arguments.some((a) => this.containsInput(a as Node))) this.risk('injection', node, node.arguments[0] as Node, 'code');
    }
  }

  private throwStatement(node: t.ThrowStatement): void {
    const arg = unwrap(node.argument);
    if (arg.type !== 'NewExpression' || unwrap(arg.callee as Node).type !== 'Identifier') return;
    const name = (unwrap(arg.callee as Node) as t.Identifier).name;
    const status = NEST_EXCEPTIONS[name];
    if (status) this.addResponse({ status, via: 'throw', pos: posOf(node) });
  }

  /** Koa: `ctx.body = x`, `ctx.status = 404`, `ctx.redirect(url)` is handled with calls. */
  private koaAssignment(node: t.AssignmentExpression): void {
    if (!this.o.koa || !this.o.req) return;
    const text = memberText(node.left as Node);
    if (text === `${this.o.req}.body`) {
      this.addResponse({ shape: this.shape(unwrap(node.right), 0), via: 'body', pos: posOf(node) });
      this.recordResponse(node.right, node);
    } else if (text === `${this.o.req}.status`) {
      const v = unwrap(node.right);
      if (v.type === 'NumericLiteral') this.addResponse({ status: v.value, via: 'status', pos: posOf(node) });
    }
  }

  /**
   * `res.json(x)`, `res.status(201).send(x)`, `reply.code(404).send()`, `res.sendStatus(204)`,
   * `res.redirect(url)`; the receiver chain must start at the response (or Koa context) parameter.
   */
  private responseSite(node: t.CallExpression | t.OptionalCallExpression): { kind: 'json' | 'send' | 'status' | 'redirect'; status?: number } | undefined {
    const callee = unwrap(node.callee as Node);
    if (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') return undefined;
    const prop = propName(callee);
    if (!prop) return undefined;
    let status: number | undefined;
    let obj = unwrap(callee.object);
    // Walk back through `.status(n)`, `.code(n)`, `.type(...)`, `.set(...)`, `.header(...)`.
    for (let i = 0; i < 6 && (obj.type === 'CallExpression' || obj.type === 'OptionalCallExpression'); i++) {
      const c = unwrap(obj.callee as Node);
      if (c.type !== 'MemberExpression' && c.type !== 'OptionalMemberExpression') return undefined;
      const p = propName(c);
      if (p === 'status' || p === 'code') {
        const a = obj.arguments[0] && unwrap(obj.arguments[0] as Node);
        if (a?.type === 'NumericLiteral') status = a.value;
      } else if (!p || !/^(type|set|header|headers|append|cookie|clearCookie|vary|location|links|attachment|contentType)$/.test(p)) {
        return undefined;
      }
      obj = unwrap(c.object);
    }
    const root = memberText(obj);
    const isRes = !!root && (root === this.o.res || (this.o.koa && root === this.o.req));
    if (!isRes) return undefined;
    if (prop === 'json' || prop === 'jsonp') return { kind: 'json', status };
    if (prop === 'send') return { kind: 'send', status };
    if (prop === 'sendStatus') {
      const a = node.arguments[0] && unwrap(node.arguments[0] as Node);
      return { kind: 'status', status: a?.type === 'NumericLiteral' ? a.value : undefined };
    }
    if (prop === 'end' && status !== undefined) return { kind: 'status', status };
    if (prop === 'redirect' && node.arguments.length > 0 && this.containsInput(node.arguments[node.arguments.length - 1] as Node)) return { kind: 'redirect', status };
    return undefined;
  }

  private collectReturns(): void {
    const visit = (node: Node): void => {
      if (node !== (this.fn as Node) && isFunctionLike(node)) return;
      if (node.type === 'ReturnStatement' && node.argument) {
        const arg = unwrap(node.argument);
        // `return res.json(...)` was recorded as a response call.
        const isResCall = (arg.type === 'CallExpression' && !!this.responseSite(arg)) || (arg.type === 'CallExpression' && memberText(arg.callee as Node)?.startsWith(`${this.o.res}.`));
        if (!isResCall) {
          this.addResponse({ shape: this.shape(arg, 0), via: 'return', pos: posOf(node) });
          this.recordResponse(arg, node);
        }
      }
      forEachChild(node, visit);
    };
    if (this.fn.body.type !== 'BlockStatement') {
      const arg = unwrap(this.fn.body as Node);
      this.addResponse({ shape: this.shape(arg, 0), via: 'return', pos: posOf(arg) });
      return;
    }
    visit(this.fn.body as Node);
  }

  private addResponse(r: ResponseFact): void {
    if (r.shape?.t === 'unknown' && !r.shape.expr) delete r.shape;
    this.responses.push(r);
  }

  /** A response that sends a whole user-like record straight from the database. */
  private recordResponse(arg: Node, site: Node): void {
    const n = unwrap(arg);
    const name = n.type === 'Identifier' ? n.name : undefined;
    const init = name ? this.env.get(name) : n;
    if (!init) return;
    const call = unwrap(init.type === 'AwaitExpression' ? init.argument : init);
    if (call.type !== 'CallExpression') return;
    const callee = unwrap(call.callee as Node);
    if (callee.type !== 'MemberExpression') return;
    const method = propName(callee);
    const recv = memberText(callee.object)?.replace(/^this\./, '');
    const model = recv?.split('.').pop()?.replace(/(Repository|Repo|Model)$/i, '');
    if (!method || !/^find/.test(method) || !model || !SENSITIVE_MODEL.test(model)) return;
    // `.select('-password')` or a projection argument mean the developer chose the fields.
    if (call.arguments.length > 1) return;
    this.risk('sensitive-response', site, arg, 'record', `${shortLabel(site)} sends ${name ?? 'the result of'} ${recv}.${method}(…) directly`);
  }

  /** `res.status(500).json({ error: err.message })`, `res.send(err)`, `{ stack: e.stack }`. */
  private errorDetails(arg: Node, site: Node, inCatch: boolean): void {
    if (this.errorNames.size === 0) return;
    let detail: string | undefined;
    let text: string | undefined;
    const visit = (n: Node): void => {
      if (detail === 'stack') return;
      const m = memberText(n);
      if (m) {
        const [root, prop] = m.split('.');
        if (this.errorNames.has(root)) {
          if (prop === 'stack') [detail, text] = ['stack', m];
          else if (!prop && detail !== 'stack') [detail, text] = ['object', m];
          else if ((prop === 'message' || prop === 'sqlMessage' || prop === 'errors') && !detail) [detail, text] = ['message', m];
          return;
        }
      }
      if (isFunctionLike(n)) return;
      forEachChild(n, visit);
    };
    const a = unwrap(arg);
    visit(a);
    if (!detail || !text || (!inCatch && this.fn.params.length !== 4)) return;
    const res = this.o.res ?? this.o.req ?? 'res';
    const evidence = a.type === 'Identifier' ? `${res}.send(${text})` : `${res}.json({ … ${text} … })`;
    this.risk('error-details', site, arg, detail, evidence);
  }

  // -------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------

  private taintOf(node: Node): Taint | undefined {
    return this.inputKind(node);
  }

  private containsTaint(node: Node, kind: Taint): boolean {
    const n = unwrap(node);
    if (this.taintOf(n) === kind) return true;
    let found = false;
    forEachChild(n, (c) => {
      if (!found && !isFunctionLike(c) && this.containsTaint(c, kind)) found = true;
    });
    return found;
  }

  /** `req.body`, an alias of it, `{ ...req.body }`, or Prisma's `{ data: req.body }`. */
  private isWholeBody(node: Node): boolean {
    const n = unwrap(node);
    if (this.taintOf(n) === 'body') return true;
    if (n.type === 'ObjectExpression') {
      for (const p of n.properties) {
        if (p.type === 'SpreadElement' && this.taintOf(p.argument) === 'body') return true;
        if (p.type === 'ObjectProperty' && keyName(p.key) === 'data' && this.isWholeBody(p.value as Node)) return true;
      }
    }
    return false;
  }

  /** A whole request object used as a query filter: `User.find(req.query)`, `findOne(req.body)`. */
  private isWholeInputObject(node: Node): boolean {
    const n = unwrap(node);
    const text = memberText(n);
    const { req } = this.o;
    return !!req && (text === `${req}.body` || text === `${req}.query`);
  }

  private isBuiltString(node: Node): boolean {
    const n = unwrap(node);
    return (n.type === 'TemplateLiteral' && n.expressions.length > 0) || (n.type === 'BinaryExpression' && n.operator === '+') || (n.type === 'Identifier' && this.taint.has(n.name));
  }

  private risk(rule: RiskFact['rule'], at: Node, arg: Node | undefined, detail?: string, evidence?: string): void {
    if (this.risks.length >= MAX_RISKS) return;
    const pos = posOf(at);
    if (this.risks.some((r) => r.rule === rule && r.pos.line === pos.line && r.pos.column === pos.column)) return;
    const label = evidence ?? callLabel(at, arg);
    this.risks.push({ rule, pos, evidence: label, detail });
  }

  // -------------------------------------------------------------------------------------------
  // Shapes
  // -------------------------------------------------------------------------------------------

  shape(node: Node, depth: number): Shape {
    const n = unwrap(node);
    if (depth > MAX_DEPTH) return { t: 'unknown' };
    switch (n.type) {
      case 'ObjectExpression':
        return this.objectShape(n, depth);
      case 'ArrayExpression': {
        const first = n.elements.find((e): e is t.Expression => !!e && e.type !== 'SpreadElement');
        return { t: 'array', items: first ? this.shape(first, depth + 1) : undefined };
      }
      case 'StringLiteral':
      case 'TemplateLiteral':
        return { t: 'string' };
      case 'NumericLiteral':
      case 'BigIntLiteral':
        return { t: 'number' };
      case 'BooleanLiteral':
        return { t: 'boolean' };
      case 'NullLiteral':
        return { t: 'null' };
      case 'UnaryExpression':
        if (n.operator === '!') return { t: 'boolean' };
        if (n.operator === '-' || n.operator === '+' || n.operator === '~') return { t: 'number' };
        if (n.operator === 'typeof') return { t: 'string' };
        return { t: 'unknown', expr: label(n) };
      case 'BinaryExpression':
        if (['==', '===', '!=', '!==', '<', '>', '<=', '>=', 'in', 'instanceof'].includes(n.operator)) return { t: 'boolean' };
        if (n.operator === '+') {
          const l = this.shape(n.left as Node, depth + 1);
          const r = this.shape(n.right, depth + 1);
          if (l.t === 'string' || r.t === 'string') return { t: 'string' };
          if (l.t === 'number' && r.t === 'number') return { t: 'number' };
          return { t: 'unknown', expr: label(n) };
        }
        return { t: 'number' };
      case 'AwaitExpression':
        return this.shape(n.argument, depth);
      case 'ConditionalExpression':
        return mergeShapes(this.shape(n.consequent, depth + 1), this.shape(n.alternate, depth + 1));
      case 'LogicalExpression':
        if (n.operator === '??' || n.operator === '||') {
          const l = this.shape(n.left, depth + 1);
          return l.t === 'unknown' ? mergeShapes(l, this.shape(n.right, depth + 1)) : l;
        }
        return { t: 'unknown', expr: label(n) };
      case 'Identifier': {
        if (n.name === 'undefined') return { t: 'unknown' };
        const init = this.env.get(n.name);
        if (init && !isFunctionLike(init)) {
          const s = this.shape(init, depth + 1);
          return this.withWrites(n.name, s, depth);
        }
        return { t: 'unknown', expr: n.name };
      }
      case 'CallExpression': {
        const callee = unwrap(n.callee as Node);
        // `items.map((i) => ({ id: i.id }))`
        if (callee.type === 'MemberExpression' && propName(callee) === 'map') {
          const cb = n.arguments[0] && unwrap(n.arguments[0] as Node);
          if (cb && (cb.type === 'ArrowFunctionExpression' || cb.type === 'FunctionExpression')) {
            const body = cb.body.type === 'BlockStatement' ? returnedExpr(cb.body) : (cb.body as Node);
            return { t: 'array', items: body ? this.shape(body, depth + 1) : undefined };
          }
          return { t: 'array' };
        }
        if (callee.type === 'MemberExpression' && /^(filter|slice|concat|sort|reverse)$/.test(propName(callee) ?? '')) return { t: 'array' };
        const text = memberText(callee);
        if (text === 'String' || text === 'JSON.stringify' || /\.(toString|toISOString|join|toFixed|trim|toLowerCase|toUpperCase)$/.test(text ?? '')) return { t: 'string' };
        if (text === 'Number' || text === 'parseInt' || text === 'parseFloat' || text === 'Date.now' || /^Math\./.test(text ?? '')) return { t: 'number' };
        if (text === 'Boolean') return { t: 'boolean' };
        return { t: 'unknown', expr: label(n) };
      }
      case 'NewExpression':
        return memberText(n.callee as Node) === 'Date' ? { t: 'string' } : { t: 'unknown', expr: label(n) };
      default:
        return { t: 'unknown', expr: label(n) };
    }
  }

  private objectShape(n: t.ObjectExpression, depth: number): Shape {
    const props: Record<string, ShapeProp> = Object.create(null) as Record<string, ShapeProp>;
    let open = false;
    let count = 0;
    for (const p of n.properties) {
      if (count++ > MAX_PROPS) {
        open = true;
        break;
      }
      if (p.type === 'SpreadElement') {
        const inner = this.shape(p.argument, depth + 1);
        if (inner.t === 'object') {
          Object.assign(props, inner.props);
          if (inner.open) open = true;
        } else {
          open = true;
        }
        continue;
      }
      if (p.computed) {
        const k = p.key.type === 'StringLiteral' ? p.key.value : undefined;
        if (!k) {
          open = true;
          continue;
        }
      }
      const key = keyName(p.key);
      if (!key) {
        open = true;
        continue;
      }
      if (p.type === 'ObjectMethod') continue;
      const value = unwrap(p.value as Node);
      props[key] = { shape: this.shape(value, depth + 1), src: srcText(value) };
    }
    const shape: Shape = { t: 'object', props };
    if (open) shape.open = true;
    return shape;
  }

  /** Adds `obj.key = value` writes to the shape of a local object. */
  private withWrites(name: string, shape: Shape, depth: number): Shape {
    const writes = this.memberWrites.get(name);
    if (!writes || shape.t !== 'object') return shape;
    const props = Object.assign(Object.create(null) as Record<string, ShapeProp>, shape.props);
    for (const w of writes) props[w.key] = { shape: this.shape(w.value, depth + 1), src: srcText(w.value), optional: true };
    return { ...shape, props };
  }
}

/** Union of two shapes: properties missing on one side become optional. */
export function mergeShapes(a: Shape, b: Shape): Shape {
  if (a.t === 'unknown') return b.t === 'unknown' ? a : { ...b };
  if (b.t === 'unknown') return a;
  if (a.t === 'object' && b.t === 'object') {
    const props: Record<string, ShapeProp> = Object.create(null) as Record<string, ShapeProp>;
    for (const k of new Set([...Object.keys(a.props), ...Object.keys(b.props)])) {
      const x = Object.prototype.hasOwnProperty.call(a.props, k) ? a.props[k] : undefined;
      const y = Object.prototype.hasOwnProperty.call(b.props, k) ? b.props[k] : undefined;
      if (x && y) props[k] = { shape: mergeShapes(x.shape, y.shape), src: x.src ?? y.src, optional: x.optional || y.optional || undefined };
      else props[k] = { ...(x ?? y)!, optional: true };
    }
    const out: Shape = { t: 'object', props };
    if (a.open || b.open) out.open = true;
    return out;
  }
  if (a.t === 'array' && b.t === 'array') return { t: 'array', items: a.items && b.items ? mergeShapes(a.items, b.items) : (a.items ?? b.items) };
  if (a.t === b.t) return a;
  if (a.t === 'null') return b;
  if (b.t === 'null') return a;
  return { t: 'unknown' };
}

function returnedExpr(block: t.BlockStatement): Node | undefined {
  for (const stmt of block.body) if (stmt.type === 'ReturnStatement' && stmt.argument) return stmt.argument;
  return undefined;
}

/** Short source-like text for a value: `user.name`, `getName()`; never literal contents. */
function srcText(n: Node): string | undefined {
  const text = memberText(n);
  if (text) return text.length > 60 ? undefined : text;
  if (n.type === 'CallExpression' || n.type === 'AwaitExpression') {
    const l = shortLabel(n.type === 'AwaitExpression' ? n.argument : n);
    return l === '(expression)' ? undefined : l;
  }
  return undefined;
}

function label(n: Node): string | undefined {
  const l = shortLabel(n);
  return l === '(expression)' ? undefined : l;
}

/** `User.create(req.body)`: callee plus the argument's member text, never literal values. */
function callLabel(at: Node, arg: Node | undefined): string {
  const callee = at.type === 'CallExpression' || at.type === 'OptionalCallExpression' || at.type === 'NewExpression' ? shortLabel(at.callee as Node) : shortLabel(at);
  const a = arg ? unwrap(arg) : undefined;
  let argText = a ? (memberText(a) ?? (a.type === 'TemplateLiteral' ? '`…${…}…`' : a.type === 'BinaryExpression' ? '… + …' : a.type === 'ObjectExpression' ? '{ … }' : shortLabel(a))) : '';
  if (argText === '(expression)') argText = '…';
  const name = callee === '(expression)' ? 'call' : callee.replace(/\(\)$/, '');
  return `${at.type === 'NewExpression' ? 'new ' : ''}${name.replace(/^new /, '')}(${argText})`;
}
