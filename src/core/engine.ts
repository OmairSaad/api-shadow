/**
 * Orchestrates discovery → per-file analysis (cached) → cross-file linking → duplicate detection.
 * Host-agnostic: the VS Code layer supplies a {@link FileHost}; tests use a Node implementation.
 */
import * as path from 'path';
import { analyzeJava, isJavaCandidate } from '../analyzers/javaAnalyzer';
import { analyzeJs, isJsCandidate } from '../analyzers/jsAnalyzer';
import { analyzeSpringConfig, isSpringConfigFile } from '../analyzers/springConfig';
import { FACTS_VERSION, type FileFacts } from '../analyzers/facts';
import { LinkContext, loc } from '../linkers/context';
import { ExpressLinker } from '../linkers/expressLinker';
import { NestLinker } from '../linkers/nestLinker';
import { SpringLinker } from '../linkers/springLinker';
import { findDuplicates } from './duplicates';
import { compareEndpoints } from '../export/markdown';
import {
  throwIfCancelled,
  nullLogger,
  type AnalysisIssue,
  type AnalysisResult,
  type CancellationLike,
  type Endpoint,
  type Framework,
  type Logger,
} from './types';

export interface FileStat {
  mtime: number;
  size: number;
}

export interface FileHost {
  /** All candidate files (sources, Spring config, project markers), already excluding ignored folders. */
  listFiles(token?: CancellationLike): Promise<string[]>;
  readFile(file: string): Promise<string>;
  stat(file: string): Promise<FileStat | undefined>;
}

export interface EngineOptions {
  frameworks: ReadonlySet<Framework>;
  maxFiles: number;
  maxFileSizeBytes: number;
  springApplyContextPath: boolean;
  /** Workspace folder roots, used as a fallback project root. */
  workspaceRoots: string[];
}

interface CacheEntry {
  mtime: number;
  size: number;
  /** Undefined when the textual pre-filter decided the file is irrelevant. */
  facts?: FileFacts;
}

export interface SerializedCache {
  version: number;
  entries: Record<string, CacheEntry>;
}

const MARKERS = new Set(['package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts']);
const JS_EXT = /\.(js|cjs|mjs|jsx|ts|cts|mts|tsx)$/i;
const BATCH = 32;
const MAX_LINK_ROUNDS = 4;

type Kind = 'js' | 'java' | 'config' | 'kotlin' | 'marker' | 'other';

function kindOf(file: string): Kind {
  const base = path.basename(file);
  if (MARKERS.has(base)) return 'marker';
  if (isSpringConfigFile(file)) return 'config';
  if (JS_EXT.test(file) && !file.endsWith('.d.ts')) return 'js';
  if (file.endsWith('.java')) return 'java';
  if (file.endsWith('.kt')) return 'kotlin';
  return 'other';
}

export class AnalysisEngine {
  private cache = new Map<string, CacheEntry>();
  private files: string[] | undefined;
  private readonly dirty = new Set<string>();
  private needsListing = true;
  private projectRoots = new Set<string>();
  private readonly rootCache = new Map<string, string>();

  constructor(
    private readonly host: FileHost,
    private options: EngineOptions,
    private readonly logger: Logger = nullLogger,
  ) {}

  updateOptions(options: EngineOptions): void {
    this.options = options;
    this.needsListing = true;
  }

  /** Content of these files changed. */
  markChanged(files: Iterable<string>): void {
    for (const f of files) this.dirty.add(f);
  }

  /** Files were created or deleted: re-list on next run. */
  markStructureChanged(deleted: Iterable<string> = []): void {
    for (const f of deleted) this.cache.delete(f);
    this.needsListing = true;
  }

  clearCache(): void {
    this.cache.clear();
    this.needsListing = true;
  }

  serializeCache(): SerializedCache {
    const entries: Record<string, CacheEntry> = {};
    for (const [k, v] of this.cache) entries[k] = v;
    return { version: FACTS_VERSION, entries };
  }

  loadCache(data: unknown): boolean {
    const d = data as SerializedCache | undefined;
    if (!d || d.version !== FACTS_VERSION || typeof d.entries !== 'object' || d.entries === null) return false;
    this.cache = new Map(Object.entries(d.entries));
    return true;
  }

