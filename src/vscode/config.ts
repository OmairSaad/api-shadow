import * as vscode from 'vscode';
import { AUTH_WARNING_VALUES, DEFAULT_AUTH_PATTERNS, DEFAULT_PUBLIC_PATTERNS, type AuthOptions, type AuthWarnings } from '../core/auth';
import type { GroupBy } from '../core/view';
import { GROUP_BY_VALUES } from '../core/view';
import { FRAMEWORKS, type Framework } from '../core/types';
import { gitignoreToGlobs } from '../core/exclude';
import { SECURITY_RULES, type Severity } from '../core/security';

export type ImpactBaseline = 'gitHead' | 'session';
export type DiagnosticLevel = Exclude<Severity, 'info'> | 'off';

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
  testCoverage: boolean;
  clientCalls: boolean;
  reportUncalled: boolean;
  validation: boolean;
  unreachable: boolean;
  unreachableDiagnostics: boolean;
  brokenCallDiagnostics: boolean;
  respectGitignore: boolean;
  impact: { enabled: boolean; baseline: ImpactBaseline; diagnostics: boolean };
  responseChecks: boolean;
  responseMismatchDiagnostics: boolean;
  security: { enabled: boolean; disabledRules: string[]; exclude: string[]; diagnostics: DiagnosticLevel };
  contractFiles: string[];
  graphMaxEndpoints: number;
  testDirectory: string;
}

const ALL_FRAMEWORKS: Framework[] = [...FRAMEWORKS];

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
    testCoverage: c.get<boolean>('tests.enabled', true),
    clientCalls: c.get<boolean>('clientCalls.enabled', true),
    reportUncalled: c.get<boolean>('clientCalls.reportUncalled', false),
    validation: c.get<boolean>('validation.enabled', true),
    unreachable: c.get<boolean>('unreachable.enabled', true),
    unreachableDiagnostics: c.get<boolean>('diagnostics.unreachable', true),
    brokenCallDiagnostics: c.get<boolean>('diagnostics.brokenCalls', true),
    respectGitignore: c.get<boolean>('respectGitignore', true),
    impact: {
      enabled: c.get<boolean>('impact.enabled', true),
      baseline: c.get<string>('impact.baseline', 'gitHead') === 'session' ? 'session' : 'gitHead',
      diagnostics: c.get<boolean>('diagnostics.impact', true),
    },
    responseChecks: c.get<boolean>('responseChecks.enabled', true),
    responseMismatchDiagnostics: c.get<boolean>('diagnostics.responseMismatch', true),
    security: {
      enabled: c.get<boolean>('security.enabled', true),
      disabledRules: stringList(c.get<unknown>('security.disabledRules'), []).filter((r) => r in SECURITY_RULES),
      exclude: stringList(c.get<unknown>('security.exclude'), []),
      diagnostics: diagnosticLevel(c.get<string>('diagnostics.security', 'high')),
    },
    contractFiles: stringList(c.get<unknown>('contracts.files'), []),
    graphMaxEndpoints: clamp(c.get<number>('graph.maxEndpoints', 150), 10, 5000),
    testDirectory: c.get<string>('testGeneration.directory', '').trim(),
  };
}

function diagnosticLevel(v: string | undefined): DiagnosticLevel {
  return v === 'high' || v === 'medium' || v === 'low' || v === 'off' ? v : 'high';
}

function stringList(value: unknown, fallback: readonly string[]): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [...fallback];
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : min;
}

/**
 * Globs from the `.gitignore` at the root of each workspace folder. Negations (`!pattern`) cannot
 * be expressed as exclusions and are skipped; nested `.gitignore` files are not read.
 */
export async function gitignoreGlobs(): Promise<string[]> {
  const out: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    let text: string;
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, '.gitignore')));
    } catch {
      continue;
    }
    out.push(...gitignoreToGlobs(text));
  }
  return [...new Set(out)];
}

/** Glob patterns from `files.exclude` that are enabled (simple boolean form only). */
export function filesExcludeGlobs(): string[] {
  const value = vscode.workspace.getConfiguration('files').get<Record<string, unknown>>('exclude', {});
  return Object.entries(value)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
}
