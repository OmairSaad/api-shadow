/**
 * Expands Spring controllers into endpoints. Handles class + method level mappings, constants
 * (including constants declared in other classes, static imports and inherited interface
 * constants), mappings inherited from interfaces / superclasses, and `server.servlet.context-path`.
 */
import type { JavaClassFact, JavaFileFacts, JavaMapping, JavaMethodFact, SpringConfigFacts } from '../analyzers/facts';
import { compactExpr, exprToDisplay, isStaticExpr, joinUrlPaths } from '../core/paths';
import type { Endpoint, PathExpr, PathPart, ServiceRef, SourceLocation } from '../core/types';
import { endpointId, LinkContext, loc, shortFile } from './context';
import { own } from '../core/records';

interface ClassEntry {
  file: string;
  facts: JavaFileFacts;
  cls: JavaClassFact;
  fqn: string;
}

const SERVICE_LIKE = /(Service|Repository|Repo|Dao|Client|Gateway|Facade|Manager|UseCase|Handler|Provider|Port|Adapter)$/;

export class SpringLinker {
  private readonly bySimple = new Map<string, ClassEntry[]>();
  private readonly byFqn = new Map<string, ClassEntry>();
  private readonly constants = new Map<string, { expr: PathExpr; file: string; facts: JavaFileFacts; owner: string }>();

  constructor(private readonly ctx: LinkContext) {}

  link(): Endpoint[] {
    const contextPaths = new Map<string, { value: string; file: string }>();
    for (const [file, facts] of this.ctx.files()) {
      if (facts.lang === 'java') this.index(file, facts);
      if (facts.lang === 'spring-config' && this.ctx.options.springApplyContextPath) {
        const value = joinUrlPaths(...[(facts as SpringConfigFacts).contextPath, (facts as SpringConfigFacts).servletPath].filter((v): v is string => !!v));
        if (value !== '/') {
          const root = this.ctx.projectRootOf(file);
          // application.properties wins over application.yml when both exist (Spring loads both; properties takes precedence).
          const existing = contextPaths.get(root);
          if (!existing || file.endsWith('.properties')) contextPaths.set(root, { value, file });
        }
      }
    }
    const endpoints: Endpoint[] = [];
    for (const entries of this.bySimple.values()) {
      for (const entry of entries) {
        const { cls } = entry;
        if (cls.kind !== 'class' || cls.isAbstract || !this.isController(entry)) continue;
        endpoints.push(...this.expand(entry, contextPaths.get(this.ctx.projectRootOf(entry.file))));
      }
    }
    return endpoints;
  }

  private index(file: string, facts: JavaFileFacts): void {
    for (const cls of facts.classes) {
      const fqn = [facts.packageName, ...cls.outer, cls.name].filter(Boolean).join('.');
      const entry: ClassEntry = { file, facts, cls, fqn };
      const list = this.bySimple.get(cls.name) ?? [];
      list.push(entry);
      this.bySimple.set(cls.name, list);
      this.byFqn.set(fqn, entry);
    }
    for (const [key, expr] of Object.entries(facts.constants)) {
      if (!this.constants.has(key)) {
        const owner = key.slice(0, key.lastIndexOf('.'));
        this.constants.set(key, { expr, file, facts, owner });
      }
    }
  }

  private findClass(name: string, from: JavaFileFacts): ClassEntry | undefined {
    const fqn = own(from.imports, name);
    if (fqn && this.byFqn.has(fqn)) return this.byFqn.get(fqn);
    const samePackage = this.byFqn.get(from.packageName ? `${from.packageName}.${name}` : name);
    if (samePackage) return samePackage;
    const candidates = this.bySimple.get(name);
    if (!candidates) this.ctx.requestJavaClass(name);
    return candidates?.[0];
  }

  /** `@RestController`/`@Controller` on the class or (Spring 5+) inherited. */
  private isController(entry: ClassEntry): boolean {
    if (entry.cls.isController) return true;
    return this.ancestors(entry).some((a) => a.cls.isController && a.cls.kind === 'class');
  }

  private ancestors(entry: ClassEntry, seen = new Set<string>()): ClassEntry[] {
    const out: ClassEntry[] = [];
    for (const name of [...entry.cls.extends, ...entry.cls.implements]) {
      const parent = this.findClass(name, entry.facts);
      if (!parent || seen.has(parent.fqn)) continue;
      seen.add(parent.fqn);
      out.push(parent, ...this.ancestors(parent, seen));
    }
    return out;
  }

  private resolveExpr(expr: PathExpr, entry: ClassEntry, depth = 0): PathExpr {
    if (depth > 8) return expr;
    const parts: PathPart[] = [];
    for (const part of expr.parts) {
      if (!('ref' in part)) {
        parts.push(part);
        continue;
      }
      const found = this.lookupConstant(part.ref, entry);
      if (found) {
        const owner = this.findClass(found.owner.split('.').pop() as string, found.facts) ?? entry;
        parts.push(...this.resolveExpr(found.expr, owner, depth + 1).parts);
      } else {
        parts.push({ dynamic: part.ref });
      }
    }
    return compactExpr({ parts });
  }

