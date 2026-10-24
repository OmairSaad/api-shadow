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
  // Composer dependencies (the Laravel framework itself registers routes).
  'vendor',
];

export const SOURCE_GLOB = '**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx,java,kt,php}';
export const CONFIG_GLOB = '**/application.{properties,yml,yaml}';
export const MARKER_GLOB = '**/{package.json,pom.xml,build.gradle,build.gradle.kts,composer.json}';
/** TypeScript/JavaScript project configs, read for module path aliases (`@/…`). */
export const TSCONFIG_GLOB = '**/{tsconfig,jsconfig}.json';

/** Test sources: read for test coverage, but their routes are not endpoints (unless asked). */
const TEST_SOURCE_PATTERNS = ['**/*.{spec,test}.{js,cjs,mjs,jsx,ts,cts,mts,tsx}', '**/*.e2e-spec.{js,ts}', '**/__tests__/**', '**/src/test/**', '**/test/**/*.{js,cjs,mjs,ts,cts,mts}', '**/tests/**/*.{js,cjs,mjs,ts,cts,mts}'];
const FIXTURE_PATTERNS = ['**/test/fixtures/**', '**/__fixtures__/**'];

/**
 * @param tests `exclude`: skip test files entirely; `read`: list them (for test coverage) but keep
 *   fixtures out; `include`: treat them like any other source.
 */
export function defaultExcludeGlobs(tests: 'exclude' | 'read' | 'include', extra: string[]): string[] {
  const globs = [`**/{${DEFAULT_EXCLUDED_DIRS.join(',')}}/**`, '**/*.d.ts', '**/*.min.js', '**/*.bundle.js'];
  if (tests === 'exclude') globs.push(...TEST_SOURCE_PATTERNS, ...FIXTURE_PATTERNS);
  if (tests === 'read') globs.push(...FIXTURE_PATTERNS);
  return [...globs, ...extra.filter((g) => g.trim().length > 0)];
}

const TEST_SOURCE_RES = TEST_SOURCE_PATTERNS.map((g) => globToRegExp(g));

/** True for test sources (by path, `/`- or `\\`-separated, absolute or relative). */
export function isTestPath(file: string): boolean {
  const p = file.replace(/\\/g, '/');
  return TEST_SOURCE_RES.some((re) => re.test(p));
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

/** Converts `.gitignore` lines to exclusion globs. Negations are skipped (see `apiShadow.respectGitignore`). */
export function gitignoreToGlobs(text: string): string[] {
  const out: string[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  // Allow-list files (`*` then `!src/`) cannot be expressed without negation: skip their catch-alls.
  const allowList = lines.some((l) => l.startsWith('!'));
  for (const line of lines) {
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    if (allowList && /^\/?\*+(\.\*)?\/?$/.test(line)) continue;
    let p = line.replace(/\\([#!])/g, '$1');
    const dirOnly = p.endsWith('/');
    p = p.replace(/\/+$/, '');
    if (!p) continue;
    const anchored = p.startsWith('/') || p.slice(0, -1).includes('/');
    p = p.replace(/^\//, '');
    const base = anchored ? p : `**/${p}`;
    out.push(`${base}/**`);
    if (!dirOnly) out.push(base);
  }
  return out;
}
