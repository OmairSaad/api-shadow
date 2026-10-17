/** Directories that never contain first-party route declarations. */
export const DEFAULT_EXCLUDED_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.vscode-test',
  'bower_components',
  'jspm_packages',
  '.gradle',
  '.idea',
  '.mvn',
  '.yarn',
  '.pnpm-store',
  'tmp',
  '.venv',
  'venv',
  '__pycache__',
];

export const SOURCE_GLOB = '**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx,java,kt}';
export const CONFIG_GLOB = '**/application.{properties,yml,yaml}';
export const MARKER_GLOB = '**/{package.json,pom.xml,build.gradle,build.gradle.kts}';

const TEST_PATTERNS = ['**/*.{spec,test}.{js,cjs,mjs,jsx,ts,cts,mts,tsx}', '**/__tests__/**', '**/src/test/**', '**/test/fixtures/**'];

export function defaultExcludeGlobs(includeTests: boolean, extra: string[]): string[] {
  const globs = [`**/{${DEFAULT_EXCLUDED_DIRS.join(',')}}/**`, '**/*.d.ts', '**/*.min.js', '**/*.bundle.js'];
  if (!includeTests) globs.push(...TEST_PATTERNS);
  return [...globs, ...extra.filter((g) => g.trim().length > 0)];
}

/** Converts a VS Code-style glob (`**`, `*`, `?`, `{a,b}`, `[abc]`) to a RegExp matching `/`-separated paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let inGroup = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more directories
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      inGroup++;
      re += '(?:';
    } else if (c === '}' && inGroup > 0) {
      inGroup--;
      re += ')';
    } else if (c === ',' && inGroup > 0) {
      re += '|';
    } else if (c === '[') {
      const end = glob.indexOf(']', i);
      if (end > i) {
        re += '[' + glob.slice(i + 1, end).replace(/\\/g, '\\\\') + ']';
        i = end;
      } else {
        re += '\\[';
      }
    } else if ('.+^$()|\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

export class PathExcluder {
  private readonly patterns: RegExp[];
  constructor(globs: string[]) {
    this.patterns = globs.map(globToRegExp);
  }
  /** `relativePath` must be relative to a workspace folder; separators are normalised. */
  isExcluded(relativePath: string): boolean {
    const p = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    return this.patterns.some((re) => re.test(p));
  }
}
