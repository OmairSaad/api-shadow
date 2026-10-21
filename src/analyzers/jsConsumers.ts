/**
 * Follows HTTP responses through client code to find which response fields are read:
 *
 *   const { data } = await axios.get('/api/users/1');   →  `user.name` read in JSX below
 *   return <p>{data.user.name}</p>;
 *
 * Values are tracked by *stage*: a promise of a fetch `Response`, a `Response`, an axios
 * response, a parsed body, and so on. `await`, `.then(cb)`, `.json()`, `.data`, `.body`,
 * destructuring, array callbacks (`items.map(i => i.title)`), React `useState` setters and
 * `useQuery({ queryFn })` move a value between stages. Functions returning a tracked value are
 * recorded (`returnsBody`) so that callers in other files can be linked; calls to imported
 * functions are recorded as consumer calls with the paths read from their results.
 *
 * The analysis is flow-insensitive within a function and runs a few passes so that bindings made
 * later in the source (a setter called in an effect, a function declared below) are seen.
 */
import type * as t from '@babel/types';
import { forEachChild, isFunctionLike, keyName, memberText, posOf, propName, unwrap, type Node } from './babelUtils';
import type { BodyStage, ConsumerCallFact, JsFileFacts, Pos, ReadFact, ReturnsBodyFact } from './facts';

type Stage =
  | 'fetchP' // Promise<Response>
  | 'fetchR' // Response
  | 'kyP' // ky/got ResponsePromise: await → Response, .json() → Promise<body>
  | 'bodyP'
  | 'body'
  | 'axiosP'
  | 'axiosR'
  | 'agentP' // supertest/superagent request (thenable, chainable)
  | 'agentR'
  | 'obs' // Observable<body> (Angular HttpClient)
  | 'rawP' // result of a function in another file, not yet known
  | 'raw'
  | 'query'; // react-query result: `.data` is the query function's resolved value

type Src = { call: number } | { consumer: number };

interface Val {
  src: Src;
  st: Stage;
  path: string[];
  /** For `query`: the value `.data` resolves to. */
  inner?: Val;
}

