import * as path from 'path';
import type { BodyFacts, FileFacts, Pos } from '../analyzers/facts';
import type { AnalysisIssue, Endpoint, SourceLocation } from '../core/types';
import type { Registration } from '../core/shadowing';
import { resolveJsFacts } from './jsConstants';

export interface LinkOptions {
  springApplyContextPath: boolean;
  /** Module path aliases from tsconfig/jsconfig files. */
  pathAliases?: PathAliasConfig[];
}

/** One tsconfig/jsconfig: its folder, `baseUrl` and `paths`, with absolute targets. */
export interface PathAliasConfig {
  dir: string;
  baseUrl?: string;
  paths: { pattern: string; targets: string[] }[];
}

/**
 * Shared state for a single link pass. Linkers ask for facts of other files through
 * {@link LinkContext.getFacts}; files that were discovered but not analysed yet (because the
 * textual pre-filter skipped them) are recorded in `requested` so the engine can analyse them and
 * link again.
 */
export class LinkContext {
  readonly issues: AnalysisIssue[] = [];
  readonly requested = new Set<string>();
  /** Registration order of endpoints, for unreachable-route detection. */
  readonly registrations = new Map<string, Registration>();

  constructor(
    private readonly facts: ReadonlyMap<string, FileFacts>,
    readonly allFiles: ReadonlySet<string>,
    readonly projectRootOf: (file: string) => string,
    readonly options: LinkOptions,
  ) {}

  private basenameIndex?: Map<string, string[]>;

  /** Discovered files with the given base name (e.g. `UserService.java`). */
  filesNamed(basename: string): string[] {
    if (!this.basenameIndex) {
      this.basenameIndex = new Map();
      for (const f of this.allFiles) {
        const b = path.basename(f);
        const list = this.basenameIndex.get(b) ?? [];
        list.push(f);
        this.basenameIndex.set(b, list);
      }
    }
    return this.basenameIndex.get(basename) ?? [];
  }

  /** Marks files named `<name>.java` for analysis in the next round. */
  requestJavaClass(name: string): void {
    for (const f of this.filesNamed(`${name}.java`)) this.getFacts(f);
  }

  private readonly resolved = new Map<string, FileFacts>();

  /** Facts as linkers should see them: JS path references to imported constants are resolved. */
  getFacts(file: string): FileFacts | undefined {
    const f = this.rawFacts(file);
    if (f?.lang !== 'js') return f;
    let r = this.resolved.get(file);
    if (!r) {
      r = resolveJsFacts(file, f, (other) => this.rawFacts(other), (from, spec) => this.resolveModule(from, spec));
      this.resolved.set(file, r);
    }
    return r;
  }

  private rawFacts(file: string): FileFacts | undefined {
    const f = this.facts.get(file);
    if (!f && this.allFiles.has(file)) this.requested.add(file);
    return f;
  }

  /** Resolves a relative import, or an alias from the nearest tsconfig/jsconfig (`@/services/user`). */
  resolveModule(fromFile: string, specifier: string): string | undefined {
    return resolveWithAliases(fromFile, specifier, this.allFiles, this.options.pathAliases ?? []);
  }

  *files(): IterableIterator<[string, FileFacts]> {
    for (const file of this.facts.keys()) yield [file, this.getFacts(file)!];
  }

  issue(severity: AnalysisIssue['severity'], message: string, file?: string, pos?: Pos, kind: AnalysisIssue['kind'] = 'limitation'): void {
    this.issues.push({ kind, severity, message, location: file ? loc(file, pos) : undefined });
  }
}

export function loc(file: string, pos?: Pos): SourceLocation {
  return { file, line: pos?.line ?? 1, column: pos?.column ?? 1 };
}

export function shortFile(file: string): string {
  return path.basename(file);
}

const JS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Resolves a relative import specifier to a discovered file. Bare specifiers (packages) and
 * tsconfig path aliases are intentionally not resolved.
 */
