/**
 * Orchestrates discovery → per-file analysis (cached) → cross-file linking → duplicate detection.
 * Host-agnostic: the VS Code layer supplies a {@link FileHost}; tests use a Node implementation.
 */
import * as path from 'path';
import { analyzeJava, isJavaCandidate } from '../analyzers/javaAnalyzer';
import { analyzeJs, isJsCandidate } from '../analyzers/jsAnalyzer';
import { analyzeSpringConfig, isSpringConfigFile } from '../analyzers/springConfig';
import { analyzeTsConfig, isTsConfigFile } from '../analyzers/tsconfig';
import { analyzePhp, isPhpCandidate } from '../analyzers/phpAnalyzer';
import { FACTS_VERSION, type FileFacts, type JsFileFacts, type RiskFact } from '../analyzers/facts';
import { LinkContext, loc, type PathAliasConfig } from '../linkers/context';
import { ExpressLinker } from '../linkers/expressLinker';
import { NestLinker } from '../linkers/nestLinker';
import { SpringLinker } from '../linkers/springLinker';
import { LaravelLinker } from '../linkers/laravelLinker';
import { applyAuth, DEFAULT_AUTH_OPTIONS, type AuthOptions, type CentralSecurity } from './auth';
import { matchClientCalls, type ClientCallInput, type ClientCallOptions } from './clientCalls';
import { isTestPath } from './exclude';
import { findUnreachable } from './shadowing';
import { applyValidation } from './validation';
import { findDuplicates } from './duplicates';
import { linkConsumers, type ConsumerInput } from './consumers';
import { checkResponseReads } from './impact';
import { analyzeSecurity, type FileRisks, type SecurityOptions } from './security';
import { scanText, type ScanKind } from './textScan';
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
  type ServerInfo,
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
  /** Auth detection; defaults to {@link DEFAULT_AUTH_OPTIONS}. */
  auth?: AuthOptions;
  /** Treat test files like other sources (their routes become endpoints). Default false. */
  includeTestFiles?: boolean;
  /** Frontend and test calls to endpoints. Default: enabled, uncalled endpoints not reported. */
  clientCalls?: ClientCallOptions;
  /** Request body validation detection. Default true. */
  validation?: boolean;
  /** Unreachable route detection. Default true. */
  unreachable?: boolean;
  /** Security Radar. Default: enabled, all rules. */
  security?: SecurityOptions;
  /** Report client reads of fields an endpoint does not return. Default true. */
  responseChecks?: boolean;
}

interface CacheEntry {
  mtime: number;
  size: number;
  /** Undefined when the textual pre-filter decided the file is irrelevant. */
  facts?: FileFacts;
  /** Hardcoded credentials and similar findings from the text scan (redacted). */
  text?: RiskFact[];
}

export interface SerializedCache {
  version: number;
  entries: Record<string, CacheEntry>;
}

const MARKERS = new Set(['package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json']);
const JS_EXT = /\.(js|cjs|mjs|jsx|ts|cts|mts|tsx)$/i;
const BATCH = 32;
const MAX_LINK_ROUNDS = 4;

type Kind = 'js' | 'java' | 'config' | 'tsconfig' | 'kotlin' | 'php' | 'marker' | 'other';

