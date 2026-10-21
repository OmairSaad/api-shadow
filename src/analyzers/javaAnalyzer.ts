/**
 * Extracts Spring MVC / WebFlux annotation facts from a Java file using the `java-parser` CST
 * (the parser behind prettier-plugin-java). Nothing is compiled or executed.
 */
import { parse, type CstNode, type IToken } from 'java-parser';
import type { EndpointParameter, HttpMethod, PathExpr, PathPart, ServiceCall } from '../core/types';
import { compactExpr } from '../core/paths';
import type { ClientCallFact, JavaClassFact, JavaFieldFact, JavaFileFacts, JavaMapping, JavaMethodFact, Pos, RiskFact } from './facts';
import { own, table } from '../core/records';

type CstElement = CstNode | IToken;

const MAPPING_ANNOTATIONS = table<HttpMethod | undefined>({
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  PatchMapping: 'PATCH',
  DeleteMapping: 'DELETE',
  RequestMapping: undefined,
});

const SECURITY_ANNOTATIONS = new Set(['PreAuthorize', 'PostAuthorize', 'Secured', 'RolesAllowed', 'PermitAll', 'DenyAll']);
const CONTROLLER_ANNOTATIONS = new Set(['RestController', 'Controller']);
/** Signs that a class configures Spring Security for the whole application. */
const SECURITY_CONFIG_ANNOTATIONS = new Set(['EnableWebSecurity', 'EnableWebFluxSecurity']);
const SECURITY_CONFIG_TYPES = new Set(['SecurityFilterChain', 'SecurityWebFilterChain', 'WebSecurityConfigurerAdapter']);
const REQUEST_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);
const ENTITY_ANNOTATIONS = new Set(['Entity', 'Document', 'Table']);
const REQUEST_INPUT_ANNOTATIONS = new Set(['RequestParam', 'PathVariable', 'RequestBody', 'RequestHeader', 'CookieValue', 'ModelAttribute']);
const HTTP_STATUS: Record<string, number> = {
  OK: 200, CREATED: 201, ACCEPTED: 202, NO_CONTENT: 204, MOVED_PERMANENTLY: 301, FOUND: 302, SEE_OTHER: 303, NOT_MODIFIED: 304,
  BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405, CONFLICT: 409, GONE: 410,
  UNPROCESSABLE_ENTITY: 422, TOO_MANY_REQUESTS: 429, INTERNAL_SERVER_ERROR: 500, NOT_IMPLEMENTED: 501, SERVICE_UNAVAILABLE: 503,
};
const SQL_METHODS = new Set(['createQuery', 'createNativeQuery', 'query', 'queryForObject', 'queryForList', 'queryForMap', 'queryForRowSet', 'update', 'execute', 'executeQuery', 'executeUpdate', 'batchUpdate', 'prepareStatement']);
const FILE_CONSTRUCTORS = new Set(['File', 'FileInputStream', 'FileOutputStream', 'FileSystemResource', 'FileReader', 'FileWriter', 'RandomAccessFile']);

/** Quick textual check used to decide whether a Java file is worth parsing in the first pass. */
export function isJavaCandidate(source: string): boolean {
  return /@(Rest)?Controller\b|Mapping\b|MockMvc|WebTestClient|TestRestTemplate|SecurityFilterChain\b|SecurityWebFilterChain\b|EnableWeb(Flux)?Security\b|WebSecurityConfigurerAdapter\b/.test(source);
}

function isToken(el: CstElement): el is IToken {
  return (el as IToken).image !== undefined;
}

function kids(node: CstNode | undefined, name: string): CstElement[] {
  return node?.children[name] ?? [];
}

function kid(node: CstNode | undefined, name: string): CstNode | undefined {
  const el = kids(node, name)[0];
  return el && !isToken(el) ? el : undefined;
}

function kidNodes(node: CstNode | undefined, name: string): CstNode[] {
  return kids(node, name).filter((el): el is CstNode => !isToken(el));
}

function tokensOf(node: CstElement): IToken[] {
  const out: IToken[] = [];
  const visit = (el: CstElement): void => {
    if (isToken(el)) {
      out.push(el);
      return;
    }
    for (const key of Object.keys(el.children)) {
      for (const child of el.children[key]) visit(child);
    }
  };
  visit(node);
  return out.sort((a, b) => a.startOffset - b.startOffset);
}

function directTokens(node: CstNode | undefined, tokenName: string): IToken[] {
  return kids(node, tokenName)
    .filter(isToken)
    .sort((a, b) => a.startOffset - b.startOffset);
}

