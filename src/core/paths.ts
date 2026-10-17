import type { PathExpr, PathPart } from './types';

export function lit(value: string): PathExpr {
  return { parts: [{ lit: value }] };
}

export function isStaticExpr(expr: PathExpr): boolean {
  return expr.parts.every((p) => 'lit' in p);
}

export function partToDisplay(part: PathPart): string {
  if ('lit' in part) return part.lit;
  if ('ref' in part) return '${' + part.ref + '}';
  if ('dynamic' in part) return '${' + part.dynamic + '}';
  return part.regex;
}

/** Concatenates parts of an expression into a display string (no slash normalisation). */
export function exprToDisplay(expr: PathExpr): string {
  return expr.parts.map(partToDisplay).join('');
}

/** Merges adjacent literal parts. */
export function compactExpr(expr: PathExpr): PathExpr {
  const parts: PathPart[] = [];
  for (const part of expr.parts) {
    const last = parts[parts.length - 1];
    if ('lit' in part && last && 'lit' in last) {
      parts[parts.length - 1] = { lit: last.lit + part.lit };
    } else {
      parts.push(part);
    }
  }
  return { parts };
}

/**
 * Joins URL path segments the way routers do: duplicate slashes collapse, a leading slash is
 * guaranteed and a trailing slash is dropped (except for the root path).
 */
export function joinUrlPaths(...segments: string[]): string {
  const pieces: string[] = [];
  for (const segment of segments) {
    for (const piece of segment.split('/')) {
      if (piece.length > 0) pieces.push(piece);
    }
  }
  return '/' + pieces.join('/');
}

/**
 * Normalises a route path for duplicate detection: parameters in any syntax (`:id`, `{id}`,
 * `{id:\d+}`) become `{}`.
 */
export function normalizeForComparison(path: string): string {
  return joinUrlPaths(
    ...path.split('/').map((segment) =>
      segment
        .replace(/\{[^}]*\}/g, '{}')
        .replace(/:[A-Za-z_$][\w$]*(\([^)]*\))?/g, '{}'),
    ),
  );
}

export interface OpenApiPathConversion {
  path?: string;
  pathParams: { name: string; pattern?: string }[];
  /** Reason why the path cannot be represented exactly in OpenAPI. */
  unsupportedReason?: string;
}

/**
 * Converts a framework route path into an OpenAPI path template. Returns `unsupportedReason`
 * for wildcards, optional parameters and regular expressions, which OpenAPI cannot express.
 */
export function toOpenApiPath(path: string): OpenApiPathConversion {
  const pathParams: { name: string; pattern?: string }[] = [];
  const segments = path.split('/');
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '') {
      out.push('');
      continue;
    }
    if (/[*+]/.test(segment.replace(/\{[^}]*\}/g, '').replace(/\([^)]*\)/g, ''))) {
      return { pathParams: [], unsupportedReason: `wildcard segment "${segment}"` };
    }
    // Express-style :param, optionally with a regex constraint, possibly several per segment.
    const expressParam = /:([A-Za-z_$][\w$]*)(\(([^)]*)\))?(\?)?/g;
    if (segment.includes(':') && !segment.startsWith('{')) {
      let converted = '';
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = expressParam.exec(segment)) !== null) {
        if (match[4]) {
          return { pathParams: [], unsupportedReason: `optional parameter ":${match[1]}?"` };
        }
        converted += segment.slice(lastIndex, match.index) + `{${match[1]}}`;
        pathParams.push({ name: match[1], pattern: match[3] || undefined });
        lastIndex = match.index + match[0].length;
      }
      converted += segment.slice(lastIndex);
      if (/[?()]/.test(converted)) {
        return { pathParams: [], unsupportedReason: `pattern characters in "${segment}"` };
      }
      out.push(converted);
      continue;
    }
    // Spring/OpenAPI-style {param} or {param:regex}
    if (segment.includes('{')) {
      let ok = true;
      const converted = segment.replace(/\{([^}:]+)(?::([^}]*))?\}/g, (_m, name: string, pattern?: string) => {
        const trimmed = name.trim();
        if (!/^[A-Za-z_$][\w$.-]*$/.test(trimmed)) ok = false;
        pathParams.push({ name: trimmed, pattern: pattern || undefined });
        return `{${trimmed}}`;
      });
      if (!ok || /[{}]/.test(converted.replace(/\{[^}]+\}/g, ''))) {
        return { pathParams: [], unsupportedReason: `unsupported template "${segment}"` };
      }
      out.push(converted);
      continue;
    }
    if (/[?()]/.test(segment)) {
      return { pathParams: [], unsupportedReason: `pattern characters in "${segment}"` };
    }
    out.push(segment);
  }
  const result = out.join('/') || '/';
  return { path: result.startsWith('/') ? result : '/' + result, pathParams };
}
