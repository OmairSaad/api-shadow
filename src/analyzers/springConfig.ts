/**
 * Reads only `server.servlet.context-path` and `spring.mvc.servlet.path` from Spring Boot
 * configuration files. No other value is retained, logged or exported: configuration files
 * frequently contain credentials.
 */
import { parse as parseYaml } from 'yaml';
import type { SpringConfigFacts } from './facts';

const CONTEXT_KEYS = ['server.servlet.context-path', 'server.servlet.contextPath', 'server.context-path'];
const SERVLET_KEYS = ['spring.mvc.servlet.path', 'spring.mvc.servlet-path'];

export function isSpringConfigFile(filePath: string): boolean {
  return /(^|[\\/])application\.(properties|ya?ml)$/i.test(filePath);
}

export function analyzeSpringConfig(source: string, filePath: string): SpringConfigFacts {
  const facts: SpringConfigFacts = { lang: 'spring-config', issues: [] };
  const values = filePath.toLowerCase().endsWith('.properties') ? readProperties(source) : readYaml(source, facts);
  facts.contextPath = pick(values, CONTEXT_KEYS);
  facts.servletPath = pick(values, SERVLET_KEYS);
  if (facts.contextPath?.includes('${') || facts.servletPath?.includes('${')) {
    facts.issues.push({
      kind: 'limitation',
      severity: 'info',
      message: 'Context path uses a property placeholder; it is not resolved.',
    });
    if (facts.contextPath?.includes('${')) facts.contextPath = undefined;
    if (facts.servletPath?.includes('${')) facts.servletPath = undefined;
  }
  return facts;
}

function pick(values: Map<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = values.get(key);
    if (v !== undefined && v.trim() !== '') return v.trim();
  }
  return undefined;
}

function readProperties(source: string): Map<string, string> {
  const wanted = new Set([...CONTEXT_KEYS, ...SERVLET_KEYS]);
  const out = new Map<string, string>();
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const m = /^([^=:\s]+)\s*[=:]\s*(.*)$/.exec(line);
    if (m && wanted.has(m[1])) out.set(m[1], m[2]);
  }
  return out;
}

function readYaml(source: string, facts: SpringConfigFacts): Map<string, string> {
  const wanted = new Set([...CONTEXT_KEYS, ...SERVLET_KEYS]);
  const out = new Map<string, string>();
  // Multi-document YAML: only the first (default profile) document is considered.
  const firstDoc = source.split(/^---\s*$/m)[0];
  let doc: unknown;
  try {
    doc = parseYaml(firstDoc);
  } catch {
    facts.issues.push({ kind: 'parse-error', severity: 'warning', message: 'Could not parse YAML configuration.' });
    return out;
  }
  const visit = (value: unknown, prefix: string): void => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        visit(v, prefix ? `${prefix}.${k}` : k);
      }
    } else if (wanted.has(prefix) && (typeof value === 'string' || typeof value === 'number')) {
      out.set(prefix, String(value));
    }
  };
  visit(doc, '');
  return out;
}