function hasToken(node: CstNode | undefined, tokenName: string): boolean {
  return kids(node, tokenName).length > 0;
}

function tokenPos(tok: IToken): Pos {
  return { line: tok.startLine ?? 1, column: tok.startColumn ?? 1 };
}

function nodePos(node: CstNode): Pos {
  return { line: node.location?.startLine ?? 1, column: node.location?.startColumn ?? 1 };
}

function unescapeJavaString(image: string): string {
  if (image.startsWith('"""')) {
    // Text block: strip delimiters and common indentation.
    const body = image.slice(3, -3).replace(/^[^\n]*\n/, '');
    const lines = body.split('\n');
    const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length));
    return lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n').trim();
  }
  const inner = image.slice(1, -1);
  try {
    return JSON.parse(`"${inner.replace(/\\'/g, "'").replace(/\\([0-7]{1,3})/g, (_m, o: string) => `\\u${parseInt(o, 8).toString(16).padStart(4, '0')}`)}"`) as string;
  } catch {
    return inner;
  }
}

/** Last identifier of a (possibly qualified) type node, ignoring generic arguments. */
function simpleTypeName(node: CstNode | undefined): string | undefined {
  if (!node) return undefined;
  const classType = findFirst(node, ['unannClassType', 'classType']);
  if (classType) {
    const ids = directTokens(classType, 'Identifier');
    return ids[ids.length - 1]?.image;
  }
  const primitive = findFirst(node, ['unannPrimitiveType', 'numericType', 'integralType']);
  if (primitive) return tokensOf(primitive)[0]?.image;
  return tokensOf(node)[0]?.image;
}

function findFirst(node: CstNode, names: string[]): CstNode | undefined {
  if (names.includes(node.name)) return node;
  for (const key of Object.keys(node.children)) {
    for (const child of node.children[key]) {
      if (isToken(child)) continue;
      const found = findFirst(child, names);
      if (found) return found;
    }
  }
  return undefined;
}

interface Annotation {
  name: string;
  values: Record<string, CstNode>;
  node: CstNode;
}

export function analyzeJava(source: string, _filePath: string): JavaFileFacts {
  const facts: JavaFileFacts = {
    lang: 'java',
    packageName: '',
    imports: {},
    staticImports: {},
    classes: [],
    constants: {},
    clientCalls: [],
    issues: [],
  };
  let cst: CstNode;
  try {
    cst = parse(source);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const m = /line: (\d+), column: (\d+)/.exec(message);
    facts.issues.push({
      kind: 'parse-error',
      severity: 'error',
      message: 'Could not parse Java file; endpoints in it are not shown.',
      pos: m ? { line: Number(m[1]), column: Number(m[2]) } : undefined,
    });
    return facts;
  }
  new JavaWalker(source, facts).run(cst);
  facts.clientCalls = findClientCalls(tokensOf(cst), facts.staticImports);
  return facts;
}

class JavaWalker {
  constructor(
    private readonly source: string,
    private readonly facts: JavaFileFacts,
  ) {}

  run(cst: CstNode): void {
    const unit = kid(cst, 'ordinaryCompilationUnit');
    if (!unit) {
      return;
    }
    const pkg = kid(unit, 'packageDeclaration');
    if (pkg) this.facts.packageName = directTokens(pkg, 'Identifier').map((t) => t.image).join('.');
    for (const imp of kidNodes(unit, 'importDeclaration')) {
      const name = kid(imp, 'packageOrTypeName');
      if (!name) continue;
      const parts = directTokens(name, 'Identifier').map((t) => t.image);
      const isStatic = hasToken(imp, 'Static');
      const isStar = hasToken(imp, 'Star');
      if (isStatic) {
        if (isStar) {
          const cls = parts[parts.length - 1];
          if (cls) this.facts.staticImports[`*${cls}`] = cls;
        } else if (parts.length >= 2) {
          const member = parts[parts.length - 1];
          this.facts.staticImports[member] = `${parts[parts.length - 2]}.${member}`;
        }
      } else if (!isStar && parts.length > 0) {
        this.facts.imports[parts[parts.length - 1]] = parts.join('.');
      }
    }
    for (const td of kidNodes(unit, 'typeDeclaration')) {
      this.typeDeclaration(td, []);
    }
  }

  private typeDeclaration(node: CstNode, outer: string[]): void {
    const cls = kid(node, 'classDeclaration');
    if (cls) this.classDeclaration(cls, outer);
    const iface = kid(node, 'interfaceDeclaration');
    if (iface) this.interfaceDeclaration(iface, outer);
  }

