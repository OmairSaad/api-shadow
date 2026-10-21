/**
 * Reads module path aliases from `tsconfig.json` / `jsconfig.json`: `compilerOptions.baseUrl` and
 * `compilerOptions.paths`. Nothing else is kept. `extends` is not followed.
 */
import type { TsConfigFacts } from './facts';

export function isTsConfigFile(file: string): boolean {
  return /(^|[\\/])(tsconfig|jsconfig)\.json$/i.test(file);
}

export function analyzeTsConfig(source: string): TsConfigFacts {
  const facts: TsConfigFacts = { lang: 'tsconfig', paths: {}, issues: [] };
  let doc: unknown;
  try {
    doc = JSON.parse(stripJsonComments(source));
  } catch {
    facts.issues.push({ kind: 'limitation', severity: 'info', message: 'Could not read this tsconfig/jsconfig; its path aliases are not used.' });
    return facts;
  }
  const options = isObj(doc) && isObj(doc.compilerOptions) ? doc.compilerOptions : undefined;
  if (!options) return facts;
  if (typeof options.baseUrl === 'string') facts.baseUrl = options.baseUrl;
  if (isObj(options.paths)) {
    for (const [pattern, targets] of Object.entries(options.paths)) {
      if (Array.isArray(targets)) facts.paths[pattern] = targets.filter((t): t is string => typeof t === 'string').slice(0, 8);
    }
  }
  return facts;
}

/** tsconfig files are JSON with comments and trailing commas. */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