  async analyze(token?: CancellationLike, options: { full?: boolean } = {}): Promise<AnalysisResult> {
    const started = Date.now();
    const issues: AnalysisIssue[] = [];
    let truncated = false;
    if (options.full || this.needsListing || !this.files) {
      const listed = await this.host.listFiles(token);
      throwIfCancelled(token);
      listed.sort();
      this.projectRoots = new Set(listed.filter((f) => kindOf(f) === 'marker').map((f) => path.dirname(f)));
      this.rootCache.clear();
      let sources = listed.filter((f) => {
        const k = kindOf(f);
        return k !== 'marker' && k !== 'other';
      });
      if (sources.length > this.options.maxFiles) {
        truncated = true;
        issues.push({
          kind: 'skipped',
          severity: 'warning',
          message: `Workspace has ${sources.length} candidate files; only the first ${this.options.maxFiles} were analysed (setting apiShadow.maxFiles).`,
        });
        sources = sources.slice(0, this.options.maxFiles);
      }
      const keep = new Set(sources);
      for (const k of [...this.cache.keys()]) if (!keep.has(k)) this.cache.delete(k);
      this.files = sources;
      this.needsListing = false;
      // On a full refresh, re-validate every cached entry against the file system.
      if (options.full) for (const f of sources) this.dirty.add(f);
      else for (const f of sources) if (!this.cache.has(f)) this.dirty.add(f);
    }
    const files = this.files;
    const allFiles = new Set(files);
    const enabled = this.options.frameworks;
    const wantsJs = enabled.has('express') || enabled.has('nestjs');
    const wantsJava = enabled.has('spring');

    let analyzed = 0;
    let fromCache = 0;
    let skipped = 0;
    const relevant = files.filter((f) => {
      const k = kindOf(f);
      return (k === 'js' && wantsJs) || ((k === 'java' || k === 'config' || k === 'kotlin') && wantsJava);
    });
    for (let i = 0; i < relevant.length; i += BATCH) {
      throwIfCancelled(token);
      const batch = relevant.slice(i, i + BATCH);
      const results = await Promise.all(batch.map((f) => this.ensure(f, false)));
      for (const r of results) {
        if (r === 'analyzed') analyzed++;
        else if (r === 'cached') fromCache++;
        else if (r === 'skipped') skipped++;
      }
      await yieldToEventLoop();
    }

    // Link, analysing on demand any files the linkers needed but the pre-filter skipped.
    let endpoints: Endpoint[] = [];
    let ctx: LinkContext | undefined;
    for (let round = 0; round < MAX_LINK_ROUNDS; round++) {
      throwIfCancelled(token);
      const factMap = new Map<string, FileFacts>();
      for (const f of relevant) {
        const e = this.cache.get(f);
        if (e?.facts) factMap.set(f, e.facts);
      }
      ctx = new LinkContext(factMap, allFiles, (f) => this.projectRootOf(f), {
        springApplyContextPath: this.options.springApplyContextPath,
      });
      endpoints = [];
      if (enabled.has('express')) endpoints.push(...new ExpressLinker(ctx).link());
      if (enabled.has('nestjs')) endpoints.push(...new NestLinker(ctx).link());
      if (enabled.has('spring')) endpoints.push(...new SpringLinker(ctx).link());
      const requested = [...ctx.requested].filter((f) => !this.cache.get(f)?.facts);
      if (requested.length === 0) break;
      this.logger.debug(`Link round ${round + 1}: analysing ${requested.length} referenced file(s) skipped by the pre-filter.`);
      for (let i = 0; i < requested.length; i += BATCH) {
        throwIfCancelled(token);
        const results = await Promise.all(requested.slice(i, i + BATCH).map((f) => this.ensure(f, true)));
        analyzed += results.filter((r) => r === 'analyzed').length;
        await yieldToEventLoop();
      }
    }

    // File-level issues.
    let kotlinControllers = 0;
    let firstKotlin: string | undefined;
    for (const f of relevant) {
      const facts = this.cache.get(f)?.facts;
      if (!facts) continue;
      if (facts.lang === 'none' && f.endsWith('.kt')) {
        kotlinControllers++;
        firstKotlin ??= f;
        continue;
      }
      for (const i of facts.issues) {
        issues.push({ kind: i.kind, severity: i.severity, message: i.message, location: loc(f, i.pos) });
      }
    }
    if (kotlinControllers > 0) {
      issues.push({
        kind: 'limitation',
        severity: 'warning',
        message: `${kotlinControllers} Kotlin file(s) contain Spring web annotations. Kotlin is not supported; their endpoints are not shown.`,
        location: firstKotlin ? loc(firstKotlin) : undefined,
      });
    }
    if (ctx) issues.push(...ctx.issues);
    const dup = findDuplicates(endpoints);
    issues.push(...dup.issues);
    endpoints.sort(compareEndpoints);
    const durationMs = Date.now() - started;
    this.logger.info(`Analysis finished in ${durationMs} ms: ${endpoints.length} endpoint(s), ${analyzed} file(s) parsed, ${fromCache} from cache.`);
    return {
      endpoints,
      issues: dedupeIssues(issues),
      duplicates: dup.groups,
      stats: { filesDiscovered: files.length, filesAnalyzed: analyzed, filesFromCache: fromCache, filesSkipped: skipped, durationMs, truncated },
    };
  }