  private annotationsOf(modifiers: CstNode[]): Annotation[] {
    const out: Annotation[] = [];
    for (const mod of modifiers) {
      for (const ann of kidNodes(mod, 'annotation')) out.push(this.annotation(ann));
    }
    return out;
  }

  private annotation(ann: CstNode): Annotation {
    const typeName = kid(ann, 'typeName');
    const ids = directTokens(typeName, 'Identifier');
    const name = ids[ids.length - 1]?.image ?? '';
    const values: Record<string, CstNode> = {};
    const single = kid(ann, 'elementValue');
    if (single) values.value = single;
    const pairs = kid(ann, 'elementValuePairList');
    for (const pair of kidNodes(pairs, 'elementValuePair')) {
      const key = directTokens(pair, 'Identifier')[0]?.image;
      const value = kid(pair, 'elementValue');
      if (key && value) values[key] = value;
    }
    return { name, values, node: ann };
  }

  private text(node: CstNode): string {
    const loc = node.location;
    if (!loc || loc.startOffset === undefined || loc.endOffset === undefined) return tokensOf(node).map((t) => t.image).join('');
    return this.source.slice(loc.startOffset, loc.endOffset + 1);
  }

  /** Splits an element value into its items (array initializer) or a single expression. */
  private elementItems(value: CstNode): CstNode[] {
    const array = kid(value, 'elementValueArrayInitializer');
    if (array) {
      const list = kid(array, 'elementValueList');
      return kidNodes(list, 'elementValue').flatMap((v) => this.elementItems(v));
    }
    return [value];
  }

  /** Evaluates a constant expression of string literals, constant references and `+`. */
  private evalExpr(node: CstNode): PathExpr {
    const tokens = tokensOf(node);
    const parts: PathPart[] = [];
    let i = 0;
    const dynamic = (): PathExpr => ({ parts: [{ dynamic: this.text(node).replace(/\s+/g, ' ') }] });
    while (i < tokens.length) {
      const tok = tokens[i];
      const type = tok.tokenType.name;
      if (type === 'StringLiteral' || type === 'TextBlock') {
        parts.push({ lit: unescapeJavaString(tok.image) });
        i++;
      } else if (type === 'Identifier') {
        const ids = [tok.image];
        i++;
        while (i + 1 < tokens.length && tokens[i].tokenType.name === 'Dot' && tokens[i + 1].tokenType.name === 'Identifier') {
          ids.push(tokens[i + 1].image);
          i += 2;
        }
        if (i < tokens.length && tokens[i].tokenType.name === 'LBrace') return dynamic(); // method call
        parts.push({ ref: ids.join('.') });
      } else if (type === 'Plus' || type === 'LBrace' || type === 'RBrace') {
        i++;
      } else {
        return dynamic();
      }
    }
    return compactExpr({ parts });
  }

  private pathsFrom(ann: Annotation): PathExpr[] {
    const value = ann.values.path ?? ann.values.value;
    if (!value) return [{ parts: [{ lit: '' }] }];
    const items = this.elementItems(value);
    return items.length > 0 ? items.map((item) => this.evalExpr(item)) : [{ parts: [{ lit: '' }] }];
  }

  private mappingOf(annotations: Annotation[]): JavaMapping | undefined {
    for (const ann of annotations) {
      if (!(ann.name in MAPPING_ANNOTATIONS)) continue;
      const fixed = MAPPING_ANNOTATIONS[ann.name];
      let methods: HttpMethod[];
      if (fixed) {
        methods = [fixed];
      } else {
        const m = ann.values.method;
        methods = m
          ? this.elementItems(m)
              .map((item) => {
                const ids = tokensOf(item).filter((t) => t.tokenType.name === 'Identifier');
                return ids[ids.length - 1]?.image ?? '';
              })
              .filter((x) => REQUEST_METHODS.has(x)) as HttpMethod[]
          : [];
        if (methods.length === 0) methods = ['ALL'];
      }
      // Attributes that narrow which requests match; two mappings differing in these don't clash.
      const conditions = ['params', 'headers', 'consumes', 'produces']
        .filter((key) => ann.values[key])
        .map((key) => {
          const text = this.text(ann.values[key]).replace(/\s+/g, ' ');
          return `${key} = ${text.length > 80 ? text.slice(0, 79) + '…' : text}`;
        });
      return { methods, paths: this.pathsFrom(ann), conditions };
    }
    return undefined;
  }

