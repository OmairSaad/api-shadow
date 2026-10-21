/**
 * Expands NestJS controllers into endpoints. Applies, per project root:
 * `app.setGlobalPrefix()` (with `exclude`), URI versioning (`enableVersioning` + `@Version` /
 * controller `version`), `RouterModule.register()` module prefixes and global guards
 * (`app.useGlobalGuards()`, `APP_GUARD` providers).
 */
import type { JsFileFacts, NestGlobalGuardFact, NestMethodFact, NestGlobalPrefixFact, NestRouterModuleRoute, NestVersioningFact } from '../analyzers/facts';
import { exprToDisplay, isStaticExpr, joinUrlPaths, lit } from '../core/paths';
import type { Endpoint, HttpMethod, PathExpr, ServiceRef, Shape, SourceLocation } from '../core/types';
import { bodyFields, endpointId, LinkContext, loc, shortFile } from './context';
import { own } from '../core/records';

interface ProjectConfig {
  prefix?: { fact: NestGlobalPrefixFact; file: string };
  versioning?: { fact: NestVersioningFact; file: string };
  /** module name -> RouterModule prefix */
  modulePrefixes: Map<string, string>;
  /** controller class -> module names */
  controllerModules: Map<string, string[]>;
  globalGuards: { fact: NestGlobalGuardFact; file: string }[];
  globalPipes: { fact: NestGlobalGuardFact; file: string }[];
}

export class NestLinker {
  constructor(private readonly ctx: LinkContext) {}