  /** Ensures facts for a file are current. `force` bypasses the textual pre-filter. */
  private async ensure(file: string, force: boolean): Promise<'analyzed' | 'cached' | 'skipped' | 'prefiltered'> {
    const cached = this.cache.get(file);
    if (cached && !this.dirty.has(file) && (!force || cached.facts)) return 'cached';
    let stat: FileStat | undefined;
    try {
      stat = await this.host.stat(file);
    } catch {
      stat = undefined;
    }
    this.dirty.delete(file);
    if (!stat) {
      this.cache.delete(file);
      return 'skipped';
    }
    if (cached && cached.mtime === stat.mtime && cached.size === stat.size && (!force || cached.facts)) return 'cached';
    if (stat.size > this.options.maxFileSizeBytes) {
      this.cache.set(file, {
        mtime: stat.mtime,
        size: stat.size,
        facts: {
          lang: 'none',
          issues: [{ kind: 'limitation', severity: 'info', message: `Skipped: file is larger than ${Math.round(this.options.maxFileSizeBytes / 1024)} KB (setting apiShadow.maxFileSizeKB).` }],
        },
      });
      return 'skipped';
    }
    let source: string;
    try {
      source = await this.host.readFile(file);
    } catch (err) {
      this.logger.warn(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
      this.cache.delete(file);
      return 'skipped';
    }
    const facts = this.analyzeSource(file, source, force);
    this.cache.set(file, { mtime: stat.mtime, size: stat.size, facts });
    return facts ? 'analyzed' : 'prefiltered';
  }

  private analyzeSource(file: string, source: string, force: boolean): FileFacts | undefined {
    const kind = kindOf(file);
    try {
      switch (kind) {
        case 'js':
          return force || isJsCandidate(source) ? analyzeJs(source, file) : undefined;
        case 'java':
          return force || isJavaCandidate(source) ? analyzeJava(source, file) : undefined;
        case 'config':
          return analyzeSpringConfig(source, file);
        case 'kotlin':
          return /@(RestController|Controller|(Get|Post|Put|Patch|Delete|Request)Mapping)\b/.test(source) ? { lang: 'none', issues: [] } : undefined;
        default:
          return undefined;
      }
    } catch (err) {
      // Analyzer bugs must never break the whole analysis.
      this.logger.error(`Analyzer failed on ${file}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      return { lang: 'none', issues: [{ kind: 'parse-error', severity: 'error', message: 'Internal analyzer error; see the API Shadow log.' }] };
    }
  }

  projectRootOf(file: string): string {
    let dir = path.dirname(file);
    const visited: string[] = [];
    for (;;) {
      const cached = this.rootCache.get(dir);
      if (cached !== undefined) {
        for (const v of visited) this.rootCache.set(v, cached);
        return cached;
      }
      visited.push(dir);
      if (this.projectRoots.has(dir)) {
        for (const v of visited) this.rootCache.set(v, dir);
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    const fallback = this.options.workspaceRoots.filter((r) => file.startsWith(r)).sort((a, b) => b.length - a.length)[0] ?? path.dirname(file);
    for (const v of visited) this.rootCache.set(v, fallback);
    return fallback;
  }
}

function dedupeIssues(issues: AnalysisIssue[]): AnalysisIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = `${i.kind}|${i.message}|${i.location?.file}|${i.location?.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
