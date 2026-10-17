import { parse, type ParserPlugin } from '@babel/parser';
import type * as t from '@babel/types';
import type { FileIssue, Pos } from './facts';

export type Node = t.Node;

export interface ParsedJs {
  ast?: t.File;
  issues: FileIssue[];
}

/** Parses JS/TS with error recovery. Never throws. */
export function parseJs(source: string, filePath: string): ParsedJs {
  const lower = filePath.toLowerCase();
  const isTs = /\.(ts|mts|cts|tsx)$/.test(lower);
  const isTsx = lower.endsWith('.tsx');
  const plugins: ParserPlugin[] = ['decorators-legacy'];
  if (isTs) {
    plugins.push('typescript');
    if (isTsx) plugins.push('jsx');
  } else {
    plugins.push('jsx');
  }
  const options = {
    sourceType: 'unambiguous' as const,
    errorRecovery: true,
    allowReturnOutsideFunction: true,
    allowImportExportEverywhere: true,
    allowAwaitOutsideFunction: true,
    allowSuperOutsideMethod: true,
    allowUndeclaredExports: true,
    plugins,
  };
  const issues: FileIssue[] = [];
  const pluginSets = isTs ? [plugins] : [plugins, ['decorators-legacy', 'typescript'] as ParserPlugin[]];
  type BabelError = { message: string; loc?: { line: number; column: number; index?: number } };
  const attempt = (text: string): { ast: t.File } | { error: BabelError } => {
    let error: BabelError | undefined;
    for (const set of pluginSets) {
      try {
        return { ast: parse(text, { ...options, plugins: set }) };
      } catch (err) {
        error ??= err as BabelError;
      }
    }
    return { error: error as BabelError };
  };

  // Babel's errorRecovery handles many errors; for the rest, search for up to
  // MAX_LINE_RECOVERY lines near the reported error whose removal (replaced by spaces, keeping
  // offsets and line numbers intact) makes the file parse. The reported position is often after
  // the real cause, so the error line and the two lines before it are candidates.
  let current = attempt(source);
  const firstError: BabelError | undefined = 'error' in current ? current.error : undefined;
  let ignoredLines: number[] = [];
  if ('error' in current && source.length <= MAX_RECOVERY_SOURCE) {
    const search = (text: string, result: ReturnType<typeof attempt>, ignored: number[]): { result: ReturnType<typeof attempt>; ignored: number[] } | undefined => {
      if ('ast' in result) return { result, ignored };
      if (ignored.length >= MAX_LINE_RECOVERY) return undefined;
      const line = result.error.loc?.line;
      if (!line) return undefined;
      for (const candidate of [line, line - 1, line - 2]) {
        if (candidate < 1 || ignored.includes(candidate)) continue;
        const blanked = blankLine(text, candidate);
        const found = search(blanked, attempt(blanked), [...ignored, candidate]);
        if (found) return found;
      }
      return undefined;
    };
    const recovered = search(source, current, []);
    if (recovered) {
      current = recovered.result;
      ignoredLines = recovered.ignored;
    }
  }
  if ('ast' in current) {
    const errors = (current.ast as unknown as { errors?: BabelError[] }).errors ?? [];
    const first = firstError ?? errors[0];
    if (first) {
      const extra = ignoredLines.length > 0 ? ` Ignored line(s) ${ignoredLines.sort((a, b) => a - b).join(', ')} to continue.` : '';
      issues.push({
        kind: 'parse-error',
        severity: 'warning',
        message: `File has syntax errors; results may be incomplete. First: ${first.message}.${extra}`,
        pos: first.loc ? { line: first.loc.line, column: first.loc.column + 1 } : undefined,
      });
    }
    return { ast: current.ast, issues };
  }
  const error = firstError ?? current.error;
  issues.push({
    kind: 'parse-error',
    severity: 'error',
    message: `Could not parse file: ${error.message}`,
    pos: error.loc ? { line: error.loc.line, column: error.loc.column + 1 } : undefined,
  });
  return { issues };
}

const MAX_LINE_RECOVERY = 3;
const MAX_RECOVERY_SOURCE = 256 * 1024;

