import * as path from 'path';
import type { FileFacts, Pos } from '../analyzers/facts';
import type { AnalysisIssue, Endpoint, SourceLocation } from '../core/types';

export interface LinkOptions {
  springApplyContextPath: boolean;
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

  getFacts(file: string): FileFacts | undefined {
    const f = this.facts.get(file);
    if (!f && this.allFiles.has(file)) this.requested.add(file);
    return f;
  }

  files(): IterableIterator<[string, FileFacts]> {
    return this.facts.entries();
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
