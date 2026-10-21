/**
 * File-level facts that do not belong to a single handler: CORS configuration and the shapes of
 * TypeScript types (DTOs, interfaces, entities) that handlers declare as their response type.
 */
import type * as t from '@babel/types';
import { forEachChild, keyName, memberText, posOf, propName, unwrap, type Node } from './babelUtils';
import type { RiskFact, Shape, ShapeProp } from './facts';

const CORS_SOURCES = new Set(['cors', '@fastify/cors', 'fastify-cors', '@koa/cors', 'koa-cors', 'kcors']);
const MAX_TYPE_DEPTH = 4;
const DTO_NAME = /(Dto|DTO|Response|Entity|Model|View|Vm|Resource|Payload|Result|Schema|Record|Item|Details?)$/;

/**
 * Permissive CORS: `cors()` (any origin), `cors({ origin: true, credentials: true })` (reflects
 * any origin with cookies), `app.enableCors()`, `register(fastifyCors, { origin: '*' })` and
 * `Access-Control-Allow-Origin: *` set by hand. `detail` is `any`, `reflect` or `default`, with
 * `+credentials` when credentials are allowed.
 */
export function corsRisks(program: t.Program, imports: Record<string, { source: string; name: string }>): RiskFact[] {
  const corsNames = new Set(Object.entries(imports).filter(([, v]) => CORS_SOURCES.has(v.source)).map(([k]) => k));
  const out: RiskFact[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const callee = unwrap(node.callee as Node);
      const args = node.arguments as Node[];
      const name = callee.type === 'Identifier' ? callee.name : undefined;
      const prop = callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression' ? propName(callee) : undefined;
      // `require('cors')({ … })`
      const required = callee.type === 'CallExpression' && unwrap(callee.callee as Node).type === 'Identifier' && (unwrap(callee.callee as Node) as t.Identifier).name === 'require' && callee.arguments[0]?.type === 'StringLiteral' && CORS_SOURCES.has(callee.arguments[0].value);
      if ((name && corsNames.has(name)) || required) push(out, node, args[0], 'cors');
      else if (prop === 'enableCors') push(out, node, args[0], 'enableCors');
      else if (prop === 'register' && args[0] && unwrap(args[0]).type === 'Identifier' && corsNames.has((unwrap(args[0]) as t.Identifier).name)) push(out, node, args[1], 'register(cors)');
      else if ((prop === 'setHeader' || prop === 'header' || prop === 'set') && args.length >= 2) {
        const h = unwrap(args[0]);
        const v = unwrap(args[1]);
        if (h.type === 'StringLiteral' && h.value.toLowerCase() === 'access-control-allow-origin') {
          if (v.type === 'StringLiteral' && v.value === '*') out.push({ rule: 'permissive-cors', pos: posOf(node), evidence: `${prop}('Access-Control-Allow-Origin', '*')`, detail: 'any' });
          else if (/\.headers\.origin$|\.get\(['"]origin['"]\)$/i.test(memberText(v) ?? '')) out.push({ rule: 'permissive-cors', pos: posOf(node), evidence: `${prop}('Access-Control-Allow-Origin', ${memberText(v)})`, detail: 'reflect' });
        }
      }
    }
    forEachChild(node, visit);
  };
  visit(program as Node);
  return out;
}

function push(out: RiskFact[], node: Node, options: Node | undefined, label: string): void {
  const opts = options ? unwrap(options) : undefined;
  if (!opts) {
    out.push({ rule: 'permissive-cors', pos: posOf(node), evidence: `${label}()`, detail: 'default' });
    return;
  }
  if (opts.type !== 'ObjectExpression') return;
  let origin: 'any' | 'reflect' | undefined;
  let credentials = false;
  for (const p of opts.properties) {
    if (p.type !== 'ObjectProperty' && p.type !== 'ObjectMethod') continue;
    const key = keyName(p.key);
    const value = p.type === 'ObjectProperty' ? unwrap(p.value as Node) : p;
    if (key === 'origin') {
      if (value.type === 'StringLiteral' && value.value === '*') origin = 'any';
      else if (value.type === 'BooleanLiteral' && value.value) origin = 'reflect';
      else if (value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression' || value.type === 'ObjectMethod') {
        if (callsBackWithTrue(value as t.Function)) origin = 'reflect';
      }
    } else if (key === 'credentials' && value.type === 'BooleanLiteral' && value.value) {
      credentials = true;
    }
  }
  if (!origin) return;
  const parts = [`origin: ${origin === 'any' ? "'*'" : 'true'}`, credentials ? 'credentials: true' : ''].filter(Boolean).join(', ');
  out.push({ rule: 'permissive-cors', pos: posOf(node), evidence: `${label}({ ${parts} })`, detail: credentials ? `${origin}+credentials` : origin });
}

/** `(origin, cb) => cb(null, true)` with no condition: every origin is allowed. */
function callsBackWithTrue(fn: t.Function): boolean {
  const cb = fn.params[1];
  if (!cb || cb.type !== 'Identifier' || fn.body.type === 'BlockStatement' && fn.body.body.some((s) => s.type === 'IfStatement')) return false;
  let found = false;
  const visit = (n: Node): void => {
    if (found) return;
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === cb.name && n.arguments.length === 2) {
      const v = n.arguments[1];
      if (v.type === 'BooleanLiteral' && v.value) found = true;
    }
    if (n.type === 'ConditionalExpression' || n.type === 'LogicalExpression') return;
    forEachChild(n, visit);
  };
  visit(fn.body as Node);
  return found;
}

// ---------------------------------------------------------------------------------------------
// TypeScript types
// ---------------------------------------------------------------------------------------------

type Decl = { kind: 'members'; members: Node[] } | { kind: 'class'; node: t.ClassDeclaration } | { kind: 'alias'; type: Node };

/**
 * Shapes of top-level interfaces, object type aliases and DTO-like classes, keyed by name.
 * Properties marked `@Exclude()` (class-transformer) or `@ApiHideProperty()` are left out, the
 * way they are left out of responses.
 */
export function exportedTypes(program: t.Program): Record<string, Shape> {
  const decls = new Map<string, Decl>();
  for (const raw of program.body) {
    const stmt = (raw.type === 'ExportNamedDeclaration' || raw.type === 'ExportDefaultDeclaration') && raw.declaration ? (raw.declaration as Node) : (raw as Node);
    if (stmt.type === 'TSInterfaceDeclaration') decls.set(stmt.id.name, { kind: 'members', members: stmt.body.body as Node[] });
    else if (stmt.type === 'TSTypeAliasDeclaration') decls.set(stmt.id.name, { kind: 'alias', type: stmt.typeAnnotation as Node });
    else if (stmt.type === 'ClassDeclaration' && stmt.id && isDtoClass(stmt)) decls.set(stmt.id.name, { kind: 'class', node: stmt });
  }
  const out: Record<string, Shape> = Object.create(null) as Record<string, Shape>;
  for (const [name] of decls) {
    const s = shapeOfDecl(name, decls, 0);
    if (s?.t === 'object' && Object.keys(s.props).length > 0) out[name] = s;
  }
  return out;
}

function isDtoClass(cls: t.ClassDeclaration): boolean {
  const typed = cls.body.body.filter((m) => m.type === 'ClassProperty' && !m.static && m.typeAnnotation);
  if (typed.length === 0) return false;
  const methods = cls.body.body.filter((m) => m.type === 'ClassMethod' && m.kind === 'method');
  const decorated = (cls.decorators ?? []).some((d) => /^(Entity|ObjectType|Schema|Table|Exclude|Expose)$/.test(decoratorName(d) ?? ''));
  return DTO_NAME.test(cls.id?.name ?? '') || decorated || methods.length === 0;
}

function decoratorName(d: t.Decorator): string | undefined {
  const e = unwrap(d.expression as Node);
  const callee = e.type === 'CallExpression' ? unwrap(e.callee as Node) : e;
  return callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression' ? propName(callee) : undefined;
}

function shapeOfDecl(name: string, decls: Map<string, Decl>, depth: number): Shape | undefined {
  const d = decls.get(name);
  if (!d || depth > MAX_TYPE_DEPTH) return undefined;
  if (d.kind === 'alias') return tsShape(d.type, decls, depth + 1);
  const props: Record<string, ShapeProp> = Object.create(null) as Record<string, ShapeProp>;
  const members = d.kind === 'members' ? d.members : (d.node.body.body as Node[]);
  for (const m of members) {
    if (m.type !== 'TSPropertySignature' && m.type !== 'ClassProperty') continue;
    if (m.type === 'ClassProperty' && (m.static || (m.decorators ?? []).some((dec) => /^(Exclude|ApiHideProperty)$/.test(decoratorName(dec) ?? '')))) continue;
    const key = keyName(m.key as Node);
    if (!key) continue;
    const ann = m.typeAnnotation && m.typeAnnotation.type === 'TSTypeAnnotation' ? (m.typeAnnotation.typeAnnotation as Node) : undefined;
    props[key] = { shape: ann ? tsShape(ann, decls, depth + 1) : { t: 'unknown' }, optional: m.optional || undefined };
  }
  return { t: 'object', props };
}

function tsShape(node: Node, decls: Map<string, Decl>, depth: number): Shape {
  switch (node.type) {
    case 'TSStringKeyword':
      return { t: 'string' };
    case 'TSNumberKeyword':
    case 'TSBigIntKeyword':
      return { t: 'number' };
    case 'TSBooleanKeyword':
      return { t: 'boolean' };
    case 'TSNullKeyword':
      return { t: 'null' };
    case 'TSLiteralType': {
      const l = node.literal;
      return l.type === 'StringLiteral' || l.type === 'TemplateLiteral' ? { t: 'string' } : l.type === 'NumericLiteral' ? { t: 'number' } : l.type === 'BooleanLiteral' ? { t: 'boolean' } : { t: 'unknown' };
    }
    case 'TSArrayType':
      return { t: 'array', items: tsShape(node.elementType as Node, decls, depth + 1) };
    case 'TSTypeLiteral': {
      const props: Record<string, ShapeProp> = Object.create(null) as Record<string, ShapeProp>;
      for (const m of node.members) {
        if (m.type !== 'TSPropertySignature') continue;
        const key = keyName(m.key as Node);
        if (!key) continue;
        const ann = m.typeAnnotation?.typeAnnotation as Node | undefined;
        props[key] = { shape: ann ? tsShape(ann, decls, depth + 1) : { t: 'unknown' }, optional: m.optional || undefined };
      }
      return { t: 'object', props };
    }
    case 'TSUnionType': {
      const nonNull = node.types.filter((x) => x.type !== 'TSNullKeyword' && x.type !== 'TSUndefinedKeyword');
      return nonNull.length === 1 ? tsShape(nonNull[0] as Node, decls, depth) : { t: 'unknown' };
    }
    case 'TSTypeReference': {
      if (node.typeName.type !== 'Identifier') return { t: 'unknown' };
      const name = node.typeName.name;
      if (name === 'Date') return { t: 'string' };
      if (name === 'Array' && node.typeParameters?.params[0]) return { t: 'array', items: tsShape(node.typeParameters.params[0] as Node, decls, depth + 1) };
      if (depth <= MAX_TYPE_DEPTH && decls.has(name)) return shapeOfDecl(name, decls, depth) ?? { t: 'unknown', expr: name };
      return { t: 'unknown', expr: name };
    }
    default:
      return { t: 'unknown' };
  }
}