function blankLine(text: string, line: number): string {
  let start = 0;
  for (let i = 1; i < line; i++) {
    const next = text.indexOf('\n', start);
    if (next < 0) return text;
    start = next + 1;
  }
  let end = text.indexOf('\n', start);
  if (end < 0) end = text.length;
  return text.slice(0, start) + ' '.repeat(end - start) + text.slice(end);
}

export function posOf(node: Node): Pos {
  const loc = node.loc?.start;
  return { line: loc?.line ?? 1, column: (loc?.column ?? 0) + 1 };
}

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'range', 'type', 'errors', 'tokens', 'comments']);

/** Iterates direct child nodes. */
export function forEachChild(node: Node, fn: (child: Node) => void): void {
  const record = node as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) fn(item);
      }
    } else if (isNode(value)) {
      fn(value);
    }
  }
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

export function isFunctionLike(node: Node): node is t.Function {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'ClassMethod' ||
    node.type === 'ClassPrivateMethod' ||
    node.type === 'ObjectMethod'
  );
}

/** Removes TypeScript-only wrappers and parentheses. */
export function unwrap(node: Node): Node {
  let current = node;
  for (;;) {
    switch (current.type) {
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
      case 'TSTypeAssertion':
      case 'ParenthesizedExpression':
      case 'TSInstantiationExpression':
        current = current.expression;
        continue;
      default:
        return current;
    }
  }
}

/** Name of a non-computed property key, or string-literal computed key. */
export function propName(node: t.MemberExpression | t.OptionalMemberExpression): string | undefined {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.property.type === 'StringLiteral') return node.property.value;
  return undefined;
}

export function keyName(key: Node): string | undefined {
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'StringLiteral') return key.value;
  if (key.type === 'NumericLiteral') return String(key.value);
  return undefined;
}

/** Dotted text for identifiers / member chains (`a.b.c`, `this.x`), else undefined. */
export function memberText(node: Node): string | undefined {
  const n = unwrap(node);
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'ThisExpression') return 'this';
  if (n.type === 'Super') return 'super';
  if (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') {
    const obj = memberText(n.object);
    const prop = propName(n);
    if (obj && prop) return `${obj}.${prop}`;
  }
  return undefined;
}

/**
 * A short, safe label for an expression used as middleware. Arguments are never included so
 * that literal secrets in code (e.g. `basicAuth({ users: { admin: '...' } })`) do not leak into
 * the UI or exports.
 */
export function shortLabel(node: Node): string {
  const n = unwrap(node);
  const text = memberText(n);
  if (text) return text;
  if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression' || n.type === 'NewExpression') {
    const callee = n.callee.type === 'V8IntrinsicIdentifier' ? undefined : shortLabel(n.callee);
    if (callee && callee !== '(expression)') return `${n.type === 'NewExpression' ? 'new ' : ''}${callee}()`;
  }
  if (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression') {
    return n.type === 'FunctionExpression' && n.id ? n.id.name : '(inline function)';
  }
  if (n.type === 'ArrayExpression') return '[…]';
  return '(expression)';
}

/** Simple name of a TS type annotation (`UsersService`, `Repository`), if any. */
export function typeNameOf(annotation: Node | null | undefined): string | undefined {
  if (!annotation) return undefined;
  let node: Node = annotation;
  if (node.type === 'TSTypeAnnotation' || node.type === 'TypeAnnotation') node = node.typeAnnotation;
  if (node.type === 'TSTypeReference') {
    const name = node.typeName;
    if (name.type === 'Identifier') return name.name;
    if (name.type === 'TSQualifiedName') return `${tsEntityText(name.left)}.${name.right.name}`;
  }
  if (node.type === 'TSArrayType') {
    const inner = typeNameOf(node.elementType);
    return inner ? `${inner}[]` : undefined;
  }
  if (node.type === 'TSStringKeyword') return 'string';
  if (node.type === 'TSNumberKeyword') return 'number';
  if (node.type === 'TSBooleanKeyword') return 'boolean';
  return undefined;
}

function tsEntityText(node: t.TSEntityName): string {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'TSQualifiedName') return `${tsEntityText(node.left)}.${node.right.name}`;
  return 'this';
}
