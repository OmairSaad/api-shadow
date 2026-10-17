import { describe, expect, it } from 'vitest';
import { PathExcluder, defaultExcludeGlobs, globToRegExp } from '../../src/core/exclude';

describe('globToRegExp', () => {
  it('supports **, *, ? and braces', () => {
    expect(globToRegExp('**/*.ts').test('src/a/b.ts')).toBe(true);
    expect(globToRegExp('**/*.ts').test('b.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(globToRegExp('**/*.{js,ts}').test('x/y.js')).toBe(true);
    expect(globToRegExp('file?.js').test('file1.js')).toBe(true);
  });
});

describe('PathExcluder', () => {
  const ex = new PathExcluder(defaultExcludeGlobs(false, ['**/legacy/**']));
  it('excludes dependency, build and VCS folders', () => {
    for (const p of ['node_modules/x/index.js', 'a/node_modules/b.js', 'dist/main.js', 'target/classes/A.java', '.git/HEAD', 'build/out.js', 'out/x.js', 'coverage/lcov.js']) {
      expect(ex.isExcluded(p), p).toBe(true);
    }
  });
  it('excludes tests, declarations and user globs', () => {
    expect(ex.isExcluded('src/app.spec.ts')).toBe(true);
    expect(ex.isExcluded('src/types.d.ts')).toBe(true);
    expect(ex.isExcluded('src/test/java/A.java')).toBe(true);
    expect(ex.isExcluded('src/legacy/routes.js')).toBe(true);
  });
  it('keeps regular sources', () => {
    expect(ex.isExcluded('src/routes/users.js')).toBe(false);
    expect(ex.isExcluded('src/main/java/com/x/UserController.java')).toBe(false);
    expect(ex.isExcluded('src\\routes\\users.js')).toBe(false);
  });
  it('can include tests', () => {
    expect(new PathExcluder(defaultExcludeGlobs(true, [])).isExcluded('src/app.spec.ts')).toBe(false);
  });
});
