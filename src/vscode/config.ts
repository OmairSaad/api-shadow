import * as vscode from 'vscode';
import { AUTH_WARNING_VALUES, DEFAULT_AUTH_PATTERNS, DEFAULT_PUBLIC_PATTERNS, type AuthOptions, type AuthWarnings } from '../core/auth';
import type { GroupBy } from '../core/view';
import { GROUP_BY_VALUES } from '../core/view';
import type { Framework } from '../core/types';

export interface ApiShadowConfig {
  frameworks: Set<Framework>;
  exclude: string[];
  includeTestFiles: boolean;
  respectFilesExclude: boolean;
  maxFiles: number;
  maxFileSizeKB: number;
  autoRefresh: boolean;
  refreshDebounceMs: number;
  groupBy: GroupBy;
  duplicateDiagnostics: boolean;
  showStatusBar: boolean;
  springApplyContextPath: boolean;
  persistCache: boolean;
  exportIncludeSourceLocations: boolean;
  auth: AuthOptions;
  codeLens: boolean;
  requestsBaseUrl: string;
}

const ALL_FRAMEWORKS: Framework[] = ['express', 'nestjs', 'spring'];

export function readConfig(): ApiShadowConfig {
  const c = vscode.workspace.getConfiguration('apiShadow');
  const frameworks = c.get<string[]>('frameworks', ALL_FRAMEWORKS).filter((f): f is Framework => (ALL_FRAMEWORKS as string[]).includes(f));
  const groupBy = c.get<string>('groupBy', 'controller');
  const warnings = c.get<string>('auth.warnings', 'sensitive');
  return {
    frameworks: new Set(frameworks),
    exclude: c.get<string[]>('exclude', []),
    includeTestFiles: c.get<boolean>('includeTestFiles', false),
    respectFilesExclude: c.get<boolean>('respectFilesExclude', true),
    maxFiles: clamp(c.get<number>('maxFiles', 20000), 100, 500000),
    maxFileSizeKB: clamp(c.get<number>('maxFileSizeKB', 512), 16, 16384),
    autoRefresh: c.get<boolean>('autoRefresh', true),
    refreshDebounceMs: clamp(c.get<number>('refreshDebounceMs', 800), 100, 60000),
    groupBy: (GROUP_BY_VALUES as string[]).includes(groupBy) ? (groupBy as GroupBy) : 'controller',
    duplicateDiagnostics: c.get<boolean>('diagnostics.duplicates', true),
    showStatusBar: c.get<boolean>('showStatusBar', true),
    springApplyContextPath: c.get<boolean>('spring.applyContextPath', true),
    persistCache: c.get<boolean>('persistCache', true),
    exportIncludeSourceLocations: c.get<boolean>('export.includeSourceLocations', true),
    auth: {
      enabled: c.get<boolean>('auth.enabled', true),
      warnings: (AUTH_WARNING_VALUES as string[]).includes(warnings) ? (warnings as AuthWarnings) : 'sensitive',
      patterns: stringList(c.get<unknown>('auth.patterns'), DEFAULT_AUTH_PATTERNS),
      publicPatterns: stringList(c.get<unknown>('auth.publicPatterns'), DEFAULT_PUBLIC_PATTERNS),
    },
    codeLens: c.get<boolean>('codeLens.enabled', true),
    requestsBaseUrl: c.get<string>('requests.baseUrl', ''),
  };
}

function stringList(value: unknown, fallback: readonly string[]): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [...fallback];
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : min;
}

/** Glob patterns from `files.exclude` that are enabled (simple boolean form only). */
export function filesExcludeGlobs(): string[] {
  const value = vscode.workspace.getConfiguration('files').get<Record<string, unknown>>('exclude', {});
  return Object.entries(value)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
}
