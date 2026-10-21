import * as vscode from 'vscode';
import type { FileHost, FileStat } from '../core/engine';
import { CONFIG_GLOB, DEFAULT_EXCLUDED_DIRS, MARKER_GLOB, PathExcluder, SOURCE_GLOB, TSCONFIG_GLOB, defaultExcludeGlobs } from '../core/exclude';
import type { CancellationLike } from '../core/types';
import { filesExcludeGlobs, gitignoreGlobs, type ApiShadowConfig } from './config';

/**
 * Discovers files with `workspace.findFiles` (ripgrep-backed, fast) and reads them through
 * `workspace.fs`. Files are only read, never executed or sent anywhere.
 */
export class VscodeFileHost implements FileHost {
  private excluder: PathExcluder;

  /** Globs from root `.gitignore` files, loaded by {@link loadGitignore}. */
  private gitignore: string[] = [];

  constructor(private config: ApiShadowConfig) {
    this.excluder = this.buildExcluder();
  }

  updateConfig(config: ApiShadowConfig): void {
    this.config = config;
    this.excluder = this.buildExcluder();
  }

  /** Re-reads `.gitignore` files; returns true when the exclusions changed. */
  async loadGitignore(): Promise<boolean> {
    const globs = this.config.respectGitignore ? await gitignoreGlobs() : [];
    if (globs.join('\n') === this.gitignore.join('\n')) return false;
    this.gitignore = globs;
    this.excluder = this.buildExcluder();
    return true;
  }

  private buildExcluder(): PathExcluder {
    const extra = [...this.config.exclude, ...(this.config.respectFilesExclude ? filesExcludeGlobs() : []), ...this.gitignore];
    const tests = this.config.includeTestFiles ? 'include' : this.config.testCoverage ? 'read' : 'exclude';
    return new PathExcluder(defaultExcludeGlobs(tests, extra));
  }

  /** True when a file (by absolute URI) should not be analysed. */
  isExcluded(uri: vscode.Uri): boolean {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return true;
    const rel = vscode.workspace.asRelativePath(uri, false);
    return this.excluder.isExcluded(rel);
  }

  async listFiles(token?: CancellationLike): Promise<string[]> {
    const dirExclude = `**/{${DEFAULT_EXCLUDED_DIRS.join(',')}}/**`;
    const limit = this.config.maxFiles + 2000;
    const cts = new vscode.CancellationTokenSource();
    const poll = setInterval(() => {
      if (token?.isCancellationRequested) cts.cancel();
    }, 100);
    try {
      const [sources, configs, markers, tsconfigs] = await Promise.all([
        vscode.workspace.findFiles(SOURCE_GLOB, dirExclude, limit, cts.token),
        vscode.workspace.findFiles(CONFIG_GLOB, dirExclude, 1000, cts.token),
        vscode.workspace.findFiles(MARKER_GLOB, dirExclude, 5000, cts.token),
        vscode.workspace.findFiles(TSCONFIG_GLOB, dirExclude, 1000, cts.token),
      ]);
      const out: string[] = [];
      for (const uri of [...sources, ...configs, ...tsconfigs]) {
        if (uri.scheme === 'file' && !this.isExcluded(uri)) out.push(uri.fsPath);
      }
      // Project markers are used only to scope prefixes/duplicates; respect exclusion there too.
      for (const uri of markers) {
        if (uri.scheme === 'file' && !this.isExcluded(uri)) out.push(uri.fsPath);
      }
      return out;
    } finally {
      clearInterval(poll);
      cts.dispose();
    }
  }

  async readFile(file: string): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
    return new TextDecoder('utf-8').decode(bytes);
  }

  async stat(file: string): Promise<FileStat | undefined> {
    try {
      const s = await vscode.workspace.fs.stat(vscode.Uri.file(file));
      return { mtime: s.mtime, size: s.size };
    } catch {
      return undefined;
    }
  }
}
