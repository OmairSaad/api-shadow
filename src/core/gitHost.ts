/**
 * A {@link FileHost} over a git revision, so a branch, tag or commit can be analyzed without
 * checking it out. Only `git rev-parse`, `ls-tree`, `cat-file` and `for-each-ref` are run: none
 * of them runs hooks, and `core.fsmonitor` is disabled. The VS Code layer only uses this in
 * trusted workspaces.
 */
import { execFile, spawn } from 'child_process';
import * as path from 'path';
import type { FileHost, FileStat } from './engine';
import { CONFIG_GLOB, MARKER_GLOB, PathExcluder, SOURCE_GLOB, globToRegExp } from './exclude';

const GIT_ARGS = ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off'];
const INCLUDES = [SOURCE_GLOB, CONFIG_GLOB, MARKER_GLOB].map(globToRegExp);

function git(cwd: string, args: string[], maxBuffer = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...GIT_ARGS, ...args], { cwd, maxBuffer, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

export async function gitRepoRoot(cwd: string): Promise<string | undefined> {
  try {
    return path.resolve((await git(cwd, ['rev-parse', '--show-toplevel'])).trim());
  } catch {
    return undefined;
  }
}

/** Branches, remote branches and tags, most recently committed first. */
export async function gitRefs(repoRoot: string): Promise<{ name: string; kind: 'branch' | 'remote' | 'tag' }[]> {
  const out = await git(repoRoot, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags']);
  return out
    .split('\n')
    .filter(Boolean)
    .filter((r) => !r.endsWith('/HEAD'))
    .map((r) => {
      if (r.startsWith('refs/heads/')) return { name: r.slice(11), kind: 'branch' as const };
      if (r.startsWith('refs/remotes/')) return { name: r.slice(13), kind: 'remote' as const };
      return { name: r.slice(10), kind: 'tag' as const };
    });
}

export class GitFileHost implements FileHost {
  private files = new Map<string, { object: string; size: number }>();
  private contents: Map<string, string> | undefined;

  private constructor(
    private readonly repoRoot: string,
    private readonly commit: string,
    private readonly excluder: PathExcluder,
    /** Only files under these absolute folders (the workspace folders) are listed. */
    private readonly roots: string[],
  ) {}

  static async create(repoRoot: string, ref: string, excluder: PathExcluder, roots: string[]): Promise<GitFileHost> {
    if (ref.startsWith('-')) throw new Error(`Invalid revision "${ref}"`);
    const commit = (await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim();
    if (!/^[0-9a-f]{7,64}$/.test(commit)) throw new Error(`"${ref}" is not a commit`);
    return new GitFileHost(repoRoot, commit, excluder, roots);
  }

  async listFiles(): Promise<string[]> {
    const out = await git(this.repoRoot, ['ls-tree', '-r', '-l', '-z', this.commit]);
    this.files = new Map();
    for (const entry of out.split('\0')) {
      // `<mode> <type> <object> <size>\t<path>`
      const m = /^\d+ blob ([0-9a-f]+)\s+(\d+)\t(.+)$/s.exec(entry);
      if (!m) continue;
      const rel = m[3];
      const abs = path.join(this.repoRoot, rel);
      const root = this.roots.find((r) => abs === r || abs.startsWith(r + path.sep));
      if (!root) continue;
      const inFolder = path.relative(root, abs).split(path.sep).join('/');
      if (!INCLUDES.some((re) => re.test(inFolder)) || this.excluder.isExcluded(inFolder)) continue;
      this.files.set(abs, { object: m[1], size: Number(m[2]) });
    }
    this.contents = undefined;
    return [...this.files.keys()];
  }

  async stat(file: string): Promise<FileStat | undefined> {
    const f = this.files.get(file);
    return f ? { mtime: 0, size: f.size } : undefined;
  }

  async readFile(file: string): Promise<string> {
    if (!this.contents) this.contents = await this.readAll();
    const text = this.contents.get(file);
    if (text === undefined) throw new Error(`${file} is not in ${this.commit.slice(0, 8)}`);
    return text;
  }

  /** Reads every listed blob through one `git cat-file --batch` process. */
  private readAll(): Promise<Map<string, string>> {
    // Files this large are skipped by the engine anyway (apiShadow.maxFileSizeKB caps at 16 MB).
    const entries = [...this.files.entries()].filter(([, f]) => f.size <= 16 * 1024 * 1024);
    return new Promise((resolve, reject) => {
      const child = spawn('git', [...GIT_ARGS, 'cat-file', '--batch'], { cwd: this.repoRoot, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      const chunks: Buffer[] = [];
      child.stdout.on('data', (c: Buffer) => chunks.push(c));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`git cat-file exited with ${code}`));
        const buf = Buffer.concat(chunks);
        const out = new Map<string, string>();
        let offset = 0;
        for (const [file] of entries) {
          const nl = buf.indexOf(0x0a, offset);
          if (nl < 0) break;
          const header = buf.subarray(offset, nl).toString();
          const size = Number(/ blob (\d+)$/.exec(header)?.[1] ?? NaN);
          offset = nl + 1;
          if (Number.isNaN(size)) continue; // "missing"
          out.set(file, buf.subarray(offset, offset + size).toString('utf8'));
          offset += size + 1;
        }
        resolve(out);
      });
      child.stdin.end(entries.map(([, f]) => f.object).join('\n') + '\n');
    });
  }
}