const PASSES = 3;
const MAX_READS = 200;
const ARRAY_ELEMENT = new Set(['find', 'findLast', 'at']);
const ARRAY_SAME = new Set(['filter', 'slice', 'sort', 'reverse', 'concat', 'toSorted', 'toReversed']);
const ARRAY_CALLBACK = new Set(['map', 'forEach', 'filter', 'find', 'findLast', 'findIndex', 'some', 'every', 'flatMap', 'sort']);
const NON_FIELDS = new Set(['length', 'map', 'forEach', 'filter', 'find', 'findLast', 'findIndex', 'some', 'every', 'flatMap', 'reduce', 'includes', 'indexOf', 'join', 'slice', 'sort', 'reverse', 'concat', 'at', 'toString', 'valueOf', 'then', 'catch', 'finally', 'subscribe', 'pipe', 'json', 'text', 'keys', 'values', 'entries', 'toSorted', 'toReversed', 'push']);
const AGENT_CHAIN = new Set(['expect', 'set', 'send', 'query', 'field', 'attach', 'auth', 'type', 'accept', 'withCredentials', 'timeout', 'redirects', 'ok']);
const QUERY_HOOKS = new Set(['useQuery', 'useSuspenseQuery', 'useInfiniteQuery', 'createQuery']);
/** Import sources that are part of the project: relative paths and common aliases (`@/`, `~/`). */
const PROJECT_SOURCE = /^(\.|[@~#]\/|src\/)/;

function initialStage(client: string, unknownBase: boolean | undefined): Stage {
  switch (client) {
    case 'fetch':
      return 'fetchP';
    case '$fetch':
    case 'ofetch':
      return 'bodyP';
    case 'ky':
    case 'got':
      return 'kyP';
    case 'supertest':
    case 'superagent':
      return 'agentP';
    case 'HttpClient':
      return 'obs';
    case 'axios':
      return 'axiosP';
    default:
      // axios instances are named after their variable; imported clients may unwrap `data`.
      return unknownBase ? 'rawP' : 'axiosP';
  }
}

function settle(st: Stage): Stage {
  switch (st) {
    case 'fetchP':
    case 'kyP':
      return 'fetchR';
    case 'bodyP':
      return 'body';
    case 'axiosP':
      return 'axiosR';
    case 'agentP':
      return 'agentR';
    case 'rawP':
      return 'raw';
    default:
      return st;
  }
}

function factStage(st: Stage): BodyStage | undefined {
  switch (st) {
    case 'body':
    case 'bodyP':
    case 'obs':
      return 'body';
    case 'axiosP':
    case 'axiosR':
      return 'axios';
    case 'agentP':
    case 'agentR':
      return 'agent';
    case 'fetchP':
    case 'fetchR':
    case 'kyP':
      return 'fetch';
    case 'raw':
    case 'rawP':
      return 'raw';
    default:
      return undefined;
  }
}

export interface ConsumerResult {
  /** callable key → what it returns. */
  returns: Map<string, ReturnsBodyFact>;
}

/**
 * Annotates `facts.clientCalls` with reads and `within`, fills `facts.consumers`, and returns
 * the response-returning functions among `callableNodes`.
 */
export function analyzeConsumers(program: t.Program, facts: JsFileFacts, callableNodes: ReadonlyMap<Node, string>): ConsumerResult {
  return new ConsumerAnalyzer(program, facts, callableNodes).run();
}

class ConsumerAnalyzer {
  private readonly callIndex = new Map<string, number>();
  private readonly scopes = new Map<Node, Map<string, Val | null>>();
  private readonly setters = new Map<Node, Map<string, string>>();
  private readonly fnReturn = new Map<Node, Val>();
  private readonly fnNames = new Map<Node, string>();
  /** Function declarations and arrow constants by scope, for local calls. */
  private readonly localFns = new Map<Node, Map<string, Node>>();
  /** Class methods by class body, for `this.method()`. */
  private readonly classMethods = new Map<Node, Map<string, Node>>();
  private readonly consumerByNode = new Map<Node, number>();
  private readonly consumers: ConsumerCallFact[] = [];
  private readonly reads = new Map<Node, { src: Src; path: string; pos: Pos; within?: string }>();
  private final = false;
  private stack: Node[] = [];
  private classStack: Node[] = [];

  constructor(
    private readonly program: t.Program,
    private readonly facts: JsFileFacts,
    private readonly callableNodes: ReadonlyMap<Node, string>,
  ) {
    facts.clientCalls.forEach((c, i) => this.callIndex.set(`${c.pos.line}:${c.pos.column}`, i));
  }

  run(): ConsumerResult {
    this.index(this.program as Node, undefined);
    for (let pass = 0; pass < PASSES; pass++) {
      this.final = pass === PASSES - 1;
      this.stack = [this.program as Node];
      this.classStack = [];
      this.visit(this.program as Node);
    }
    // Attach reads to their sources.
    const callReads = new Map<number, ReadFact[]>();
    const consumerReads = new Map<number, ReadFact[]>();
    for (const r of this.reads.values()) {
      const target = 'call' in r.src ? callReads : consumerReads;
      const key = 'call' in r.src ? r.src.call : r.src.consumer;
      const list = target.get(key) ?? [];
      if (list.length < MAX_READS && !list.some((x) => x.path === r.path && x.pos.line === r.pos.line)) list.push(r.within ? { path: r.path, pos: r.pos, within: r.within } : { path: r.path, pos: r.pos });
      target.set(key, list);
    }
    for (const [i, list] of callReads) this.facts.clientCalls[i].reads = maximal(list);
    // Keep consumer calls whose result is read or returned onwards.
    const returns = new Map<string, ReturnsBodyFact>();
    const keep = new Map<number, number>();
    const keepConsumer = (j: number): number => {
      let k = keep.get(j);
      if (k === undefined) {
        k = this.facts.consumers.length;
        this.facts.consumers.push({ ...this.consumers[j], reads: maximal(consumerReads.get(j) ?? []) });
        keep.set(j, k);
      }
      return k;
    };
    for (const [fn, v] of this.fnReturn) {
      const key = this.callableNodes.get(fn);
      const stage = factStage(v.st);
      if (!key || !stage) continue;
      const r: ReturnsBodyFact = { stage, path: v.path.join('.') };
      if ('call' in v.src) r.call = v.src.call;
      else r.consumer = keepConsumer(v.src.consumer);
      returns.set(key, r);
    }
    for (const j of consumerReads.keys()) keepConsumer(j);
    return { returns };
  }

  // -------------------------------------------------------------------------------------------
  // Indexing: function names, local functions, class methods
  // -------------------------------------------------------------------------------------------

  private index(node: Node, scope: Node | undefined): void {
    const s = scope ?? node;
    if (node.type === 'FunctionDeclaration' && node.id) {
      this.fnNames.set(node, node.id.name);
      this.localFn(s, node.id.name, node);
    } else if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
      const init = unwrap(node.init);
      if (isFunctionLike(init)) {
        this.fnNames.set(init, node.id.name);
        this.localFn(s, node.id.name, init);
      } else if (init.type === 'CallExpression' && init.arguments[0] && isFunctionLike(unwrap(init.arguments[0] as Node))) {
        // `const UserCard = memo((props) => …)`, `forwardRef(…)`
        this.fnNames.set(unwrap(init.arguments[0] as Node), node.id.name);
      } else if (init.type === 'ObjectExpression') {
        // `const userService = { get() {…} }`: methods are named `userService.get`.
        this.nameMethods(init, node.id.name);
      }
    } else if (node.type === 'AssignmentExpression' && unwrap(node.right).type === 'ObjectExpression' && /^(module\.)?exports$/.test(memberTextOf(node.left as Node))) {
      this.nameMethods(unwrap(node.right) as t.ObjectExpression, undefined);
    } else if (node.type === 'ExportDefaultDeclaration' && unwrap(node.declaration as Node).type === 'ObjectExpression') {
      this.nameMethods(unwrap(node.declaration as Node) as t.ObjectExpression, undefined);
    } else if ((node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && node.body) {
      const methods = new Map<string, Node>();
      const cls = node.id?.name ?? 'class';
      for (const m of node.body.body) {
        if (m.type === 'ClassMethod' && m.kind === 'method') {
          const name = keyName(m.key);
          if (name) {
            methods.set(name, m);
            this.fnNames.set(m, `${cls}.${name}`);
          }
        } else if (m.type === 'ClassProperty' && m.value && isFunctionLike(unwrap(m.value))) {
          const name = keyName(m.key);
          if (name) {
            methods.set(name, unwrap(m.value));
            this.fnNames.set(unwrap(m.value), `${cls}.${name}`);
          }
        }
      }
      this.classMethods.set(node.body, methods);
    }
    const next = isFunctionLike(node) ? node : s;
    forEachChild(node, (c) => this.index(c, next));
  }

  /** Names the function-valued properties of a module-level object (callbacks in other objects stay anonymous). */
  private nameMethods(obj: t.ObjectExpression, owner: string | undefined): void {
    for (const p of obj.properties) {
      if (p.type === 'SpreadElement') continue;
      const key = keyName(p.key);
      const fn = p.type === 'ObjectMethod' ? p : unwrap(p.value as Node);
      if (key && isFunctionLike(fn)) this.fnNames.set(fn, owner ? `${owner}.${key}` : key);
    }
  }

  private localFn(scope: Node, name: string, fn: Node): void {
    const m = this.localFns.get(scope) ?? new Map<string, Node>();
    m.set(name, fn);
    this.localFns.set(scope, m);
  }

  // -------------------------------------------------------------------------------------------
  // Scopes
  // -------------------------------------------------------------------------------------------

  private scope(node: Node): Map<string, Val | null> {
    let m = this.scopes.get(node);
    if (!m) {
      m = new Map();
      this.scopes.set(node, m);
    }
    return m;
  }

  private current(): Node {
    return this.stack[this.stack.length - 1];
  }

  private lookup(name: string): { found: boolean; val?: Val } {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const m = this.scopes.get(this.stack[i]);
      if (m?.has(name)) return { found: true, val: m.get(name) ?? undefined };
      if (this.localFns.get(this.stack[i])?.has(name)) return { found: true };
    }
    return { found: false };
  }

  private localFunction(name: string): Node | undefined {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const f = this.localFns.get(this.stack[i])?.get(name);
      if (f) return f;
      if (this.scopes.get(this.stack[i])?.has(name)) return undefined;
    }
    return undefined;
  }

  /** Binds in the current scope; a tracked value is never replaced by `null`. */
  private bind(name: string, v: Val | undefined, scopeNode: Node = this.current()): void {
    const m = this.scope(scopeNode);
    if (v) m.set(name, v);
    else if (!m.has(name)) m.set(name, null);
  }

  /** Assignment to an existing variable binds where it was declared. */
  private assign(name: string, v: Val | undefined): void {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const m = this.scopes.get(this.stack[i]);
      if (m?.has(name)) {
        if (v) m.set(name, v);
        return;
      }
    }
    this.bind(name, v);
  }

  private within(): string | undefined {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const name = this.fnNames.get(this.stack[i]);
      if (name) return name;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------------------------
  // Visit
  // -------------------------------------------------------------------------------------------

  private visit(node: Node): void {
    if (isFunctionLike(node)) {
      this.visitFunction(node);
      return;
    }
    switch (node.type) {
      case 'ClassBody':
        this.classStack.push(node);
        forEachChild(node, (c) => this.visit(c));
        this.classStack.pop();
        return;
      case 'VariableDeclarator':
        this.declarator(node);
        break;
      case 'AssignmentExpression':
        if (node.left.type === 'Identifier') this.assign(node.left.name, this.ev(node.right));
        else if (node.left.type === 'ObjectPattern') this.bindPattern(node.left, this.ev(node.right), true);
        break;
      case 'CallExpression':
      case 'OptionalCallExpression':
        this.call(node);
        break;
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        this.ev(node);
        break;
      case 'ReturnStatement':
        if (node.argument) this.returned(this.ev(node.argument));
        break;
      default:
        break;
    }
    forEachChild(node, (c) => this.visit(c));
  }

  private visitFunction(fn: t.Function): void {
    this.stack.push(fn);
    for (const p of fn.params) this.bindPattern(p as Node, undefined, false);
    if (fn.body.type !== 'BlockStatement') this.returned(this.ev(fn.body as Node));
    const params = new Set<Node>(fn.params as Node[]);
    forEachChild(fn, (c) => {
      if (!params.has(c)) this.visit(c);
    });
    this.stack.pop();
  }

  private returned(v: Val | undefined): void {
    if (!v) return;
    const fn = this.current();
    if (fn.type === 'Program') return;
    if (!this.fnReturn.has(fn)) this.fnReturn.set(fn, v);
  }

  private declarator(node: t.VariableDeclarator): void {
    const init = node.init ? unwrap(node.init) : undefined;
    // `const [user, setUser] = useState()`
    if (node.id.type === 'ArrayPattern' && init?.type === 'CallExpression') {
      const callee = unwrap(init.callee as Node);
      const name = callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression' ? propName(callee) : undefined;
      const [state, setter] = node.id.elements;
      if (name === 'useState' && state?.type === 'Identifier' && setter?.type === 'Identifier') {
        const m = this.setters.get(this.current()) ?? new Map<string, string>();
        m.set(setter.name, state.name);
        this.setters.set(this.current(), m);
        this.bind(state.name, undefined);
        this.bind(setter.name, undefined);
        return;
      }
    }
    if (init && isFunctionLike(init)) return;
    this.bindPattern(node.id as Node, init ? this.ev(init) : undefined, false);
  }

  private call(node: t.CallExpression | t.OptionalCallExpression): void {
    const callee = unwrap(node.callee as Node);
    const args = node.arguments as Node[];
    // React state setter: `setUser(data.user)`.
    if (callee.type === 'Identifier' && args[0]) {
      for (let i = this.stack.length - 1; i >= 0; i--) {
        const state = this.setters.get(this.stack[i])?.get(callee.name);
        if (state) {
          const v = this.ev(args[0]);
          if (v) this.bind(state, v, this.stack[i]);
          break;
        }
      }
    }
    if (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') return;
    const prop = propName(callee);
    if (!prop) return;
    const cb = args[0] ? unwrap(args[0]) : undefined;
    if (!cb || !isFunctionLike(cb)) return;
    const recv = this.ev(callee.object);
    if (!recv) return;
    let param: Val | undefined;
    if (prop === 'then') param = { ...recv, st: settle(recv.st) };
    else if (prop === 'subscribe' && (recv.st === 'obs' || recv.st === 'raw' || recv.st === 'rawP')) param = { ...recv, st: recv.st === 'obs' ? 'body' : 'raw' };
    else if (ARRAY_CALLBACK.has(prop) && (recv.st === 'body' || recv.st === 'raw')) param = { ...recv, path: [...recv.path, '[]'] };
    if (param && cb.params[0]) this.bindParam(cb, cb.params[0] as Node, param);
  }

  private bindParam(fn: t.Function, p: Node, v: Val): void {
    this.stack.push(fn);
    this.bindPattern(p, v, false);
    this.stack.pop();
  }

  private bindPattern(pattern: Node, v: Val | undefined, isAssign: boolean): void {
    const set = (name: string, val: Val | undefined): void => (isAssign ? this.assign(name, val) : this.bind(name, val));
    switch (pattern.type) {
      case 'Identifier':
        set(pattern.name, v);
        return;
      case 'AssignmentPattern':
        this.bindPattern(pattern.left as Node, v, isAssign);
        return;
      case 'ObjectPattern':
        for (const p of pattern.properties) {
          if (p.type === 'RestElement') {
            if (p.argument.type === 'Identifier') set(p.argument.name, undefined);
            continue;
          }
          const key = p.computed ? undefined : keyName(p.key);
          const child = v && key ? this.member(v, key, p as Node) : undefined;
          this.bindPattern(p.value as Node, child, isAssign);
        }
        return;
      case 'ArrayPattern':
        for (const el of pattern.elements) {
          if (!el) continue;
          const child = v && (v.st === 'body' || v.st === 'raw') ? { ...v, path: [...v.path, '[]'] } : undefined;
          this.bindPattern(el as Node, child, isAssign);
        }
        return;
      case 'TSParameterProperty':
        this.bindPattern(pattern.parameter as Node, undefined, isAssign);
        return;
      default:
        return;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Evaluation
  // -------------------------------------------------------------------------------------------

  private ev(node: Node): Val | undefined {
    const n = unwrap(node);
    switch (n.type) {
      case 'Identifier':
        return this.lookup(n.name).val;
      case 'AwaitExpression': {
        const v = this.ev(n.argument);
        return v ? { ...v, st: settle(v.st) } : undefined;
      }
      case 'LogicalExpression':
        return this.ev(n.left) ?? this.ev(n.right);
      case 'ConditionalExpression':
        return this.ev(n.consequent) ?? this.ev(n.alternate);
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        const obj = this.ev(n.object);
        if (!obj) return undefined;
        const prop = n.computed ? (n.property.type === 'NumericLiteral' ? '[]' : n.property.type === 'StringLiteral' ? n.property.value : undefined) : propName(n);
        return prop ? this.member(obj, prop, n) : undefined;
      }
      case 'CallExpression':
      case 'OptionalCallExpression':
        return this.evCall(n);
      default:
        return undefined;
    }
  }

  private evCall(n: t.CallExpression | t.OptionalCallExpression): Val | undefined {
    const idx = this.clientCallAt(n);
    if (idx !== undefined) {
      const fact = this.facts.clientCalls[idx];
      if (this.final) fact.within ??= this.within();
      return { src: { call: idx }, st: initialStage(fact.client, fact.unknownBase), path: [] };
    }
    const callee = unwrap(n.callee as Node);
    const args = n.arguments as Node[];
    if (callee.type === 'Identifier') {
      if ((callee.name === 'firstValueFrom' || callee.name === 'lastValueFrom') && args[0]) {
        const v = this.ev(args[0]);
        return v && (v.st === 'obs' || v.st === 'raw' || v.st === 'rawP') ? { ...v, st: v.st === 'obs' ? 'bodyP' : 'rawP' } : undefined;
      }
      if (QUERY_HOOKS.has(callee.name)) return this.queryHook(args);
      const local = this.localFunction(callee.name);
      if (local) return this.fnReturn.get(local);
      return this.consumer(n, callee);
    }
    if (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') return undefined;
    const prop = propName(callee);
    if (!prop) return undefined;
    const object = unwrap(callee.object);
    if (object.type === 'ThisExpression') {
      const cls = this.classStack[this.classStack.length - 1];
      const m = cls ? this.classMethods.get(cls)?.get(prop) : undefined;
      return m ? this.fnReturn.get(m) : undefined;
    }
    if (prop === 'useQuery' || prop === 'useSuspenseQuery') return this.queryHook(args);
    const recv = this.ev(object);
    if (!recv) return this.consumer(n, callee);
    if (prop === 'json' && (recv.st === 'fetchR' || recv.st === 'kyP')) return { ...recv, st: 'bodyP', path: [] };
    if (recv.st === 'agentP' && AGENT_CHAIN.has(prop)) return recv;
    if (prop === 'then') {
      const cb = args[0] ? unwrap(args[0]) : undefined;
      if (cb && isFunctionLike(cb)) {
        const r = this.fnReturn.get(cb);
        return r ? { ...r, st: toPromise(r.st) } : undefined;
      }
      return undefined;
    }
    if (prop === 'catch' || prop === 'finally') return recv;
    if (prop === 'toPromise' && recv.st === 'obs') return { ...recv, st: 'bodyP' };
    if (recv.st === 'body' || recv.st === 'raw') {
      if (ARRAY_ELEMENT.has(prop)) return { ...recv, path: [...recv.path, '[]'] };
      if (ARRAY_SAME.has(prop)) return recv;
    }
    return undefined;
  }

  /**
   * The client call made by this node. `fetch(url).then(cb)` starts where `fetch(url)` starts, so
   * the URL must also lie inside one of the node's own arguments.
   */
  private clientCallAt(n: t.CallExpression | t.OptionalCallExpression): number | undefined {
    const idx = this.callIndex.get(`${posOf(n).line}:${posOf(n).column}`);
    if (idx === undefined) return undefined;
    const { start } = this.facts.clientCalls[idx];
    const inside = (a: Node): boolean => {
      const s = a.loc?.start;
      const e = a.loc?.end;
      if (!s || !e) return false;
      const after = s.line < start.line || (s.line === start.line && s.column + 1 <= start.column);
      const before = e.line > start.line || (e.line === start.line && e.column + 1 > start.column);
      return after && before;
    };
    return n.arguments.some((a) => inside(a as Node)) ? idx : undefined;
  }

  /** `useQuery({ queryFn: () => getUser(id) })` or `useQuery(key, fetchUser)`. */
  private queryHook(args: Node[]): Val | undefined {
    let fn: Node | undefined;
    const first = args[0] ? unwrap(args[0]) : undefined;
    if (first?.type === 'ObjectExpression') {
      for (const p of first.properties) {
        if (p.type === 'ObjectProperty' && keyName(p.key) === 'queryFn') fn = unwrap(p.value as Node);
        else if (p.type === 'ObjectMethod' && keyName(p.key) === 'queryFn') fn = p;
      }
    } else if (args[1]) {
      fn = unwrap(args[1]);
    }
    if (!fn) return undefined;
    let inner: Val | undefined;
    if (isFunctionLike(fn)) inner = this.fnReturn.get(fn);
    else if (fn.type === 'Identifier') {
      const local = this.localFunction(fn.name);
      inner = local ? this.fnReturn.get(local) : this.importedFnRef(fn);
    }
    if (!inner) return undefined;
    return { src: inner.src, st: 'query', path: [], inner: { ...inner, st: settle(inner.st) } };
  }

  /** A function passed by reference (`useQuery(key, getUser)`) is a consumer of its own call. */
  private importedFnRef(id: t.Identifier): Val | undefined {
    const imp = Object.prototype.hasOwnProperty.call(this.facts.imports, id.name) ? this.facts.imports[id.name] : undefined;
    if (!imp || !PROJECT_SOURCE.test(imp.source) || this.lookup(id.name).found) return undefined;
    const j = this.consumerFor(id, { k: 'import', source: imp.source, name: imp.name });
    return { src: { consumer: j }, st: 'rawP', path: [] };
  }

  /** A call to an imported project function: `getUser(id)`, `userService.getUser(id)`. */
  private consumer(n: t.CallExpression | t.OptionalCallExpression, callee: Node): Val | undefined {
    let ref: ConsumerCallFact['callee'] | undefined;
    const own = (name: string): { source: string; name: string } | undefined =>
      Object.prototype.hasOwnProperty.call(this.facts.imports, name) ? this.facts.imports[name] : undefined;
    if (callee.type === 'Identifier') {
      const imp = own(callee.name);
      if (imp && !this.lookup(callee.name).found) ref = { k: 'import', source: imp.source, name: imp.name };
    } else if ((callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') && unwrap(callee.object).type === 'Identifier') {
      const obj = (unwrap(callee.object) as t.Identifier).name;
      const member = propName(callee);
      const imp = own(obj);
      if (imp && member && !this.lookup(obj).found) ref = { k: 'import', source: imp.source, name: imp.name, member };
    }
    if (!ref || ref.k !== 'import' || !PROJECT_SOURCE.test(ref.source)) return undefined;
    const j = this.consumerFor(n, ref);
    return { src: { consumer: j }, st: 'rawP', path: [] };
  }

  private consumerFor(node: Node, callee: ConsumerCallFact['callee']): number {
    let j = this.consumerByNode.get(node);
    if (j === undefined) {
      j = this.consumers.length;
      this.consumers.push({ callee, reads: [], pos: posOf(node), within: this.within() });
      this.consumerByNode.set(node, j);
    }
    return j;
  }

  /** Property access on a tracked value; records a read for body fields. */
  private member(v: Val, prop: string, at: Node): Val | undefined {
    switch (v.st) {
      case 'body':
      case 'raw':
      case 'rawP':
      case 'bodyP': {
        if (v.st === 'bodyP') return undefined;
        if (NON_FIELDS.has(prop)) return undefined;
        const child: Val = { ...v, st: v.st === 'rawP' ? 'raw' : v.st, path: [...v.path, prop] };
        if (this.final) this.reads.set(at, { src: v.src, path: child.path.join('.'), pos: posOf(at), within: this.within() });
        return child;
      }
      case 'axiosR':
        return prop === 'data' ? { ...v, st: 'body', path: [] } : undefined;
      case 'agentR':
        return prop === 'body' ? { ...v, st: 'body', path: [] } : undefined;
      case 'query':
        return prop === 'data' ? v.inner : undefined;
      default:
        return undefined;
    }
  }
}

function toPromise(st: Stage): Stage {
  switch (st) {
    case 'body':
      return 'bodyP';
    case 'axiosR':
      return 'axiosP';
    case 'agentR':
      return 'agentP';
    case 'fetchR':
      return 'fetchP';
    case 'raw':
      return 'rawP';
    default:
      return st;
  }
}

/** Drops reads that are a prefix of another read on the same line (`user` when `user.name` is read). */
function maximal(reads: ReadFact[]): ReadFact[] {
  return reads.filter((r) => !reads.some((o) => o !== r && o.pos.line === r.pos.line && o.path.startsWith(r.path + '.')));
}

function memberTextOf(n: Node): string {
  return memberText(n) ?? '';
}
