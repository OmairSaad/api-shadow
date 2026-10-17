import * as path from 'path';
import { AnalysisEngine, type EngineOptions, type FileHost } from '../../src/core/engine';
import type { Endpoint } from '../../src/core/types';
import { engineOptions } from './nodeHost';

/** In-memory file host. Paths are absolute under ROOT. */
export class MemoryHost implements FileHost {
  readonly files = new Map<string, { content: string; mtime: number }>();
  readonly reads: string[] = [];
  private clock = 1;

  constructor(files: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(files)) this.write(p, c);
  }

  write(rel: string, content: string): string {
    const abs = path.join(ROOT, rel);
    this.files.set(abs, { content, mtime: this.clock++ });
    return abs;
  }

  delete(rel: string): string {
    const abs = path.join(ROOT, rel);
    this.files.delete(abs);
    return abs;
  }

  async listFiles(): Promise<string[]> {
    return [...this.files.keys()];
  }

  async readFile(file: string): Promise<string> {
    this.reads.push(file);
    const f = this.files.get(file);
    if (!f) throw new Error(`ENOENT ${file}`);
    return f.content;
  }

  async stat(file: string): Promise<{ mtime: number; size: number } | undefined> {
    const f = this.files.get(file);
    return f ? { mtime: f.mtime, size: f.content.length } : undefined;
  }
}

export const ROOT = path.resolve('/virtual/project');

export async function analyzeFiles(files: Record<string, string>, overrides: Partial<EngineOptions> = {}) {
  const host = new MemoryHost({ 'package.json': '{}', ...files });
  const engine = new AnalysisEngine(host, engineOptions(ROOT, overrides));
  const result = await engine.analyze();
  return { host, engine, result };
}

/** `GET /path` strings, sorted, for compact assertions. */
export function routes(endpoints: Endpoint[]): string[] {
  return endpoints.map((e) => `${e.method} ${e.path}`).sort();
}

export function find(endpoints: Endpoint[], method: string, p: string): Endpoint {
  const e = endpoints.find((x) => x.method === method && x.path === p);
  if (!e) throw new Error(`Endpoint ${method} ${p} not found in:\n${routes(endpoints).join('\n')}`);
  return e;
}
