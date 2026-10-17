/** Filtering and grouping used by the sidebar and the search command. Pure functions. */
import * as path from 'path';
import type { Endpoint, HttpMethod } from './types';

export type GroupBy = 'controller' | 'file' | 'method' | 'framework' | 'path' | 'none';
export const GROUP_BY_VALUES: readonly GroupBy[] = ['controller', 'file', 'method', 'framework', 'path', 'none'];

export interface EndpointFilter {
  text: string;
  methods: ReadonlySet<HttpMethod>;
}

export const EMPTY_FILTER: EndpointFilter = { text: '', methods: new Set() };

export function isFilterActive(filter: EndpointFilter): boolean {
  return filter.text.trim().length > 0 || filter.methods.size > 0;
}

/**
 * Text filter: whitespace-separated terms, all of which must match (case-insensitive) one of
 * method, path, controller, handler, framework, middleware, services, the file name or the
 * auth status as `auth:protected`, `auth:public`, `auth:central` or `auth:none`.
 */
export function matchesFilter(e: Endpoint, filter: EndpointFilter): boolean {
  if (filter.methods.size > 0 && !filter.methods.has(e.method)) return false;
  const terms = filter.text.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [
    e.method,
    e.path,
    e.controller ?? '',
    e.handler ?? '',
    e.framework,
    path.basename(e.location.file),
    ...e.middleware,
    ...e.services.map((s) => s.name),
    e.auth ? `auth:${e.auth.status}` : '',
  ]
    .join('\n')
    .toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

export interface EndpointGroup {
  key: string;
  label: string;
  description?: string;
  endpoints: Endpoint[];
}

const METHOD_ORDER: Record<string, number> = { GET: 0, POST: 1, PUT: 2, PATCH: 3, DELETE: 4, OPTIONS: 5, HEAD: 6, ALL: 7 };

export function groupEndpoints(endpoints: Endpoint[], groupBy: GroupBy, relativePath: (file: string) => string): EndpointGroup[] {
  if (groupBy === 'none') return [{ key: 'all', label: 'All endpoints', endpoints }];
  const groups = new Map<string, EndpointGroup>();
  for (const e of endpoints) {
    let key: string;
    let label: string;
    let description: string | undefined;
    switch (groupBy) {
      case 'controller':
        label = e.controller ?? path.basename(e.location.file);
        description = e.framework;
        key = `${e.framework}:${label}`;
        break;
      case 'file':
        label = relativePath(e.location.file);
        key = e.location.file;
        break;
      case 'method':
        label = e.method;
        key = e.method;
        break;
      case 'framework':
        label = e.framework;
        key = e.framework;
        break;
      case 'path': {
        const first = e.path.split('/').filter(Boolean)[0];
        label = first ? `/${first}` : '/';
        key = label;
        break;
      }
    }
    let g = groups.get(key);
    if (!g) {
      g = { key, label, description, endpoints: [] };
      groups.set(key, g);
    }
    g.endpoints.push(e);
  }
  const list = [...groups.values()];
  if (groupBy === 'method') list.sort((a, b) => (METHOD_ORDER[a.key] ?? 99) - (METHOD_ORDER[b.key] ?? 99));
  else list.sort((a, b) => a.label.localeCompare(b.label));
  return list;
}
