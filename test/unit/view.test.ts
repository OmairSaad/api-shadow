import { describe, expect, it } from 'vitest';
import { findDuplicates } from '../../src/core/duplicates';
import type { Endpoint, HttpMethod } from '../../src/core/types';
import { groupEndpoints, isFilterActive, matchesFilter } from '../../src/core/view';

function ep(method: HttpMethod, path: string, extra: Partial<Endpoint> = {}): Endpoint {
  return {
    id: `${method} ${path} ${extra.location?.line ?? 1} ${extra.projectRoot ?? '/p'}`,
    framework: 'express',
    method,
    path,
    pathIsStatic: true,
    location: { file: '/p/src/routes/users.js', line: 1, column: 1 },
    middleware: [],
    services: [],
    parameters: [],
    notes: [],
    projectRoot: '/p',
    ...extra,
  };
}

describe('matchesFilter', () => {
  const e = ep('GET', '/api/users/:id', { controller: 'UsersController', handler: 'findOne', middleware: ['auth'], services: [{ name: 'UsersService.findOne' }] });
  it('matches all terms across fields case-insensitively', () => {
    expect(matchesFilter(e, { text: 'users get', methods: new Set() })).toBe(true);
    expect(matchesFilter(e, { text: 'AUTH usersservice', methods: new Set() })).toBe(true);
    expect(matchesFilter(e, { text: 'users.js', methods: new Set() })).toBe(true);
    expect(matchesFilter(e, { text: 'orders', methods: new Set() })).toBe(false);
  });
  it('filters by method', () => {
    expect(matchesFilter(e, { text: '', methods: new Set(['POST']) })).toBe(false);
    expect(matchesFilter(e, { text: '', methods: new Set(['GET', 'POST']) })).toBe(true);
  });
  it('knows when a filter is active', () => {
    expect(isFilterActive({ text: '  ', methods: new Set() })).toBe(false);
    expect(isFilterActive({ text: '', methods: new Set(['GET']) })).toBe(true);
  });
});

describe('groupEndpoints', () => {
  const list = [ep('POST', '/a', { controller: 'B' }), ep('GET', '/b/x', { controller: 'A' }), ep('DELETE', '/b', { controller: 'A', framework: 'spring' })];
  it('groups by controller (per framework) sorted by label', () => {
    expect(groupEndpoints(list, 'controller', (f) => f).map((g) => [g.label, g.endpoints.length])).toEqual([
      ['A', 1],
      ['A', 1],
      ['B', 1],
    ]);
  });
  it('groups by method in HTTP order', () => {
    expect(groupEndpoints(list, 'method', (f) => f).map((g) => g.label)).toEqual(['GET', 'POST', 'DELETE']);
  });
  it('groups by first path segment and flat', () => {
    expect(groupEndpoints(list, 'path', (f) => f).map((g) => g.label)).toEqual(['/a', '/b']);
    expect(groupEndpoints(list, 'none', (f) => f)).toHaveLength(1);
  });
});

describe('findDuplicates', () => {
  it('detects equal routes regardless of parameter names', () => {
    const { groups, issues } = findDuplicates([ep('GET', '/u/:id', { location: { file: '/p/a.js', line: 1, column: 1 } }), ep('GET', '/u/:userId', { location: { file: '/p/a.js', line: 9, column: 1 } })]);
    expect(groups).toHaveLength(1);
    expect(issues[0].message).toMatch(/GET \/u\/\{\} declared 2 times/);
  });
  it('compares ALL only with ALL', () => {
    expect(findDuplicates([ep('ALL', '/x'), ep('POST', '/x', { location: { file: '/p/b.js', line: 2, column: 1 } })]).groups).toEqual([]);
    expect(findDuplicates([ep('ALL', '/x'), ep('ALL', '/x', { location: { file: '/p/b.js', line: 2, column: 1 } })]).groups).toHaveLength(1);
  });
  it('ignores different methods, projects and frameworks', () => {
    expect(findDuplicates([ep('GET', '/x'), ep('POST', '/x', { location: { file: '/p/b.js', line: 2, column: 1 } })]).groups).toEqual([]);
    expect(findDuplicates([ep('GET', '/x'), ep('GET', '/x', { projectRoot: '/q' })]).groups).toEqual([]);
    expect(findDuplicates([ep('GET', '/x'), ep('GET', '/x', { framework: 'spring', id: 'other' })]).groups).toEqual([]);
  });
});
