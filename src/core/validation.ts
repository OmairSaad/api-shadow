import * as path from 'path';
import type { AnalysisIssue, Endpoint } from './types';

/**
 * Validation detection, like auth detection, works on names: validation middleware
 * (`validate(schema)`, `celebrate()`, express-validator chains), NestJS pipes, `@Valid`, Fastify
 * route schemas and schema checks of the body inside handlers. Linkers set `validation` when they
 * know (handler checks, `@Valid`, Fastify schemas); this fills in the rest from middleware.
 */
const VALIDATION_MIDDLEWARE = /valid|celebrate|joi|zod|yup|schema|ajv|superstruct|typebox|sanitiz|^(body|check|checkSchema|oneOf)\(|Pipe\b/i;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
/** Body types a NestJS `ValidationPipe` can't validate: there is no class with decorators. */
const UNTYPED_BODY = new Set(['object', 'any', 'unknown', 'Record', 'Object']);

export function acceptsBody(e: Endpoint): boolean {
  if (e.framework === 'nestjs' || e.framework === 'spring') return !!e.requestBodyType;
  // Laravel handlers read input explicitly (`$request->input()`, a FormRequest).
  if (e.framework === 'laravel') return BODY_METHODS.has(e.method) && (!!e.requestBodyType || !!e.readsBody || e.validation?.status === 'validated');
  return BODY_METHODS.has(e.method) || !!e.requestBodyType;
}

/**
 * Sets `validation` on endpoints that accept a body and reports unvalidated ones in projects where
 * other bodies are validated (a project that validates nothing gets no warnings: the noise would
 * hide everything else).
 */
export function applyValidation(endpoints: Endpoint[], enabled: boolean): AnalysisIssue[] {
  if (!enabled) {
    for (const e of endpoints) delete e.validation;
    return [];
  }
  const validatingProjects = new Set<string>();
  for (const e of endpoints) {
    if (!acceptsBody(e)) {
      delete e.validation;
      continue;
    }
    if (e.validation?.status !== 'validated') {
      const via = e.middleware.filter((m) => VALIDATION_MIDDLEWARE.test(m) && !/^(UseGuards|APP_GUARD|useGlobalGuards)\(/.test(m));
      const untyped = e.framework === 'nestjs' && UNTYPED_BODY.has(e.requestBodyType ?? '');
      e.validation = via.length > 0 && !untyped ? { status: 'validated', via } : { status: 'missing', via: untyped && via.length ? [`${e.requestBodyType} body type`] : [] };
    }
    if (e.validation.status === 'validated') validatingProjects.add(e.projectRoot);
  }
  return endpoints
    .filter((e) => e.validation?.status === 'missing' && validatingProjects.has(e.projectRoot))
    .map((e) => ({
      kind: 'no-validation' as const,
      severity: 'warning' as const,
      message:
        e.validation!.via.length > 0
          ? `${e.method} ${e.path} (${path.basename(e.location.file)}:${e.location.line}) has a ValidationPipe, but its body has no DTO class (typed ${e.requestBodyType}), so nothing is validated.`
          : `The request body of ${e.method} ${e.path} (${path.basename(e.location.file)}:${e.location.line}) is not validated, but other endpoints in this project validate theirs.`,
      location: e.location,
      endpointIds: [e.id],
    }));
}