  private lookupConstant(ref: string, entry: ClassEntry): { expr: PathExpr; facts: JavaFileFacts; owner: string } | undefined {
    const segments = ref.split('.');
    if (segments.length === 1) {
      const name = segments[0];
      // Own class, then enclosing classes (innermost first).
      const chain = [entry.cls.name, ...[...entry.cls.outer].reverse()];
      for (const owner of chain) {
        const c = this.constants.get(`${owner}.${name}`);
        if (c) return c;
      }
      const stat = own(entry.facts.staticImports, name);
      if (stat && this.constants.has(stat)) return this.constants.get(stat);
      if (stat) this.ctx.requestJavaClass(stat.split('.')[0]);
      for (const [k, cls] of Object.entries(entry.facts.staticImports)) {
        if (k.startsWith('*')) {
          const c = this.constants.get(`${cls}.${name}`);
          if (c) return c;
          this.ctx.requestJavaClass(cls);
        }
      }
      for (const ancestor of this.ancestors(entry)) {
        const c = this.constants.get(`${ancestor.cls.name}.${name}`);
        if (c) return c;
      }
      return undefined;
    }
    for (let i = 0; i < segments.length - 1; i++) {
      const c = this.constants.get(segments.slice(i).join('.'));
      if (c) return c;
    }
    // e.g. `ApiPaths.USERS` where ApiPaths.java was not analysed yet (no mappings in it).
    for (const seg of segments.slice(0, -1)) {
      if (/^[A-Z]/.test(seg)) this.ctx.requestJavaClass(seg);
    }
    return undefined;
  }

  private classMapping(entry: ClassEntry): { mapping?: JavaMapping; source: ClassEntry } {
    if (entry.cls.mapping) return { mapping: entry.cls.mapping, source: entry };
    for (const a of this.ancestors(entry)) {
      if (a.cls.mapping) return { mapping: a.cls.mapping, source: a };
    }
    return { source: entry };
  }

  private expand(entry: ClassEntry, contextPath: { value: string; file: string } | undefined): Endpoint[] {
    const { mapping: classMapping, source: classMappingSource } = this.classMapping(entry);
    const classPaths = classMapping ? classMapping.paths.map((p) => this.resolveExpr(p, classMappingSource)) : [{ parts: [{ lit: '' }] }];
    const methods: { method: JavaMethodFact; owner: ClassEntry; impl?: JavaMethodFact }[] = [];
    const own = new Map(entry.cls.methods.map((m) => [m.name, m]));
    const covered = new Set<string>();
    for (const m of entry.cls.methods) {
      if (m.mapping) {
        methods.push({ method: m, owner: entry, impl: m });
        covered.add(m.name);
      }
    }
    for (const ancestor of this.ancestors(entry)) {
      for (const m of ancestor.cls.methods) {
        if (!m.mapping || covered.has(m.name)) continue;
        covered.add(m.name);
        methods.push({ method: m, owner: ancestor, impl: own.get(m.name) });
      }
    }
    const endpoints: Endpoint[] = [];
    for (const { method, owner, impl } of methods) {
      const mapping = method.mapping as JavaMapping;
      const methodPaths = mapping.paths.map((p) => this.resolveExpr(p, owner));
      const httpMethods = mapping.methods.length === 1 && mapping.methods[0] === 'ALL' && classMapping && classMapping.methods[0] !== 'ALL' ? classMapping.methods : mapping.methods;
      for (const cPath of classPaths) {
        for (const mPath of methodPaths) {
          for (const httpMethod of httpMethods) {
            const notes: string[] = [];
            const exprs: PathExpr[] = [];
            if (contextPath) {
              exprs.push({ parts: [{ lit: contextPath.value }] });
              notes.push(`Context path "${contextPath.value}" from ${shortFile(contextPath.file)}`);
            }
            exprs.push(cPath, mPath);
            const isStatic = exprs.every(isStaticExpr);
            if (!isStatic) notes.push('Path references constants or expressions that could not be resolved statically.');
            if (owner !== entry) notes.push(`Mapping inherited from ${owner.cls.name}`);
            if (httpMethod === 'ALL') notes.push('No request method specified: matches all HTTP methods.');
            const conditions = [...(classMapping?.conditions ?? []), ...(mapping.conditions ?? [])];
            if (conditions.length) notes.push(`Matches only requests with ${conditions.join(', ')}`);
            const location = loc(owner.file, method.pos);
            const implMethod = impl ?? method;
            const implFile = impl ? entry.file : owner.file;
            const endpoint: Endpoint = {
              id: '',
              framework: 'spring',
              method: httpMethod,
              path: joinUrlPaths(...exprs.map(exprToDisplay)),
              pathIsStatic: isStatic,
              controller: entry.cls.name,
              handler: method.name,
              location,
              handlerLocation: impl && impl !== method ? loc(entry.file, impl.pos) : undefined,
              middleware: [...entry.cls.security, ...(owner !== entry ? owner.cls.security : []), ...method.security, ...(impl && impl !== method ? impl.security : [])],
              services: this.services(implMethod, implFile === entry.file ? entry : owner),
              parameters: method.params,
              requestBodyType: method.bodyType,
              validation: method.bodyType && (method.bodyValidated || impl?.bodyValidated) ? { status: 'validated', via: ['@Valid'] } : undefined,
              conditions: conditions.length ? conditions : undefined,
              notes,
              projectRoot: this.ctx.projectRootOf(entry.file),
            };
            endpoint.id = endpointId(endpoint, entry.fqn);
            endpoints.push(endpoint);
          }
        }
      }
    }
    return endpoints;
  }

  private services(method: JavaMethodFact, entry: ClassEntry): ServiceRef[] {
    const out: ServiceRef[] = [];
    for (const call of method.calls) {
      if (!call.type) continue;
      const target = this.findClass(call.type, entry.facts);
      if (!target && !SERVICE_LIKE.test(call.type)) continue;
      let location: SourceLocation | undefined;
      if (target) {
        const m = target.cls.methods.find((x) => x.name === call.method);
        location = loc(target.file, m?.pos ?? target.cls.pos);
      }
      out.push({ name: `${call.type}.${call.method}`, location });
    }
    return out;
  }
}