  link(): Endpoint[] {
    const files: [string, JsFileFacts][] = [];
    for (const [file, facts] of this.ctx.files()) if (facts.lang === 'js') files.push([file, facts]);
    const configs = new Map<string, ProjectConfig>();
    const configFor = (root: string): ProjectConfig => {
      let c = configs.get(root);
      if (!c) {
        c = { modulePrefixes: new Map(), controllerModules: new Map(), globalGuards: [], globalPipes: [] };
        configs.set(root, c);
      }
      return c;
    };
    for (const [file, facts] of files) {
      const config = configFor(this.ctx.projectRootOf(file));
      if (facts.nestGlobalPrefix) {
        if (config.prefix && config.prefix.file !== file) {
          this.ctx.issue('warning', `Multiple setGlobalPrefix() calls in this project; using the one in ${shortFile(config.prefix.file)}.`, file, facts.nestGlobalPrefix.pos);
        } else {
          config.prefix = { fact: facts.nestGlobalPrefix, file };
        }
        if (!isStaticExpr(facts.nestGlobalPrefix.prefix)) {
          this.ctx.issue('info', 'Global prefix is not a static string; it is shown as an expression.', file, facts.nestGlobalPrefix.pos);
        }
      }
      if (facts.nestVersioning) {
        config.versioning = { fact: facts.nestVersioning, file };
        if (facts.nestVersioning.type === 'UNKNOWN') {
          this.ctx.issue('info', 'Versioning type could not be determined; version prefixes are not applied.', file, facts.nestVersioning.pos);
        }
      }
      for (const fact of facts.nestGlobalGuards) config.globalGuards.push({ fact, file });
      for (const fact of facts.nestGlobalPipes ?? []) config.globalPipes.push({ fact, file });
      for (const mod of facts.nestModules) {
        for (const c of mod.controllers) {
          const list = config.controllerModules.get(c) ?? [];
          list.push(mod.name);
          config.controllerModules.set(c, list);
        }
      }
      const flatten = (routes: NestRouterModuleRoute[], parent: string): void => {
        for (const r of routes) {
          const full = joinUrlPaths(parent, r.path);
          if (r.module) config.modulePrefixes.set(r.module, full);
          flatten(r.children, full);
        }
      };
      flatten(facts.nestRouterModule, '');
    }

    const endpoints: Endpoint[] = [];
    for (const [file, facts] of files) {
      const root = this.ctx.projectRootOf(file);
      const config = configFor(root);
      // Global guards run before controller and method guards.
      const globalGuards = [...config.globalGuards, ...config.globalPipes].map((g) => `${g.fact.via}(${g.fact.name})`);
      const guardNotes = config.globalGuards.map((g) => `Global guard ${g.fact.name} (${g.fact.via}, ${shortFile(g.file)}:${g.fact.pos.line})`);
      for (const controller of facts.nestControllers) {
        const modules = config.controllerModules.get(controller.className) ?? [];
        const modulePrefix = modules.map((m) => config.modulePrefixes.get(m)).find((p) => p !== undefined);
        controller.methods.forEach((method, methodIndex) => {
          const versions = method.versions.length > 0 ? method.versions : controller.versions.length > 0 ? controller.versions : (config.versioning?.fact.defaultVersions ?? []);
          const versioning = config.versioning?.fact;
          const uriVersions =
            versioning?.type === 'URI' && versions.length > 0
              ? versions.map((v) => (v === 'VERSION_NEUTRAL' ? '' : `${versioning.prefix === false ? '' : versioning.prefix}${v}`))
              : [''];
          for (const cPath of controller.paths) {
            for (const mPath of method.paths) {
              for (const version of uriVersions) {
                const notes: string[] = [...guardNotes];
                const routeOnly = joinUrlPaths(exprToDisplay(cPath), exprToDisplay(mPath));
                const exprs: PathExpr[] = [];
                const prefix = config.prefix;
                if (prefix && !this.isExcluded(prefix.fact, routeOnly, method.method)) {
                  exprs.push(prefix.fact.prefix);
                  notes.push(`Global prefix "${exprToDisplay(prefix.fact.prefix)}" from setGlobalPrefix (${shortFile(prefix.file)}:${prefix.fact.pos.line})`);
                } else if (prefix) {
                  notes.push('Excluded from the global prefix.');
                }
                if (version) {
                  exprs.push(lit(version));
                  notes.push(`URI version "${version}"`);
                } else if (versioning && versioning.type !== 'URI' && versions.length > 0) {
                  notes.push(`Version ${versions.join(', ')} selected via ${versioning.type.toLowerCase().replace('_', ' ')}`);
                }
                if (modulePrefix) {
                  exprs.push(lit(modulePrefix));
                  notes.push(`RouterModule prefix "${modulePrefix}" (${modules.join(', ')})`);
                }
                exprs.push(cPath, mPath);
                const isStatic = exprs.every(isStaticExpr);
                if (!isStatic) notes.push('Path contains expressions that could not be resolved statically.');
                const location = loc(file, method.pos);
                const callableKey = `${controller.className}.${method.name}`;
                const callable = own(facts.callables, callableKey);
                const endpoint: Endpoint = {
                  id: '',
                  framework: 'nestjs',
                  method: method.method,
                  path: joinUrlPaths(...exprs.map(exprToDisplay)),
                  pathIsStatic: isStatic,
                  controller: controller.className,
                  handler: method.name,
                  location,
                  handlerLocation: callable ? loc(file, callable.pos) : undefined,
                  middleware: [...new Set([...globalGuards, ...controller.middleware, ...method.middleware, ...(method.bodyPipes ?? []).map((p) => `Body(${p})`)])],
                  markers: [...new Set([...controller.markers, ...method.markers])],
                  services: this.services(file, facts, method.serviceCalls),
                  parameters: method.params.map(({ name, in: where, required, type }) => ({ name, in: where, required, type })),
                  requestBodyType: method.bodyType,
                  version: versioning && versioning.type !== 'URI' && versions.length > 0 ? versions.join(', ') : undefined,
                  notes,
                  projectRoot: root,
                  ...this.bodyOf(file, facts, method),
                };
                endpoint.id = endpointId(endpoint, version);
                endpoints.push(endpoint);
                // Nest registers a controller's routes in declaration order.
                this.ctx.registrations.set(endpoint.id, { chain: [{ scope: `${file}|${controller.className}|${exprToDisplay(cPath)}|${version}`, order: methodIndex }], passThrough: false });
              }
            }
          }
        });
      }
    }
    return endpoints;
  }

  /**
   * Responses of a Nest handler: returned values and thrown HTTP exceptions, with the default
   * status (201 for POST, 200 otherwise) or `@HttpCode`, plus the declared return type's shape.
   */
  private bodyOf(file: string, facts: JsFileFacts, method: NestMethodFact): Partial<Endpoint> {
    const fields = bodyFields(method.body, file, 'nestjs');
    const success = method.httpCode ?? (method.method === 'POST' ? 201 : 200);
    const responses = (fields.responses ?? []).map((r) => (r.via === 'return' && r.status === undefined ? { ...r, status: success } : r));
    if (method.returnType) {
      const array = method.returnType.endsWith('[]');
      const name = method.returnType.replace(/\[\]$/, '');
      const shape = this.resolveType(file, facts, name, 0);
      if (shape) {
        // A declared type describes the success response better than an opaque returned value.
        const known = responses.filter((r) => r.via !== 'return' || (r.shape && r.shape.t !== 'unknown'));
        known.push({ status: success, shape: array ? { t: 'array', items: shape } : shape, via: 'type', type: method.returnType, location: loc(file, method.pos) });
        fields.responses = known;
        return fields;
      }
    }
    if (responses.length) fields.responses = responses;
    return fields;
  }

