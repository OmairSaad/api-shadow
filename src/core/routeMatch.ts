/**
 * Route patterns as matchers: which concrete URLs a route accepts, whether one route accepts
 * every request another one does (shadowing), and which routes a client URL reaches.
 */
import type { Framework } from './types';

export type Segment =
  | { kind: 'lit'; text: string }
  /** A whole-segment parameter; `regex` when constrained (`:id(\d+)`, `{id:\d+}`). */
  | { kind: 'param'; regex?: RegExp; source?: string }
  /** A segment mixing text and parameters (`:name.:ext`, `file-{id}`). */
  | { kind: 'mixed'; regex: RegExp }
  /** Matches the rest of the path (`*`, `**`, `{*rest}`, `*splat`). */
  | { kind: 'rest' };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compile(source: string): RegExp | undefined {
  try {
    return new RegExp(`^(?:${source})$`);
  } catch {
    return undefined;
  }
}

/**
 * Parses a declared route path. Undefined for paths that can't be matched reliably: regular
 * expressions, unresolved parts and optional parameters.
 */
export function parseRoute(path: string, framework: Framework): Segment[] | undefined {
  if (path.includes('${') || path.includes(' ~ ')) return undefined;
  const segments: Segment[] = [];
  const parts = path.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    const last = i === parts.length - 1;
    if (framework === 'spring' || framework === 'laravel') {
      if (seg === '**' || /^\{\*[^}]*\}$/.test(seg)) {
        if (!last) return undefined;
        segments.push({ kind: 'rest' });
        continue;
      }
      const whole = /^\{\s*[^}:]+?\s*(?::([^}]*))?\}$/.exec(seg);
      if (whole) {
        const regex = whole[1] ? compile(whole[1]) : undefined;
        if (whole[1] && !regex) return undefined;
        segments.push({ kind: 'param', regex, source: whole[1] });
        continue;
      }
      if (seg.includes('{') || seg.includes('*') || seg.includes('?')) {
        const source = seg
          .split(/(\{[^}]*\})/)
          .map((piece) => (piece.startsWith('{') ? `(${/:(.*)\}$/.exec(piece)?.[1] ?? '[^/]+'})` : piece.split('*').map(escapeRegExp).join('[^/]*')))
          .join('');
        const regex = compile(source);
        if (!regex) return undefined;
        segments.push({ kind: 'mixed', regex });
        continue;
      }
      segments.push({ kind: 'lit', text: seg });
      continue;
    }
    // Express, Koa, Fastify and NestJS (path-to-regexp style).
    if (seg === '*' || /^\*[A-Za-z_$][\w$]*$/.test(seg) || seg === '(.*)') {
      if (!last) return undefined;
      segments.push({ kind: 'rest' });
      continue;
    }
    if (/\?/.test(seg.replace(/\([^)]*\)/g, ''))) return undefined; // optional parameter
    const whole = /^:[A-Za-z_$][\w$]*(?:\(([^)]*)\))?$/.exec(seg);
    if (whole) {
      const regex = whole[1] ? compile(whole[1]) : undefined;
      if (whole[1] && !regex) return undefined;
      segments.push({ kind: 'param', regex, source: whole[1] });
      continue;
    }
    if (seg.includes(':') || seg.includes('*') || seg.includes('(')) {
      let source = '';
      const re = /:([A-Za-z_$][\w$]*)(?:\(([^)]*)\))?|\*/g;
      let lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(seg)) !== null) {
        source += escapeRegExp(seg.slice(lastIndex, m.index)) + (m[0] === '*' ? '.*' : `(${m[2] ?? '[^/]+?'})`);
        lastIndex = m.index + m[0].length;
      }
      source += escapeRegExp(seg.slice(lastIndex));
      const regex = compile(source);
      if (!regex) return undefined;
      segments.push({ kind: 'mixed', regex });
      continue;
    }
    segments.push({ kind: 'lit', text: seg });
  }
  return segments;
}

/** Express matches paths case-insensitively by default; the others are case-sensitive. */
function caseInsensitive(framework: Framework): boolean {
  return framework === 'express';
}

function segmentAccepts(seg: Segment, text: string, ci: boolean): boolean {
  switch (seg.kind) {
    case 'lit':
      return ci ? seg.text.toLowerCase() === text.toLowerCase() : seg.text === text;
    case 'param':
      return text.length > 0 && (!seg.regex || seg.regex.test(text));
    case 'mixed':
      return seg.regex.test(text);
    case 'rest':
      return true;
  }
}