function kindOf(file: string): Kind {
  const base = path.basename(file);
  if (MARKERS.has(base)) return 'marker';
  if (isSpringConfigFile(file)) return 'config';
  if (isTsConfigFile(file)) return 'tsconfig';
  if (JS_EXT.test(file) && !file.endsWith('.d.ts')) return 'js';
  if (file.endsWith('.java')) return 'java';
  if (file.endsWith('.kt')) return 'kotlin';
  if (file.endsWith('.php') && !file.endsWith('.blade.php')) return 'php';
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
    const clientCalls = this.options.clientCalls ?? { enabled: true, reportUncalled: false };
    const jsFrameworks = enabled.has('express') || enabled.has('fastify') || enabled.has('koa') || enabled.has('nestjs');
    // Frontend code may call a Spring API, so JS is read for client calls even without JS frameworks.
    const wantsJs = jsFrameworks || clientCalls.enabled;
    const wantsJava = enabled.has('spring');
    const wantsPhp = enabled.has('laravel');
    const isTest = (f: string): boolean => !this.options.includeTestFiles && this.isTestFile(f);

    let analyzed = 0;
    let fromCache = 0;
    let skipped = 0;
    const relevant = files.filter((f) => {
      const k = kindOf(f);
      return ((k === 'js' || k === 'tsconfig') && wantsJs) || ((k === 'java' || k === 'config' || k === 'kotlin') && wantsJava) || (k === 'php' && wantsPhp);
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

    // Module path aliases (`@/services/user`) from tsconfig/jsconfig files.
    const pathAliases: PathAliasConfig[] = [];
    for (const f of relevant) {
      const facts = this.cache.get(f)?.facts;
      if (facts?.lang !== 'tsconfig') continue;
      const dir = path.dirname(f);
      const baseUrl = facts.baseUrl !== undefined ? path.resolve(dir, facts.baseUrl) : undefined;
      pathAliases.push({ dir, baseUrl, paths: Object.entries(facts.paths).map(([pattern, targets]) => ({ pattern, targets })) });
    }

    // Link, analysing on demand any files the linkers needed but the pre-filter skipped.
    let endpoints: Endpoint[] = [];
    let ctx: LinkContext | undefined;
    for (let round = 0; round < MAX_LINK_ROUNDS; round++) {
      throwIfCancelled(token);
      const factMap = new Map<string, FileFacts>();
      for (const f of relevant) {
        const e = this.cache.get(f);
        // Test files only contribute calls; routes of test apps are not endpoints.
        if (e?.facts && !isTest(f)) factMap.set(f, e.facts);
      }
      ctx = new LinkContext(factMap, allFiles, (f) => this.projectRootOf(f), {
        springApplyContextPath: this.options.springApplyContextPath,
        pathAliases,
      });
      endpoints = [];
      if (enabled.has('express') || enabled.has('fastify') || enabled.has('koa')) endpoints.push(...new ExpressLinker(ctx).link().filter((e) => enabled.has(e.framework)));
      if (enabled.has('nestjs')) endpoints.push(...new NestLinker(ctx).link());
      if (enabled.has('spring')) endpoints.push(...new SpringLinker(ctx).link());
      if (wantsPhp) endpoints.push(...new LaravelLinker(ctx).link());
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

    // File-level issues, project-wide security configuration and listening ports.
    let kotlinControllers = 0;
    let firstKotlin: string | undefined;
    const centralSecurity = new Map<string, CentralSecurity>();
    const servers = new Map<string, ServerInfo>();
    const callInputs: ClientCallInput[] = [];
    for (const f of relevant) {
      const facts = this.cache.get(f)?.facts;
      if (!facts) continue;
      if (facts.lang === 'js' || facts.lang === 'java' || facts.lang === 'php') {
        for (const fact of facts.clientCalls ?? []) {
          const test = this.isTestFile(f) || fact.client === 'supertest' || fact.client === 'MockMvc' || fact.client === 'WebTestClient' || fact.client === 'TestRestTemplate' || fact.client === 'Laravel test';
          callInputs.push({ file: f, fact, kind: test ? 'test' : 'app' });
        }
      }
      if (isTest(f)) continue;
      const root = this.projectRootOf(f);
      if (facts.lang === 'java' && facts.securityConfig && !centralSecurity.has(root)) {
        centralSecurity.set(root, { name: facts.securityConfig.className, location: loc(f, facts.securityConfig.pos) });
      }
      const port = facts.lang === 'js' ? facts.listenPort : facts.lang === 'spring-config' && facts.serverPort ? { port: facts.serverPort, pos: undefined } : undefined;
      // `.properties` wins over YAML, as for the context path.
      if (port && (!servers.has(root) || f.endsWith('.properties'))) servers.set(root, { projectRoot: root, port: port.port, location: loc(f, port.pos) });
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
    const dup = findDuplicates(endpoints, ctx?.registrations);
    issues.push(...dup.issues);
    issues.push(...applyAuth(endpoints, this.options.auth ?? DEFAULT_AUTH_OPTIONS, centralSecurity));
    if (this.options.unreachable !== false && ctx) issues.push(...findUnreachable(endpoints, ctx.registrations));
    issues.push(...applyValidation(endpoints, this.options.validation !== false));
    for (const e of endpoints) e.confidence = !e.pathIsStatic ? 'low' : e.relativeTo ? 'medium' : 'high';
    const calls = matchClientCalls(callInputs, endpoints, clientCalls);
    issues.push(...calls.issues);
    if (clientCalls.enabled) {
      // Reads are followed through every JS file, tests included, so service functions resolve.
      const jsFacts = new Map<string, JsFileFacts>();
      for (const f of relevant) {
        const facts = this.cache.get(f)?.facts;
        if (facts?.lang === 'js') jsFacts.set(f, facts);
      }
      const resolver = new ExpressLinker(new LinkContext(jsFacts, allFiles, (f) => this.projectRootOf(f), { springApplyContextPath: this.options.springApplyContextPath, pathAliases }));
      linkConsumers(callInputs as ConsumerInput[], calls.calls, jsFacts, resolver);
      if (this.options.responseChecks !== false) issues.push(...checkResponseReads(endpoints, calls.calls));
    }
    const fileRisks: FileRisks[] = [];
    for (const f of relevant) {
      const entry = this.cache.get(f);
      const facts = entry?.facts;
      const risks = [...(entry?.text ?? []), ...(facts && 'risks' in facts && Array.isArray(facts.risks) ? facts.risks : [])];
      if (risks.length) fileRisks.push({ file: f, risks, test: this.isTestFile(f) });
    }
    const security = analyzeSecurity(endpoints, issues, fileRisks, this.options.security ?? { enabled: true, disabledRules: [] });
    endpoints.sort(compareEndpoints);
    const durationMs = Date.now() - started;
    this.logger.info(`Analysis finished in ${durationMs} ms: ${endpoints.length} endpoint(s), ${analyzed} file(s) parsed, ${fromCache} from cache.`);
    return {
      endpoints,
      issues: dedupeIssues(issues),
      duplicates: dup.groups,
      servers: [...servers.values()].sort((a, b) => a.projectRoot.localeCompare(b.projectRoot)),
      clientCalls: calls.calls,
      security,
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
    const kind = kindOf(file);
    const scanKind: ScanKind | undefined = kind === 'js' ? 'js' : kind === 'java' ? 'java' : kind === 'config' ? 'config' : kind === 'php' ? 'php' : undefined;
    const text = scanKind ? scanText(source, scanKind) : [];
    this.cache.set(file, text.length ? { mtime: stat.mtime, size: stat.size, facts, text } : { mtime: stat.mtime, size: stat.size, facts });
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
        case 'tsconfig':
          return analyzeTsConfig(source);
        case 'php':
          return force || isPhpCandidate(source) ? analyzePhp(source, file) : undefined;
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

  /**
   * Modules that export an app or router created with `express()`, `fastify()` or `new Koa()`,
   * for generated tests. `listens` is true when the module also calls `listen()` on import.
   */
  appModules(): { file: string; exportName: string; lib: 'express' | 'fastify' | 'koa'; listens: boolean }[] {
    const out: { file: string; exportName: string; lib: 'express' | 'fastify' | 'koa'; listens: boolean }[] = [];
    for (const [file, entry] of this.cache) {
      const facts = entry.facts;
      if (facts?.lang !== 'js' || this.isTestFile(file)) continue;
      for (const r of facts.routers) {
        if (r.kind !== 'app') continue;
        const exported = Object.entries(facts.exports).find(([, ref]) => ref.k === 'node' && ref.key === r.key);
        if (exported) out.push({ file, exportName: exported[0], lib: r.lib ?? 'express', listens: !!facts.listenPort });
      }
    }
    // Modules that do not start a server on import are easier to test.
    return out.sort((a, b) => Number(a.listens) - Number(b.listens) || a.file.length - b.file.length);
  }

  /** Package and fields of a Java class, for generated MockMvc tests. */
  javaClass(file: string, name: string): { packageName: string; fields: Record<string, string> } | undefined {
    const facts = this.cache.get(file)?.facts;
    if (facts?.lang !== 'java') return undefined;
    const cls = facts.classes.find((c) => c.name === name);
    return cls ? { packageName: facts.packageName, fields: { ...cls.fields } } : undefined;
  }

  /** Whether any analysed Java file configures Spring Security under a project root. */
  hasSpringSecurity(root: string): boolean {
    for (const [file, entry] of this.cache) {
      if (entry.facts?.lang === 'java' && entry.facts.securityConfig && file.startsWith(root)) return true;
    }
    return false;
  }

  /** Test files by their path inside the workspace folder (so a folder named `test` above it doesn't count). */
  private isTestFile(file: string): boolean {
    const root = this.options.workspaceRoots.filter((r) => file.startsWith(r)).sort((a, b) => b.length - a.length)[0];
    return isTestPath(root ? path.relative(root, file) : file);
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
