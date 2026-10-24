/**
 * A small, fault-tolerant PHP parser for route files and controllers. It understands enough of
 * PHP to read call chains (`Route::prefix('x')->group(fn () => …)`), arrays, closures, classes and
 * method bodies; everything else is skipped. A statement that fails to parse is skipped up to the
 * next `;` or `}` and reported, so one odd construct never hides the rest of the file.
 */
import type { Pos } from './facts';

export type PToken = { t: 'str' | 'num' | 'var' | 'id' | 'p'; v: string; pos: Pos; dyn?: boolean } | { t: 'eof'; v: ''; pos: Pos };

export type PNode =
  | { k: 'str'; v: string; dyn: boolean; pos: Pos }
  | { k: 'num'; v: number; pos: Pos }
  | { k: 'var'; name: string; pos: Pos }
  | { k: 'name'; name: string; pos: Pos }
  | { k: 'arr'; items: { key?: PNode; value: PNode; spread?: boolean }[]; pos: Pos }
  | { k: 'class'; name: string; pos: Pos }
  | { k: 'sconst'; cls: string; name: string; pos: Pos }
  | { k: 'call'; name: string; args: PArg[]; pos: Pos }
  | { k: 'scall'; cls: string; method: string; args: PArg[]; pos: Pos }
  | { k: 'mcall'; target: PNode; method: string; args: PArg[]; pos: Pos }
  | { k: 'dcall'; callee: PNode; args: PArg[]; pos: Pos }
  | { k: 'prop'; target: PNode; name: string; pos: Pos }
  | { k: 'sprop'; cls: string; name: string; pos: Pos }
  | { k: 'index'; target: PNode; index?: PNode; pos: Pos }
  | { k: 'new'; cls: string; args: PArg[]; pos: Pos }
  | { k: 'closure'; params: PParam[]; body: PStmt[]; arrow?: PNode; pos: Pos }
  | { k: 'concat'; parts: PNode[]; pos: Pos }
  | { k: 'bin'; op: string; left: PNode; right: PNode; pos: Pos }
  | { k: 'assign'; target: PNode; value: PNode; pos: Pos }
  | { k: 'unknown'; pos: Pos };

export interface PArg {
  name?: string;
  value: PNode;
  spread?: boolean;
}

export interface PParam {
  name: string;
  type?: string;
  promoted?: boolean;
}

export interface PMethod {
  name: string;
  params: PParam[];
  body: PStmt[];
  pos: Pos;
  isStatic: boolean;
}

export type PStmt =
  | { k: 'expr'; e: PNode; pos: Pos }
  | { k: 'return'; e?: PNode; pos: Pos }
  | { k: 'throw'; e: PNode; pos: Pos }
  | { k: 'block'; body: PStmt[] }
  | { k: 'catch'; varName?: string; body: PStmt[] }
  | { k: 'class'; name: string; extends?: string; methods: PMethod[]; pos: Pos }
  | { k: 'function'; name: string; params: PParam[]; body: PStmt[]; pos: Pos }
  | { k: 'namespace'; name: string; body?: PStmt[] }
  | { k: 'use'; alias: string; fqn: string };

export interface ParsedPhp {
  stmts: PStmt[];
  errors: Pos[];
}

const MULTI = ['?->', '...', '===', '!==', '<=>', '**=', '??=', '::', '->', '=>', '??', '==', '!=', '<>', '<=', '>=', '&&', '||', '.=', '+=', '-=', '*=', '/=', '%=', '++', '--', '<<', '>>', '**'];
const BINARY = new Set(['.', '+', '-', '*', '/', '%', '**', '??', '&&', '||', '==', '===', '!=', '!==', '<>', '<', '>', '<=', '>=', '<=>', '&', '|', '^', '<<', '>>', 'and', 'or', 'xor', 'instanceof']);
const ASSIGN = new Set(['=', '.=', '+=', '-=', '*=', '/=', '%=', '??=', '**=']);
const MODIFIERS = new Set(['public', 'private', 'protected', 'static', 'abstract', 'final', 'readonly', 'var']);