export function resolveModule(fromFile: string, specifier: string, allFiles: ReadonlySet<string>): string | undefined {
  if (!specifier.startsWith('.') && !path.isAbsolute(specifier)) return undefined;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates: string[] = [base];
  const ext = path.extname(base);
  if (ext === '.js' || ext === '.jsx') {
    const stem = base.slice(0, -ext.length);
    candidates.push(stem + '.ts', stem + '.tsx');
  } else if (ext === '.mjs') {
    candidates.push(base.slice(0, -4) + '.mts');
  } else if (ext === '.cjs') {
    candidates.push(base.slice(0, -4) + '.cts');
  }
  for (const e of JS_EXTENSIONS) candidates.push(base + e);
  for (const e of JS_EXTENSIONS) candidates.push(path.join(base, 'index' + e));
  return candidates.find((c) => allFiles.has(c));
}

/**
 * Resolves `specifier` like {@link resolveModule}, and otherwise through the `paths` and
 * `baseUrl` of the nearest tsconfig/jsconfig above `fromFile`. Without a matching alias, `@/x`
 * follows the common convention of meaning `<nearest src folder>/x`. Package imports resolve
 * to nothing.
 */
export function resolveWithAliases(fromFile: string, specifier: string, allFiles: ReadonlySet<string>, aliases: readonly PathAliasConfig[]): string | undefined {
  if (specifier.startsWith('.') || path.isAbsolute(specifier)) return resolveModule(fromFile, specifier, allFiles);
  const config = aliases.filter((a) => fromFile.startsWith(a.dir + path.sep)).sort((a, b) => b.dir.length - a.dir.length)[0];
  if (config) {
    const base = config.baseUrl ?? config.dir;
    for (const { pattern, targets } of config.paths) {
      const star = pattern.indexOf('*');
      const match = star < 0 ? (specifier === pattern ? '' : undefined) : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1)) ? specifier.slice(star, specifier.length - (pattern.length - star - 1)) : undefined;
      if (match === undefined) continue;
      for (const t of targets) {
        const found = resolveModule(fromFile, path.resolve(base, t.replace('*', match)), allFiles);
        if (found) return found;
      }
    }
    if (config.baseUrl) {
      const found = resolveModule(fromFile, path.resolve(config.baseUrl, specifier), allFiles);
      if (found) return found;
    }
  }
  if (specifier.startsWith('@/')) {
    const parts = path.dirname(fromFile).split(path.sep);
    const src = parts.lastIndexOf('src');
    if (src >= 0) return resolveModule(fromFile, path.join(parts.slice(0, src + 1).join(path.sep) || path.sep, specifier.slice(2)), allFiles);
  }
  return undefined;
}

/** FNV-1a 32-bit hash, hex encoded. Used for stable endpoint ids. */
export function hashId(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function endpointId(e: Pick<Endpoint, 'framework' | 'method' | 'path' | 'location'>, extra = ''): string {
  return hashId(`${e.framework}|${e.method}|${e.path}|${e.location.file}|${e.location.line}|${e.location.column}|${extra}`);
}

/** Responses, risks, data access and ownership evidence of a handler, as endpoint fields. */
export function bodyFields(body: BodyFacts | undefined, file: string, lib: string): Pick<Endpoint, 'responses' | 'risks' | 'dataAccess' | 'ownership'> {
  if (!body) return {};
  const out: Pick<Endpoint, 'responses' | 'risks' | 'dataAccess' | 'ownership'> = {};
  // Express ignores what a handler returns; Fastify, Koa-style async handlers and Nest send it.
  const responses = (body.responses ?? []).filter((r) => r.via !== 'return' || lib !== 'express');
  if (responses.length) out.responses = responses.map((r) => ({ status: r.status, shape: r.shape, via: r.via, location: loc(file, r.pos) }));
  if (body.risks?.length) out.risks = body.risks.map((r) => ({ rule: r.rule, evidence: r.evidence, detail: r.detail, location: loc(file, r.pos) }));
  if (body.dataAccess?.length) out.dataAccess = body.dataAccess;
  if (body.readsUser || body.paramIdToData) out.ownership = { readsUser: !!body.readsUser, paramIdToData: !!body.paramIdToData };
  return out;
}
