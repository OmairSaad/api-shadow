import * as fs from 'fs';
import * as path from 'path';
import { AnalysisEngine, type EngineOptions, type FileHost } from '../../src/core/engine';
import { CONFIG_GLOB, MARKER_GLOB, PathExcluder, SOURCE_GLOB, TSCONFIG_GLOB, defaultExcludeGlobs, globToRegExp } from '../../src/core/exclude';
import { FRAMEWORKS, type Framework } from '../../src/core/types';

/** File host backed by the real file system; mirrors what the VS Code host does with findFiles. */
export class NodeFileHost implements FileHost {
  readonly reads: string[] = [];
  private readonly excluder: PathExcluder;
  private readonly includes = [SOURCE_GLOB, CONFIG_GLOB, MARKER_GLOB, TSCONFIG_GLOB].map(globToRegExp);

  constructor(
    private readonly root: string,
    options: { includeTests?: boolean; exclude?: string[] } = {},
  ) {
    this.excluder = new PathExcluder(defaultExcludeGlobs(options.includeTests ? 'include' : 'read', options.exclude ?? []));
  }

  async listFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(this.root, full).split(path.sep).join('/');
        if (entry.isDirectory()) {
          if (!this.excluder.isExcluded(rel + '/x')) walk(full);
        } else if (this.includes.some((re) => re.test(rel)) && !this.excluder.isExcluded(rel)) {
          out.push(full);
        }
      }
    };
    walk(this.root);
    return out;
  }

  async readFile(file: string): Promise<string> {
    this.reads.push(file);
    return fs.promises.readFile(file, 'utf8');
  }

  async stat(file: string): Promise<{ mtime: number; size: number } | undefined> {
    try {
      const s = await fs.promises.stat(file);
      return { mtime: s.mtimeMs, size: s.size };
    } catch {
      return undefined;
    }
  }
}

export function engineOptions(root: string, overrides: Partial<EngineOptions> = {}): EngineOptions {
  return {
    frameworks: new Set<Framework>(FRAMEWORKS),
    maxFiles: 20000,
    maxFileSizeBytes: 512 * 1024,
    springApplyContextPath: true,
    workspaceRoots: [root],
    ...overrides,
  };
}

export const FIXTURES = path.resolve(__dirname, '../fixtures');

export async function analyzeFixture(name: string, overrides: Partial<EngineOptions> = {}) {
  const root = path.join(FIXTURES, name);
  const host = new NodeFileHost(root);
  const engine = new AnalysisEngine(host, engineOptions(root, overrides));
  const result = await engine.analyze();
  return { root, host, engine, result };
}