  private securityOf(annotations: Annotation[]): string[] {
    return annotations
      .filter((a) => SECURITY_ANNOTATIONS.has(a.name))
      .map((a) => {
        const text = this.text(a.node).replace(/\s+/g, ' ');
        return text.length > 100 ? text.slice(0, 97) + '…' : text;
      });
  }

  private typeListNames(list: CstNode | undefined): string[] {
    return kidNodes(list, 'interfaceType')
      .map((it) => simpleTypeName(it))
      .filter((x): x is string => !!x);
  }

  private classDeclaration(node: CstNode, outer: string[]): void {
    const modifiers = kidNodes(node, 'classModifier');
    const annotations = this.annotationsOf(modifiers);
    const record = kid(node, 'recordDeclaration');
    if (record) {
      this.recordDeclaration(record, annotations, outer);
      return;
    }
    const normal = kid(node, 'normalClassDeclaration');
    if (!normal) return; // enums are not treated as controllers
    const nameTok = directTokens(kid(normal, 'typeIdentifier'), 'Identifier')[0];
    if (!nameTok) return;
    const name = nameTok.image;
    const ext = kid(normal, 'classExtends');
    const impl = kid(normal, 'classImplements');
    const cls: JavaClassFact = {
      name,
      outer,
      kind: 'class',
      pos: tokenPos(nameTok),
      isController: annotations.some((a) => CONTROLLER_ANNOTATIONS.has(a.name)),
      isAbstract: modifiers.some((m) => hasToken(m, 'Abstract')),
      mapping: this.mappingOf(annotations),
      security: this.securityOf(annotations),
      extends: ext ? [simpleTypeName(kid(ext, 'classType')) ?? ''].filter(Boolean) : [],
      implements: impl ? this.typeListNames(kid(impl, 'interfaceTypeList')) : [],
      fields: {},
      methods: [],
    };
    if (annotations.some((a) => ENTITY_ANNOTATIONS.has(a.name))) cls.isEntity = true;
    this.facts.classes.push(cls);
    if (annotations.some((a) => SECURITY_CONFIG_ANNOTATIONS.has(a.name)) || cls.extends.some((e) => SECURITY_CONFIG_TYPES.has(e))) {
      this.facts.securityConfig ??= { className: name, pos: tokenPos(nameTok) };
    }
    const body = kid(normal, 'classBody');
    for (const decl of kidNodes(body, 'classBodyDeclaration')) {
      const member = kid(decl, 'classMemberDeclaration');
      if (!member) continue;
      const field = kid(member, 'fieldDeclaration');
      if (field) this.field(field, cls, [...outer, name]);
      const method = kid(member, 'methodDeclaration');
      if (method) this.method(method, 'methodModifier', cls);
      const nestedClass = kid(member, 'classDeclaration');
      if (nestedClass) this.classDeclaration(nestedClass, [...outer, name]);
      const nestedIface = kid(member, 'interfaceDeclaration');
      if (nestedIface) this.interfaceDeclaration(nestedIface, [...outer, name]);
    }
  }

  /** `record UserDto(Long id, String name)`: components are the JSON properties. */
  private recordDeclaration(node: CstNode, annotations: Annotation[], outer: string[]): void {
    const nameTok = directTokens(kid(node, 'typeIdentifier'), 'Identifier')[0];
    if (!nameTok) return;
    const cls: JavaClassFact = {
      name: nameTok.image,
      outer,
      kind: 'record',
      pos: tokenPos(nameTok),
      isController: false,
      isAbstract: false,
      security: [],
      extends: [],
      implements: [],
      fields: {},
      jsonFields: {},
      methods: [],
    };
    if (annotations.some((a) => ENTITY_ANNOTATIONS.has(a.name))) cls.isEntity = true;
    for (const comp of kidNodes(kid(kid(node, 'recordHeader'), 'recordComponentList'), 'recordComponent')) {
      const id = directTokens(comp, 'Identifier')[0];
      const type = this.typeText(kid(comp, 'unannType'));
      if (!id || !type) continue;
      cls.fields[id.image] = simpleTypeName(kid(comp, 'unannType')) ?? type;
      cls.jsonFields![id.image] = this.jsonField(type, this.annotationsOf(kidNodes(comp, 'recordComponentModifier')));
    }
    this.facts.classes.push(cls);
  }