  /** Shape of a TypeScript type declared in this file or imported from another one. */
  private resolveType(file: string, facts: JsFileFacts, name: string, depth: number): Shape | undefined {
    if (depth > 4) return undefined;
    const local = own(facts.types, name);
    if (local) return local;
    const imp = own(facts.imports, name);
    if (!imp) return undefined;
    const target = this.ctx.resolveModule(file, imp.source);
    const tf = target ? this.ctx.getFacts(target) : undefined;
    if (!target || tf?.lang !== 'js') return undefined;
    const exported = imp.name === 'default' || imp.name === '*' ? name : imp.name;
    const direct = own(tf.types, exported);
    if (direct) return direct;
    const re = own(tf.exports, exported);
    if (re?.k === 'import') return this.resolveType(target, { ...tf, imports: { ...tf.imports, [exported]: { source: re.source, name: re.name } } }, exported, depth + 1);
    for (const star of tf.starExports) {
      const next = this.ctx.resolveModule(target, star);
      const nf = next ? this.ctx.getFacts(next) : undefined;
      const s = nf?.lang === 'js' ? own(nf.types, exported) : undefined;
      if (s) return s;
    }
    return undefined;
  }

  private isExcluded(prefix: NestGlobalPrefixFact, routePath: string, method: HttpMethod): boolean {
    return prefix.exclude.some((ex) => {
      if (ex.method && ex.method !== method && ex.method !== 'ALL') return false;
      const pattern = joinUrlPaths(ex.path);
      if (pattern === routePath) return true;
      if (/[*(]/.test(pattern)) {
        const re = new RegExp('^' + pattern.replace(/[.+^${}|[\]\\]/g, '\\$&').replace(/\(\.\*\)|\*/g, '.*').replace(/[()]/g, '') + '$');
        return re.test(routePath);
      }
      return false;
    });
  }

  private services(file: string, facts: JsFileFacts, calls: { receiver: string; method: string; type?: string }[]): ServiceRef[] {
    return calls.map((call) => {
      const typeName = call.type || call.receiver.replace(/^this\./, '');
      let location: SourceLocation | undefined;
      if (call.type) location = this.findClassMethod(file, facts, call.type, call.method);
      return { name: `${typeName}.${call.method}`, location };
    });
  }

  private findClassMethod(file: string, facts: JsFileFacts, className: string, method: string): SourceLocation | undefined {
    const local = own(facts.classes, className);
    if (local) {
      const key = own(local.methods, method);
      const callable = key ? own(facts.callables, key) : undefined;
      return loc(file, callable?.pos ?? local.pos);
    }
    const imp = own(facts.imports, className);
    if (!imp) return undefined;
    const target = this.ctx.resolveModule(file, imp.source);
    if (!target) return undefined;
    const tf = this.ctx.getFacts(target);
    if (tf?.lang !== 'js') return undefined;
    const name = imp.name === 'default' ? (Object.values(tf.exports).find((e) => e.k === 'class') as { name: string } | undefined)?.name ?? className : imp.name;
    const cls = own(tf.classes, name);
    if (cls) {
      const key = own(cls.methods, method);
      const callable = key ? own(tf.callables, key) : undefined;
      return loc(target, callable?.pos ?? cls.pos);
    }
    // Re-exported through a barrel file.
    const reexport = own(tf.exports, name);
    if (reexport?.k === 'import') {
      const next = this.ctx.resolveModule(target, reexport.source);
      const nf = next ? this.ctx.getFacts(next) : undefined;
      if (next && nf?.lang === 'js') return this.findClassMethod(next, { ...nf, imports: { ...nf.imports, [className]: { source: reexport.source, name: reexport.name } } }, className, method);
    }
    for (const star of tf.starExports) {
      const next = this.ctx.resolveModule(target, star);
      const nf = next ? this.ctx.getFacts(next) : undefined;
      if (next && nf?.lang === 'js' && own(nf.classes, name)) return this.findClassMethod(next, nf, name, method);
    }
    return undefined;
  }
}