/** Tokenizes PHP code; text outside `<?php … ?>` is skipped. */
export function tokenize(source: string): PToken[] {
  const out: PToken[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const n = source.length;
  const advance = (count: number): void => {
    for (let k = 0; k < count && i < n; k++, i++) {
      if (source[i] === '\n') {
        line++;
        col = 1;
      } else col++;
    }
  };
  // Skip to the first opening tag (route files start with it; inline HTML is irrelevant).
  const open = (): void => {
    const at = source.indexOf('<?', i);
    if (at < 0) {
      advance(n - i);
      return;
    }
    advance(at - i);
    advance(source.startsWith('<?php', i) ? 5 : source.startsWith('<?=', i) ? 3 : 2);
  };
  open();
  while (i < n) {
    const c = source[i];
    const pos = { line, column: col };
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      advance(1);
      continue;
    }
    if (c === '?' && source[i + 1] === '>') {
      advance(2);
      out.push({ t: 'p', v: ';', pos });
      open();
      continue;
    }
    if ((c === '/' && source[i + 1] === '/') || (c === '#' && source[i + 1] !== '[')) {
      while (i < n && source[i] !== '\n' && !(source[i] === '?' && source[i + 1] === '>')) advance(1);
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      advance((end < 0 ? n : end + 2) - i);
      continue;
    }
    if (c === '#' && source[i + 1] === '[') {
      // Attribute: skip to the matching bracket.
      let depth = 0;
      while (i < n) {
        if (source[i] === '[') depth++;
        else if (source[i] === ']' && --depth === 0) {
          advance(1);
          break;
        }
        advance(1);
      }
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let value = '';
      let dyn = false;
      while (j < n && source[j] !== c) {
        if (source[j] === '\\' && j + 1 < n) {
          const next = source[j + 1];
          value += next === c || next === '\\' ? next : c === '"' && next === 'n' ? '\n' : c === '"' && next === 't' ? '\t' : '\\' + next;
          j += 2;
          continue;
        }
        if (c === '"' && source[j] === '$' && /[A-Za-z_{]/.test(source[j + 1] ?? '')) dyn = true;
        if (c === '"' && source[j] === '{' && source[j + 1] === '$') dyn = true;
        value += source[j];
        j++;
      }
      advance(j + 1 - i);
      out.push({ t: 'str', v: value, pos, dyn });
      continue;
    }
    if (c === '<' && source.startsWith('<<<', i)) {
      const m = /^<<<[ \t]*(['"]?)([A-Za-z_]\w*)\1\r?\n/.exec(source.slice(i, i + 200));
      if (m) {
        const label = m[2];
        const re = new RegExp(`\\n[ \\t]*${label}\\b`, 'g');
        re.lastIndex = i + m[0].length - 1;
        const end = re.exec(source);
        const stop = end ? end.index + end[0].length : n;
        const body = source.slice(i + m[0].length, end ? end.index : n);
        advance(stop - i);
        out.push({ t: 'str', v: body, pos, dyn: m[1] !== "'" && /\$[A-Za-z_{]/.test(body) });
        continue;
      }
    }
    if (c === '$' && /[A-Za-z_]/.test(source[i + 1] ?? '')) {
      const m = /^\$[A-Za-z_]\w*/.exec(source.slice(i, i + 200))!;
      advance(m[0].length);
      out.push({ t: 'var', v: m[0].slice(1), pos });
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^(0x[0-9a-fA-F_]+|0b[01_]+|[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9]+)?)/.exec(source.slice(i, i + 64))!;
      advance(m[0].length);
      out.push({ t: 'num', v: m[0].replace(/_/g, ''), pos });
      continue;
    }
    if (/[A-Za-z_\\\x80-￿]/.test(c)) {
      const m = /^\\?[A-Za-z_\x80-￿][\w\x80-￿]*(\\[A-Za-z_\x80-￿][\w\x80-￿]*)*/.exec(source.slice(i, i + 300));
      if (m) {
        advance(m[0].length);
        out.push({ t: 'id', v: m[0], pos });
        continue;
      }
    }
    const multi = MULTI.find((op) => source.startsWith(op, i));
    const v = multi ?? c;
    advance(v.length);
    out.push({ t: 'p', v, pos });
  }
  out.push({ t: 'eof', v: '', pos: { line, column: col } });
  return out;
}

class ParseError extends Error {}

export function parsePhp(source: string): ParsedPhp {
  return new Parser(tokenize(source)).file();
}

class Parser {
  private i = 0;
  readonly errors: Pos[] = [];

  constructor(private readonly toks: PToken[]) {}

  file(): ParsedPhp {
    const stmts: PStmt[] = [];
    while (this.peek().t !== 'eof') {
      const s = this.safeStatement();
      if (s) stmts.push(s);
    }
    return { stmts, errors: this.errors };
  }

  // -------------------------------------------------------------------------------------------
  // Token helpers
  // -------------------------------------------------------------------------------------------

  private peek(k = 0): PToken {
    return this.toks[Math.min(this.i + k, this.toks.length - 1)];
  }

  private next(): PToken {
    const t = this.peek();
    if (this.i < this.toks.length - 1) this.i++;
    return t;
  }

  private is(v: string, k = 0): boolean {
    const t = this.peek(k);
    return (t.t === 'p' || t.t === 'id') && (t.t === 'id' ? t.v.toLowerCase() === v : t.v === v);
  }

  private eat(v: string): boolean {
    if (this.is(v)) {
      this.next();
      return true;
    }
    return false;
  }

  private expect(v: string): void {
    if (!this.eat(v)) throw new ParseError(v);
  }

  /** Skips a balanced `(...)`, `[...]` or `{...}` starting at the current token. */
  private skipBalanced(): void {
    const open = this.peek().v;
    const close = open === '(' ? ')' : open === '[' ? ']' : '}';
    let depth = 0;
    while (this.peek().t !== 'eof') {
      const t = this.next();
      if (t.t !== 'p') continue;
      if (t.v === open) depth++;
      else if (t.v === close && --depth === 0) return;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------------------------

  private safeStatement(): PStmt | undefined {
    const start = this.i;
    try {
      return this.statement();
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      this.errors.push(this.toks[start].pos);
      this.i = start;
      this.recover();
      return undefined;
    }
  }

  /** Skips to just after the next `;` (or before an unmatched `}`) at the current depth. */
  private recover(): void {
    let depth = 0;
    if (this.peek().t !== 'eof') this.next();
    while (this.peek().t !== 'eof') {
      const t = this.peek();
      if (t.t === 'p') {
        if (t.v === '{' || t.v === '(' || t.v === '[') depth++;
        else if (t.v === '}' || t.v === ')' || t.v === ']') {
          if (depth === 0) return;
          depth--;
        } else if (t.v === ';' && depth === 0) {
          this.next();
          return;
        }
      }
      this.next();
    }
  }

  private block(): PStmt[] {
    this.expect('{');
    const body: PStmt[] = [];
    while (!this.is('}') && this.peek().t !== 'eof') {
      const s = this.safeStatement();
      if (s) body.push(s);
    }
    this.expect('}');
    return body;
  }

  private bodyOrStatement(): PStmt[] {
    if (this.is('{')) return this.block();
    if (this.eat(':')) {
      // Alternative syntax: `if (x): … endif;`
      const body: PStmt[] = [];
      while (this.peek().t !== 'eof' && !/^(endif|endforeach|endfor|endwhile|endswitch|else|elseif)$/i.test(this.peek().v)) {
        const s = this.safeStatement();
        if (s) body.push(s);
      }
      return body;
    }
    const s = this.safeStatement();
    return s ? [s] : [];
  }

  private statement(): PStmt | undefined {
    const t = this.peek();
    if (t.t === 'p') {
      if (t.v === ';') {
        this.next();
        return undefined;
      }
      if (t.v === '{') return { k: 'block', body: this.block() };
      if (t.v === '}') {
        // Unmatched closing brace at file level.
        this.next();
        return undefined;
      }
    }
    if (t.t === 'id') {
      const kw = t.v.toLowerCase();
      switch (kw) {
        case 'namespace': {
          this.next();
          const name = this.peek().t === 'id' ? this.next().v.replace(/^\\/, '') : '';
          if (this.is('{')) return { k: 'namespace', name, body: this.block() };
          this.eat(';');
          return { k: 'namespace', name };
        }
        case 'use':
          return this.useStatement();
        case 'if':
        case 'elseif':
        case 'while':
        case 'for':
        case 'foreach':
        case 'switch':
        case 'declare': {
          this.next();
          if (this.is('(')) this.skipBalanced();
          if (kw === 'declare' && this.eat(';')) return undefined;
          return { k: 'block', body: this.bodyOrStatement() };
        }
        case 'else':
          this.next();
          if (this.is('if')) return this.statement();
          return { k: 'block', body: this.bodyOrStatement() };
        case 'endif':
        case 'endforeach':
        case 'endfor':
        case 'endwhile':
        case 'endswitch':
          this.next();
          this.eat(';');
          return undefined;
        case 'do': {
          this.next();
          const body = this.bodyOrStatement();
          if (this.eat('while') && this.is('(')) this.skipBalanced();
          this.eat(';');
          return { k: 'block', body };
        }
        case 'try':
          this.next();
          return { k: 'block', body: this.block() };
        case 'catch': {
          this.next();
          let varName: string | undefined;
          if (this.is('(')) {
            this.next();
            while (!this.is(')') && this.peek().t !== 'eof') {
              const x = this.next();
              if (x.t === 'var') varName = x.v;
            }
            this.expect(')');
          }
          return { k: 'catch', varName, body: this.block() };
        }
        case 'finally':
          this.next();
          return { k: 'block', body: this.block() };
        case 'case':
        case 'default':
          if (kw === 'default' && !this.is(':', 1) && !this.is(';', 1)) break;
          this.next();
          while (!this.is(':') && !this.is(';') && this.peek().t !== 'eof') this.next();
          this.next();
          return undefined;
        case 'return': {
          const pos = this.next().pos;
          if (this.eat(';')) return { k: 'return', pos };
          const e = this.expr();
          this.endStatement();
          return { k: 'return', e, pos };
        }
        case 'throw': {
          const pos = this.next().pos;
          const e = this.expr();
          this.endStatement();
          return { k: 'throw', e, pos };
        }
        case 'echo':
        case 'print':
        case 'break':
        case 'continue':
        case 'global':
        case 'unset':
        case 'goto':
          this.recover();
          return undefined;
        case 'function':
          if (this.peek(1).t === 'id') return this.functionDecl();
          break;
        case 'abstract':
        case 'final':
        case 'readonly':
        case 'class':
        case 'interface':
        case 'trait':
        case 'enum':
          if (kw !== 'class' || this.peek(1).t === 'id') return this.classDecl();
          break;
        default:
          break;
      }
    }
    const pos = this.peek().pos;
    const e = this.expr();
    this.endStatement();
    return { k: 'expr', e, pos };
  }

  private endStatement(): void {
    if (this.eat(';')) return;
    // A statement may end at `}`, `?>` (already a `;`) or end of file.
    if (this.is('}') || this.peek().t === 'eof') return;
    throw new ParseError(';');
  }

  private useStatement(): PStmt | undefined {
    this.next();
    if (this.is('function') || this.is('const')) this.next();
    const first = this.peek().t === 'id' ? this.next().v.replace(/^\\/, '') : '';
    // Group use: `use App\Models\{User, Post as P};` (the trailing `\` is its own token).
    if (this.is('{') || this.is('\\')) {
      const base = first.replace(/\\$/, '');
      this.eat('\\');
      this.expect('{');
      const list: PStmt[] = [];
      while (!this.is('}') && this.peek().t !== 'eof') {
        const name = this.next().v.replace(/^\\/, '');
        let alias = name.split('\\').pop()!;
        if (this.eat('as')) alias = this.next().v;
        list.push({ k: 'use', alias, fqn: `${base}\\${name}` });
        this.eat(',');
      }
      this.expect('}');
      this.eat(';');
      return { k: 'block', body: list };
    }
    const list: PStmt[] = [];
    let name = first;
    for (;;) {
      let alias = name.split('\\').pop()!;
      if (this.eat('as')) alias = this.next().v;
      if (name) list.push({ k: 'use', alias, fqn: name });
      if (!this.eat(',')) break;
      name = this.peek().t === 'id' ? this.next().v.replace(/^\\/, '') : '';
    }
    this.eat(';');
    return list.length === 1 ? list[0] : { k: 'block', body: list };
  }

  private functionDecl(): PStmt {
    const pos = this.next().pos;
    this.eat('&');
    const name = this.next().v;
    const params = this.params();
    this.returnType();
    const body = this.is('{') ? this.block() : (this.eat(';'), []);
    return { k: 'function', name, params, body, pos };
  }

  private classDecl(): PStmt {
    while (this.is('abstract') || this.is('final') || this.is('readonly')) this.next();
    const kw = this.next();
    const nameTok = this.next();
    const pos = nameTok.pos;
    let ext: string | undefined;
    if (kw.v.toLowerCase() === 'enum' && this.eat(':')) this.next();
    if (this.eat('extends')) {
      ext = this.next().v.replace(/^\\/, '');
      while (this.eat(',')) this.next();
    }
    if (this.eat('implements')) {
      this.next();
      while (this.eat(',')) this.next();
    }
    const methods = this.classBody();
    return { k: 'class', name: nameTok.v, extends: ext, methods, pos };
  }

  private classBody(): PMethod[] {
    this.expect('{');
    const methods: PMethod[] = [];
    while (!this.is('}') && this.peek().t !== 'eof') {
      const start = this.i;
      try {
        let isStatic = false;
        while (this.peek().t === 'id' && MODIFIERS.has(this.peek().v.toLowerCase())) {
          if (this.peek().v.toLowerCase() === 'static') isStatic = true;
          this.next();
        }
        if (this.eat('function')) {
          this.eat('&');
          const nameTok = this.next();
          const params = this.params();
          this.returnType();
          const body = this.is('{') ? this.block() : (this.eat(';'), []);
          methods.push({ name: nameTok.v, params, body, pos: nameTok.pos, isStatic });
          continue;
        }
        // Properties, constants, trait uses and enum cases: skip to `;` (a trait `use` may have a block).
        while (!this.is(';') && !this.is('}') && this.peek().t !== 'eof') {
          if (this.is('{') || this.is('(') || this.is('[')) this.skipBalanced();
          else this.next();
        }
        this.eat(';');
      } catch (err) {
        if (!(err instanceof ParseError)) throw err;
        this.errors.push(this.toks[start].pos);
        this.i = start;
        this.recover();
      }
    }
    this.expect('}');
    return methods;
  }

  private params(): PParam[] {
    this.expect('(');
    const out: PParam[] = [];
    while (!this.is(')') && this.peek().t !== 'eof') {
      let promoted = false;
      let type: string | undefined;
      let name: string | undefined;
      let depth = 0;
      while (this.peek().t !== 'eof') {
        const t = this.peek();
        if (depth === 0 && t.t === 'p' && (t.v === ',' || t.v === ')')) break;
        this.next();
        if (t.t === 'p' && (t.v === '(' || t.v === '[')) depth++;
        else if (t.t === 'p' && (t.v === ')' || t.v === ']')) depth--;
        else if (depth === 0 && !name && t.t === 'id' && MODIFIERS.has(t.v.toLowerCase())) promoted = true;
        else if (depth === 0 && !name && t.t === 'id') type = t.v.replace(/^\\/, '');
        else if (depth === 0 && !name && t.t === 'var') name = t.v;
      }
      if (name) out.push({ name, type, promoted: promoted || undefined });
      this.eat(',');
    }
    this.expect(')');
    return out;
  }

  private returnType(): void {
    if (!this.eat(':')) return;
    while (this.peek().t === 'id' || this.is('?') || this.is('|') || this.is('&') || this.is('(') || this.is(')')) {
      if (this.is('{') || this.is(';')) break;
      this.next();
    }
  }

  // -------------------------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------------------------

  expr(): PNode {
    const left = this.binary();
    const t = this.peek();
    if (t.t === 'p' && ASSIGN.has(t.v)) {
      this.next();
      this.eat('&');
      return { k: 'assign', target: left, value: this.expr(), pos: t.pos };
    }
    if (this.is('?')) {
      this.next();
      const yes = this.is(':') ? left : this.expr();
      this.expect(':');
      const no = this.expr();
      return { k: 'bin', op: '?:', left: yes, right: no, pos: t.pos };
    }
    return left;
  }

  private binary(): PNode {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      const op = t.t === 'p' || t.t === 'id' ? (t.t === 'id' ? t.v.toLowerCase() : t.v) : '';
      if (!BINARY.has(op)) return left;
      this.next();
      const right = this.unary();
      if (op === '.') left = { k: 'concat', parts: [...(left.k === 'concat' ? left.parts : [left]), right], pos: left.pos };
      else left = { k: 'bin', op, left, right, pos: t.pos };
    }
  }

  private unary(): PNode {
    const t = this.peek();
    if (t.t === 'p' && ['!', '-', '+', '~', '@', '&', '++', '--'].includes(t.v)) {
      this.next();
      return this.unary();
    }
    if (t.t === 'p' && t.v === '(' && this.peek(1).t === 'id' && /^(int|integer|float|double|string|bool|boolean|array|object)$/i.test(this.peek(1).v) && this.is(')', 2)) {
      this.next();
      this.next();
      this.next();
      return this.unary();
    }
    if (t.t === 'id') {
      const kw = t.v.toLowerCase();
      if (kw === 'new') return this.postfix(this.newExpr());
      if (kw === 'clone' || kw === 'print' || kw === 'yield' || kw === 'await') {
        this.next();
        return this.unary();
      }
      if (kw === 'require' || kw === 'require_once' || kw === 'include' || kw === 'include_once') {
        this.next();
        const arg = this.expr();
        return { k: 'call', name: kw, args: [{ value: arg }], pos: t.pos };
      }
    }
    return this.postfix(this.primary());
  }

  private newExpr(): PNode {
    const pos = this.next().pos;
    if (this.is('class')) {
      this.next();
      if (this.is('(')) this.args();
      while (!this.is('{') && this.peek().t !== 'eof') this.next();
      this.skipBalanced();
      return { k: 'new', cls: 'class@anonymous', args: [], pos };
    }
    const t = this.next();
    const cls = t.t === 'id' ? t.v.replace(/^\\/, '') : t.t === 'var' ? `$${t.v}` : '';
    const args = this.is('(') ? this.args() : [];
    return { k: 'new', cls, args, pos };
  }

  private primary(): PNode {
    const t = this.next();
    switch (t.t) {
      case 'str':
        return { k: 'str', v: t.v, dyn: !!t.dyn, pos: t.pos };
      case 'num':
        return { k: 'num', v: Number(t.v), pos: t.pos };
      case 'var':
        return { k: 'var', name: t.v, pos: t.pos };
      case 'id': {
        const kw = t.v.toLowerCase();
        if (kw === 'function' || ((kw === 'static' || kw === 'fn') && (this.is('function') || this.is('fn') || this.is('(')))) {
          if (kw === 'static') this.next();
          const arrow = kw === 'fn' || this.toks[this.i - 1].v.toLowerCase() === 'fn';
          return this.closure(t.pos, arrow);
        }
        if (kw === 'array' && this.is('(')) return this.array(t.pos, ')');
        if (kw === 'list' && this.is('(')) return this.array(t.pos, ')');
        if (kw === 'match' && this.is('(')) {
          this.skipBalanced();
          if (this.is('{')) this.skipBalanced();
          return { k: 'unknown', pos: t.pos };
        }
        if (kw === 'isset' || kw === 'empty') {
          this.args();
          return { k: 'unknown', pos: t.pos };
        }
        if (this.is('(')) return { k: 'call', name: t.v.replace(/^\\/, ''), args: this.args(), pos: t.pos };
        return { k: 'name', name: t.v.replace(/^\\/, ''), pos: t.pos };
      }
      case 'p':
        if (t.v === '[') return this.array(t.pos, ']', true);
        if (t.v === '(') {
          const inner = this.expr();
          this.expect(')');
          return inner;
        }
        throw new ParseError(t.v);
      default:
        throw new ParseError('eof');
    }
  }

  private closure(pos: Pos, arrow: boolean): PNode {
    if (arrow) {
      if (this.is('fn')) this.next();
      this.eat('&');
      const params = this.params();
      this.returnType();
      this.expect('=>');
      const body = this.expr();
      return { k: 'closure', params, body: [{ k: 'return', e: body, pos: body.pos }], arrow: body, pos };
    }
    if (this.is('function')) this.next();
    this.eat('&');
    const params = this.params();
    if (this.eat('use') && this.is('(')) this.skipBalanced();
    this.returnType();
    const body = this.block();
    return { k: 'closure', params, body, pos };
  }

  /** `[a, 'k' => b, ...$c]`; `opened` means the bracket was already consumed. */
  private array(pos: Pos, close: string, opened = false): PNode {
    if (!opened) this.next();
    const items: { key?: PNode; value: PNode; spread?: boolean }[] = [];
    while (!this.is(close) && this.peek().t !== 'eof') {
      if (this.is(',')) {
        this.next();
        continue;
      }
      const spread = this.eat('...');
      let value = this.expr();
      let key: PNode | undefined;
      if (this.eat('=>')) {
        key = value;
        this.eat('&');
        value = this.expr();
      }
      items.push({ key, value, spread: spread || undefined });
      if (!this.eat(',')) break;
    }
    this.expect(close);
    return { k: 'arr', items, pos };
  }

  private args(): PArg[] {
    this.expect('(');
    const out: PArg[] = [];
    while (!this.is(')') && this.peek().t !== 'eof') {
      // First-class callable syntax: `strlen(...)`.
      if (this.is('...') && this.is(')', 1)) {
        this.next();
        break;
      }
      const spread = this.eat('...');
      let name: string | undefined;
      if (this.peek().t === 'id' && this.is(':', 1) && !this.is('::', 1)) {
        name = this.next().v;
        this.next();
      }
      out.push({ name, value: this.expr(), spread: spread || undefined });
      if (!this.eat(',')) break;
    }
    this.expect(')');
    return out;
  }

  private memberName(): string {
    const t = this.next();
    if (t.t === 'id' || t.t === 'var') return t.v;
    if (t.t === 'p' && t.v === '{') {
      this.i--;
      this.skipBalanced();
      return '{dynamic}';
    }
    throw new ParseError('member');
  }

  private postfix(node: PNode): PNode {
    let n = node;
    for (;;) {
      const t = this.peek();
      if (t.t !== 'p') return n;
      if (t.v === '->' || t.v === '?->') {
        this.next();
        const name = this.memberName();
        if (this.is('(')) n = { k: 'mcall', target: n, method: name, args: this.args(), pos: t.pos };
        else n = { k: 'prop', target: n, name, pos: t.pos };
        continue;
      }
      if (t.v === '::') {
        this.next();
        const cls = n.k === 'name' ? n.name : n.k === 'var' ? `$${n.name}` : '?';
        const m = this.next();
        if (m.t === 'id' && m.v.toLowerCase() === 'class') n = { k: 'class', name: cls, pos: n.pos };
        else if (m.t === 'var') n = { k: 'sprop', cls, name: m.v, pos: n.pos };
        else if (m.t === 'id' && this.is('(')) n = { k: 'scall', cls, method: m.v, args: this.args(), pos: n.pos };
        else if (m.t === 'id') n = { k: 'sconst', cls, name: m.v, pos: n.pos };
        else throw new ParseError('::');
        continue;
      }
      if (t.v === '[' || t.v === '{') {
        if (t.v === '{') return n;
        this.next();
        const index = this.is(']') ? undefined : this.expr();
        this.expect(']');
        n = { k: 'index', target: n, index, pos: t.pos };
        continue;
      }
      if (t.v === '(') {
        n = { k: 'dcall', callee: n, args: this.args(), pos: t.pos };
        continue;
      }
      if (t.v === '++' || t.v === '--') {
        this.next();
        continue;
      }
      return n;
    }
  }
}

/** All nodes inside a node (depth first), for searches like "does this use `$request`?". */
export function walkNode(n: PNode | undefined, fn: (n: PNode) => void): void {
  if (!n) return;
  fn(n);
  switch (n.k) {
    case 'arr':
      for (const it of n.items) {
        walkNode(it.key, fn);
        walkNode(it.value, fn);
      }
      return;
    case 'call':
    case 'scall':
    case 'new':
      for (const a of n.args) walkNode(a.value, fn);
      return;
    case 'mcall':
      walkNode(n.target, fn);
      for (const a of n.args) walkNode(a.value, fn);
      return;
    case 'dcall':
      walkNode(n.callee, fn);
      for (const a of n.args) walkNode(a.value, fn);
      return;
    case 'prop':
    case 'index':
      walkNode(n.target, fn);
      if (n.k === 'index') walkNode(n.index, fn);
      return;
    case 'concat':
      for (const p of n.parts) walkNode(p, fn);
      return;
    case 'bin':
      walkNode(n.left, fn);
      walkNode(n.right, fn);
      return;
    case 'assign':
      walkNode(n.target, fn);
      walkNode(n.value, fn);
      return;
    case 'closure':
      walkStmts(n.body, (s) => (s.k === 'expr' || s.k === 'return' || s.k === 'throw' ? walkNode(s.e, fn) : undefined));
      return;
    default:
      return;
  }
}

/** All statements (depth first, through blocks and catches, not into nested classes or closures). */
export function walkStmts(stmts: PStmt[], fn: (s: PStmt, inCatch?: string) => void, inCatch?: string): void {
  for (const s of stmts) {
    fn(s, inCatch);
    if (s.k === 'block') walkStmts(s.body, fn, inCatch);
    else if (s.k === 'catch') walkStmts(s.body, fn, s.varName ?? inCatch);
    else if (s.k === 'namespace' && s.body) walkStmts(s.body, fn, inCatch);
  }
}