  /** How Jackson serialises a field: `@JsonIgnore`, `@JsonProperty("name")`, write-only access. */
  private jsonField(type: string, annotations: Annotation[]): JavaFieldFact {
    const out: JavaFieldFact = { type };
    for (const a of annotations) {
      if (a.name === 'JsonIgnore' || a.name === 'Transient') out.ignored = true;
      if (a.name === 'JsonProperty') {
        const v = a.values.value;
        const e = v ? this.evalExpr(v) : undefined;
        if (e?.parts.length === 1 && 'lit' in e.parts[0] && e.parts[0].lit) out.jsonName = e.parts[0].lit;
        if (a.values.access && /WRITE_ONLY/.test(this.text(a.values.access))) out.ignored = true;
      }
    }
    return out;
  }

  /** Source text of a type, whitespace removed: `List<UserDto>`. */
  private typeText(node: CstNode | undefined): string | undefined {
    if (!node) return undefined;
    const text = this.text(node).replace(/\s+/g, '').replace(/@\w+(\([^)]*\))?/g, '');
    return text.length > 120 ? undefined : text;
  }

  private interfaceDeclaration(node: CstNode, outer: string[]): void {
    const modifiers = kidNodes(node, 'interfaceModifier');
    const annotations = this.annotationsOf(modifiers);
    const normal = kid(node, 'normalInterfaceDeclaration');
    if (!normal) return;
    const nameTok = directTokens(kid(normal, 'typeIdentifier'), 'Identifier')[0];
    if (!nameTok) return;
    const name = nameTok.image;
    const ext = kid(normal, 'interfaceExtends');
    const cls: JavaClassFact = {
      name,
      outer,
      kind: 'interface',
      pos: tokenPos(nameTok),
      isController: annotations.some((a) => CONTROLLER_ANNOTATIONS.has(a.name)),
      isAbstract: true,
      mapping: this.mappingOf(annotations),
      security: this.securityOf(annotations),
      extends: ext ? this.typeListNames(kid(ext, 'interfaceTypeList')) : [],
      implements: [],
      fields: {},
      methods: [],
    };
    this.facts.classes.push(cls);
    const body = kid(normal, 'interfaceBody');
    for (const member of kidNodes(body, 'interfaceMemberDeclaration')) {
      const constant = kid(member, 'constantDeclaration');
      if (constant) this.constant(constant, [...outer, name]);
      const method = kid(member, 'interfaceMethodDeclaration');
      if (method) this.method(method, 'interfaceMethodModifier', cls);
      const nestedClass = kid(member, 'classDeclaration');
      if (nestedClass) this.classDeclaration(nestedClass, [...outer, name]);
      const nestedIface = kid(member, 'interfaceDeclaration');
      if (nestedIface) this.interfaceDeclaration(nestedIface, [...outer, name]);
    }
  }

  private field(field: CstNode, cls: JavaClassFact, owner: string[]): void {
    const mods = kidNodes(field, 'fieldModifier');
    const isStatic = mods.some((m) => hasToken(m, 'Static'));
    const isFinal = mods.some((m) => hasToken(m, 'Final'));
    if (isStatic && isFinal) {
      this.constant(field, owner);
      return;
    }
    if (isStatic) return;
    const type = simpleTypeName(kid(field, 'unannType'));
    const full = this.typeText(kid(field, 'unannType'));
    const json = full ? this.jsonField(full, this.annotationsOf(mods)) : undefined;
    if (json && mods.some((m) => hasToken(m, 'Transient'))) json.ignored = true;
    for (const decl of kidNodes(kid(field, 'variableDeclaratorList'), 'variableDeclarator')) {
      const id = directTokens(kid(decl, 'variableDeclaratorId'), 'Identifier')[0];
      if (id && type) cls.fields[id.image] = type;
      if (id && json) (cls.jsonFields ??= {})[id.image] = json;
    }
  }

  private constant(node: CstNode, owner: string[]): void {
    const type = simpleTypeName(kid(node, 'unannType'));
    if (type !== 'String') return;
    for (const decl of kidNodes(kid(node, 'variableDeclaratorList'), 'variableDeclarator')) {
      const id = directTokens(kid(decl, 'variableDeclaratorId'), 'Identifier')[0];
      const init = kid(decl, 'variableInitializer');
      if (!id || !init) continue;
      const expr = this.evalExpr(init);
      // Register under every suffix of the owner chain: `Outer.Inner.NAME`, `Inner.NAME`.
      for (let i = 0; i < owner.length; i++) {
        this.facts.constants[`${owner.slice(i).join('.')}.${id.image}`] = expr;
      }
    }
  }

  private method(node: CstNode, modifierName: string, cls: JavaClassFact): void {
    const annotations = this.annotationsOf(kidNodes(node, modifierName));
    const header = kid(node, 'methodHeader');
    const declarator = kid(header, 'methodDeclarator');
    const nameTok = directTokens(declarator, 'Identifier')[0];
    if (!nameTok) return;
    const mappingAnn = annotations.find((a) => a.name in MAPPING_ANNOTATIONS);
    const returnType = simpleTypeName(kid(header, 'result'));
    if (returnType && SECURITY_CONFIG_TYPES.has(returnType)) this.facts.securityConfig ??= { className: cls.name, pos: tokenPos(nameTok) };
    const params: EndpointParameter[] = [];
    let bodyType: string | undefined;
    let bodyValidated: boolean | undefined;
    /** Local names holding request input, for the risk scan. */
    const requestParams: string[] = [];
    for (const fp of kidNodes(kid(declarator, 'formalParameterList'), 'formalParameter')) {
      const regular = kid(fp, 'variableParaRegularParameter') ?? kid(fp, 'variableArityParameter');
      if (!regular) continue;
      const paramAnns = this.annotationsOf(kidNodes(regular, 'variableModifier'));
      const type = simpleTypeName(kid(regular, 'unannType'));
      const paramName = directTokens(kid(regular, 'variableDeclaratorId'), 'Identifier')[0]?.image ?? directTokens(regular, 'Identifier')[0]?.image;
      if (paramName && paramAnns.some((a) => REQUEST_INPUT_ANNOTATIONS.has(a.name))) requestParams.push(paramName);
      for (const ann of paramAnns) {
        const literal = (key: string): string | undefined => {
          const v = ann.values[key];
          if (!v) return undefined;
          const e = this.evalExpr(v);
          return e.parts.length === 1 && 'lit' in e.parts[0] ? e.parts[0].lit : undefined;
        };
        const explicitName = literal('value') ?? literal('name');
        const requiredFalse = ann.values.required ? tokensOf(ann.values.required).some((t) => t.image === 'false') : false;
        const hasDefault = ann.values.defaultValue !== undefined;
        const name = explicitName ?? paramName;
        if (ann.name === 'RequestBody') {
          bodyType = type ?? 'object';
          if (paramAnns.some((a) => a.name === 'Valid' || a.name === 'Validated')) bodyValidated = true;
        } else if (name && ann.name === 'PathVariable') {
          params.push({ name, in: 'path', required: true, type });
        } else if (name && ann.name === 'RequestParam' && type !== 'Map' && type !== 'MultiValueMap') {
          params.push({ name, in: 'query', required: !requiredFalse && !hasDefault && type !== 'Optional', type });
        } else if (name && ann.name === 'RequestHeader' && type !== 'Map' && type !== 'HttpHeaders') {
          params.push({ name, in: 'header', required: !requiredFalse && !hasDefault && type !== 'Optional', type });
        } else if (name && ann.name === 'CookieValue') {
          params.push({ name, in: 'cookie', required: !requiredFalse && !hasDefault, type });
        }
      }
    }
    const mapping = this.mappingOf(annotations);
    const method: JavaMethodFact = {
      name: nameTok.image,
      pos: mappingAnn ? nodePos(mappingAnn.node) : tokenPos(nameTok),
      mapping,
      security: this.securityOf(annotations),
      params,
      bodyType,
      bodyValidated,
      calls: this.calls(kid(node, 'methodBody'), cls),
    };
    if (mapping || annotations.some((a) => a.name === 'ExceptionHandler')) {
      const returnType = this.typeText(kid(header, 'result'));
      if (returnType && returnType !== 'void') method.returnType = returnType;
      const status = annotations.find((a) => a.name === 'ResponseStatus');
      const code = status ? (status.values.value ?? status.values.code) : undefined;
      const statusName = code ? /HttpStatus\.(\w+)/.exec(this.text(code))?.[1] : undefined;
      if (statusName && HTTP_STATUS[statusName]) method.status = HTTP_STATUS[statusName];
      const body = kid(node, 'methodBody');
      const risks = body ? javaRisks(tokensOf(body), new Set(requestParams)) : [];
      if (risks.length) method.risks = risks;
    }
    cls.methods.push(method);
  }

  /** Finds `field.method(` and `this.field.method(` calls on declared fields. */
  private calls(body: CstNode | undefined, cls: JavaClassFact): ServiceCall[] {
    if (!body) return [];
    const toks = tokensOf(body);
    const out: ServiceCall[] = [];
    const seen = new Set<string>();
    for (let i = 0; i + 3 < toks.length; i++) {
      const [a, dot, b, paren] = [toks[i], toks[i + 1], toks[i + 2], toks[i + 3]];
      if (a.tokenType.name !== 'Identifier' || dot.tokenType.name !== 'Dot' || b.tokenType.name !== 'Identifier' || paren.tokenType.name !== 'LBrace') continue;
      const prev = toks[i - 1];
      if (prev && prev.tokenType.name === 'Dot') {
        const prev2 = toks[i - 2];
        if (!prev2 || prev2.tokenType.name !== 'This') continue;
      }
      const type = own(cls.fields, a.image);
      if (!type) continue;
      const key = `${a.image}.${b.image}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ receiver: a.image, method: b.image, type });
    }
    return out;
  }
}

const REQUEST_BUILDERS: Record<string, HttpMethod> = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', delete: 'DELETE', head: 'HEAD', options: 'OPTIONS' };
const REST_TEMPLATE: Record<string, HttpMethod> = {
  getForObject: 'GET',
  getForEntity: 'GET',
  postForObject: 'POST',
  postForEntity: 'POST',
  postForLocation: 'POST',
  patchForObject: 'PATCH',
  put: 'PUT',
  delete: 'DELETE',
};

/**
 * Test requests in Spring tests: MockMvc `perform(get("/x"))` (static import or
 * `MockMvcRequestBuilders.get`), WebTestClient `.get().uri("/x")` and TestRestTemplate
 * `getForEntity("/x", ...)`. Only URLs built from string literals, constants and `+` are kept.
 */
function findClientCalls(toks: IToken[], staticImports: Record<string, string>): ClientCallFact[] {
  const out: ClientCallFact[] = [];
  const name = (i: number): string | undefined => (toks[i]?.tokenType.name === 'Identifier' ? toks[i].image : undefined);
  const is = (i: number, type: string): boolean => toks[i]?.tokenType.name === type;
  for (let i = 0; i + 2 < toks.length; i++) {
    const id = name(i);
    if (!id || !is(i + 1, 'LBrace')) continue;
    let method: HttpMethod | undefined;
    let client: string | undefined;
    const qualifier = is(i - 1, 'Dot') ? name(i - 2) : undefined;
    if (REQUEST_BUILDERS[id] && (staticImports[id]?.startsWith('MockMvcRequestBuilders.') || '*MockMvcRequestBuilders' in staticImports || qualifier === 'MockMvcRequestBuilders')) {
      method = REQUEST_BUILDERS[id];
      client = 'MockMvc';
    } else if (id === 'uri' && is(i - 1, 'Dot') && is(i - 2, 'RBrace') && is(i - 3, 'LBrace') && REQUEST_BUILDERS[name(i - 4) ?? '']) {
      method = REQUEST_BUILDERS[name(i - 4)!];
      client = 'WebTestClient';
    } else if (REST_TEMPLATE[id] && is(i - 1, 'Dot') && /rest|template|client/i.test(qualifier ?? '')) {
      method = REST_TEMPLATE[id];
      client = 'TestRestTemplate';
    }
    if (!method || !client) continue;
    // URL: tokens up to the first top-level comma or closing parenthesis.
    const parts: PathPart[] = [];
    let j = i + 2;
    let ok = false;
    const start = toks[j];
    let end = toks[j];
    for (; j < toks.length; j++) {
      const tok = toks[j];
      const type = tok.tokenType.name;
      if (type === 'Comma' || type === 'RBrace') {
        ok = parts.length > 0;
        break;
      }
      end = tok;
      if (type === 'StringLiteral') parts.push({ lit: unescapeJavaString(tok.image) });
      else if (/Literal$/.test(type)) parts.push({ lit: tok.image.replace(/[lL]$/, '') });
      else if (type === 'Identifier' || type === 'Dot') {
        if (type === 'Identifier') parts.push({ dynamic: tok.image });
      } else if (type !== 'Plus') break;
    }
    if (!ok || !start || !end) continue;
    out.push({
      client,
      method,
      url: compactExpr({ parts }),
      pos: tokenPos(toks[i]),
      start: tokenPos(start),
      end: { line: end.endLine ?? end.startLine ?? 1, column: (end.endColumn ?? end.startColumn ?? 1) + 1 },
    });
  }
  return out;
}

/** Tokens between the parenthesis at `open` and its match, exclusive. */
function argTokens(toks: IToken[], open: number): IToken[] {
  let depth = 0;
  for (let j = open; j < toks.length; j++) {
    const type = toks[j].tokenType.name;
    if (type === 'LBrace') depth++;
    else if (type === 'RBrace' && --depth === 0) return toks.slice(open + 1, j);
  }
  return [];
}

/**
 * Request input reaching risky sinks in a Spring handler, from tokens: SQL built with `+`,
 * `Runtime.exec`, `redirect:` + input, files opened from input, and exception messages or stack
 * traces returned from catch blocks.
 */
function javaRisks(toks: IToken[], tainted: Set<string>): RiskFact[] {
  const out: RiskFact[] = [];
  const name = (i: number): string | undefined => (toks[i]?.tokenType.name === 'Identifier' ? toks[i].image : undefined);
  const is = (i: number, type: string): boolean => toks[i]?.tokenType.name === type;
  const usesInput = (ts: IToken[]): string | undefined => ts.find((t) => t.tokenType.name === 'Identifier' && tainted.has(t.image))?.image;
  const add = (rule: RiskFact['rule'], at: IToken, evidence: string, detail?: string): void => {
    if (out.length < 16 && !out.some((r) => r.rule === rule && r.pos.line === (at.startLine ?? 1))) out.push({ rule, pos: tokenPos(at), evidence, detail });
  };
  const catchNames: { name: string; start: number; end: number }[] = [];
  for (let i = 0; i < toks.length; i++) {
    const id = name(i);
    // `catch (SomeException e) { … }`
    if (is(i, 'Catch') && is(i + 1, 'LBrace')) {
      const args = argTokens(toks, i + 1);
      const errName = args.length >= 2 ? args[args.length - 1].image : undefined;
      let depth = 0;
      let end = toks.length;
      for (let j = i + 2 + args.length; j < toks.length; j++) {
        if (is(j, 'LCurly')) depth++;
        else if (is(j, 'RCurly') && --depth === 0) {
          end = j;
          break;
        }
      }
      if (errName) catchNames.push({ name: errName, start: i, end });
    }
    if (!id) continue;
    if (is(i + 1, 'LBrace')) {
      const args = argTokens(toks, i + 1);
      const input = tainted.size ? usesInput(args) : undefined;
      if (input && SQL_METHODS.has(id) && is(i - 1, 'Dot') && args.some((t) => t.tokenType.name === 'Plus')) add('injection', toks[i], `${name(i - 2) ?? ''}.${id}("…" + ${input})`, 'sql');
      if (input && id === 'exec' && is(i - 1, 'Dot')) add('injection', toks[i], `exec(${input})`, 'command');
      if (input && id === 'sendRedirect') add('open-redirect', toks[i], `sendRedirect(${input})`);
      if (input && (FILE_CONSTRUCTORS.has(id) && is(i - 1, 'New') || ((id === 'get' && name(i - 2) === 'Paths') || (id === 'of' && name(i - 2) === 'Path')))) add('path-traversal', toks[i], `${id}(${input})`);
      if (id === 'getStackTrace' && name(i - 2) === 'ExceptionUtils') add('error-details', toks[i], 'ExceptionUtils.getStackTrace(…) in a response', 'stack');
    }
  }
  for (let i = 0; i < toks.length; i++) {
    // `"redirect:" + url`
    if (is(i, 'StringLiteral') && /^"redirect:/.test(toks[i].image) && is(i + 1, 'Plus') && name(i + 2) && tainted.has(name(i + 2)!)) add('open-redirect', toks[i], `"redirect:" + ${name(i + 2)}`);
    // `return … e.getMessage() …` inside a catch block.
    if (is(i, 'Return')) {
      const c = catchNames.find((x) => x.start < i && i < x.end);
      if (!c) continue;
      for (let j = i + 1; j < toks.length && !is(j, 'Semicolon'); j++) {
        if (name(j) === c.name && is(j + 1, 'Dot') && (name(j + 2) === 'getMessage' || name(j + 2) === 'getLocalizedMessage' || name(j + 2) === 'toString')) {
          add('error-details', toks[i], `return … ${c.name}.${name(j + 2)}()`, 'message');
          break;
        }
        if (name(j) === c.name && is(j + 1, 'Dot') && name(j + 2) === 'getStackTrace') {
          add('error-details', toks[i], `return … ${c.name}.getStackTrace()`, 'stack');
          break;
        }
      }
    }
  }
  return out;
}