/**
 * True when `earlier` accepts every request `later` accepts and is strictly more general (at
 * least one parameter where `later` has fixed text). Equal patterns are duplicates, not shadowing.
 */
export function shadows(earlier: Segment[], later: Segment[], framework: Framework): boolean {
  const ci = caseInsensitive(framework);
  let moreGeneral = false;
  for (let i = 0; i < Math.max(earlier.length, later.length); i++) {
    const a = earlier[i];
    const b = later[i];
    if (a?.kind === 'rest') return moreGeneral || b?.kind !== 'rest' || i < later.length - 1;
    if (!a || !b) return false;
    if (b.kind === 'rest') return false;
    if (a.kind === 'lit') {
      if (b.kind !== 'lit' || !segmentAccepts(a, b.text, ci)) return false;
      continue;
    }
    if (b.kind === 'lit') {
      if (!segmentAccepts(a, b.text, ci)) return false;
      moreGeneral = true;
      continue;
    }
    // Both parameters: `earlier` covers `later` only if it is unconstrained or equally constrained.
    if (a.kind === 'param' && (!a.regex || (b.kind === 'param' && b.source === a.source))) continue;
    return false;
  }
  return moreGeneral;
}

/** A client URL split into segments; `null` marks a segment containing an unknown value. */
export interface ClientUrl {
  segments: (string | null)[];
  /** The path is relative to something we can't see (`${API_URL}/users`, an axios instance). */
  unknownPrefix: boolean;
  /** Absolute URL to a host other than localhost. */
  external: boolean;
}

const DYNAMIC = '\uE000';

/**
 * Normalises a client URL as displayed (`${expr}` for unknown parts): drops the origin, query
 * string and hash, and marks segments with unknown values.
 */
export function parseClientUrl(display: string, unknownBase = false): ClientUrl | undefined {
  let text = display.replace(/\$\{[^}]*\}/g, DYNAMIC).trim();
  let unknownPrefix = unknownBase;
  let external = false;
  const origin = /^(?:https?:)?\/\/([^/]*)/i.exec(text);
  if (origin) {
    const host = origin[1];
    external = !/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|$)/i.test(host) && !host.includes(DYNAMIC);
    text = text.slice(origin[0].length);
  } else if (text.startsWith(DYNAMIC)) {
    // `${API_URL}/users`: the leading value is a base URL (or a whole unknown path).
    const rest = text.replace(/^\uE000+/, '');
    if (!rest.startsWith('/')) return undefined;
    unknownPrefix = true;
    text = rest;
  } else if (!text.startsWith('/')) {
    // Relative paths like `users/1` resolve against the page or the client's base URL.
    if (!unknownBase) return undefined;
  }
  text = text.split(/[?#]/)[0];
  const segments = text
    .split('/')
    .filter(Boolean)
    .map((s) => (s.includes(DYNAMIC) ? null : s));
  if (segments.length === 0 && !unknownPrefix) return { segments, unknownPrefix, external };
  return { segments, unknownPrefix, external };
}

/**
 * How well a client URL matches a route: higher is better, undefined for no match. With an
 * unknown prefix the route may be longer than the URL (`${BASE}/users` matches `/api/users`).
 */
export function matchScore(url: ClientUrl, route: Segment[], framework: Framework): number | undefined {
  const ci = caseInsensitive(framework);
  const restAt = route.findIndex((s) => s.kind === 'rest');
  const fixed = restAt >= 0 ? route.slice(0, restAt) : route;
  let offset = 0;
  if (url.unknownPrefix) {
    offset = fixed.length - url.segments.length;
    if (offset < 0 && restAt < 0) return undefined;
    offset = Math.max(0, offset);
  } else if (restAt < 0 ? url.segments.length !== route.length : url.segments.length < fixed.length) {
    return undefined;
  }
  let score = url.unknownPrefix ? 0 : 1;
  for (let i = 0; i < url.segments.length; i++) {
    const seg = route[offset + i] ?? (restAt >= 0 ? route[restAt] : undefined);
    const text = url.segments[i];
    if (!seg) return undefined;
    if (seg.kind === 'rest') break;
    if (text === null) {
      // An unknown value fits a parameter, and only possibly a fixed segment.
      if (seg.kind === 'lit') score -= 2;
      else score += 1;
      continue;
    }
    if (!segmentAccepts(seg, text, ci)) return undefined;
    score += seg.kind === 'lit' ? 3 : 1;
  }
  return score;
}
