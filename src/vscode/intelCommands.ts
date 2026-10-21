/**
 * Commands for the API intelligence features: dashboard, impact analysis, contract comparison,
 * security radar, test generation, dependency graph and the full report.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { contractDiffToMarkdown, contractDrift, ContractError, diffContracts, looksLikeOpenApi, parseContract, type ContractDiff } from '../core/contracts';
import type { ContractView } from '../core/dashboardModel';
import { DEFAULT_EXCLUDED_DIRS } from '../core/exclude';
import { gitFileAt, gitRefs, gitRepoRoot } from '../core/gitHost';
import { buildGraph, graphToMermaid } from '../core/graph';
import { toOpenApiPath } from '../core/paths';
import { SECURITY_RULES } from '../core/security';
import { detectNodeSetup, generateTests, nextFreeName, type GeneratedTest, type TestProject } from '../core/testgen';
import type { Endpoint } from '../core/types';
import { toReport } from '../export/report';
import type { AnalysisController } from './analysisController';
import { announceExport, endpointOf, saveTarget, workspaceTitle } from './commands';
import type { Dashboard, DashboardTab } from './dashboard';
import { DASHBOARD_TABS } from './dashboard';
import type { Dismissals } from './dismissals';
import { relativePath, type EndpointTreeNode, type EndpointTreeProvider } from './endpointTree';
import type { ImpactController } from './impactController';
import type { ChannelLogger } from './logger';

export interface IntelDeps {
  context: vscode.ExtensionContext;
  controller: AnalysisController;
  impact: ImpactController;
  dismissals: Dismissals;
  tree: EndpointTreeProvider;
  logger: ChannelLogger;
  dashboard: () => Dashboard;
}

const CONTRACT_GLOBS = ['**/{openapi,swagger,api,api-spec,api-docs,oas}.{json,yaml,yml}', '**/*.{openapi,swagger,oas}.{json,yaml,yml}', '**/{openapi,swagger,specs,spec,contracts}/*.{json,yaml,yml}'];

/** Contract files, test setups and the last contract diff, shared with the dashboard. */
export class IntelState {
  contractFiles: string[] = [];
  lastContract: ContractView | undefined;
  testProjects: { root: string; label: string; kind: 'node' | 'java'; runner: string }[] = [];

  constructor(private readonly controller: AnalysisController) {}

  /** Finds OpenAPI 3 documents (by name, then by content). */
  async findContracts(): Promise<string[]> {
    const exclude = `**/{${DEFAULT_EXCLUDED_DIRS.join(',')}}/**`;
    const globs = [...CONTRACT_GLOBS, ...this.controller.settings.contractFiles];
    const found = new Set<string>();
    for (const glob of globs) {
      for (const uri of await vscode.workspace.findFiles(glob, exclude, 200)) if (uri.scheme === 'file') found.add(uri.fsPath);
    }
    const out: string[] = [];
    for (const file of [...found].sort()) {
      try {
        const head = new TextDecoder().decode((await vscode.workspace.fs.readFile(vscode.Uri.file(file))).subarray(0, 4096));
        if (looksLikeOpenApi(head)) out.push(file);
      } catch {
        // unreadable: skip
      }
    }
    this.contractFiles = out;
    return out;
  }

  /** Test setup per project that has endpoints, for the Test Generator tab. */
  async findTestProjects(): Promise<void> {
    const result = this.controller.current;
    const roots = new Map<string, 'node' | 'java'>();
    for (const e of result?.endpoints ?? []) roots.set(e.projectRoot, e.framework === 'spring' ? 'java' : 'node');
    const out: IntelState['testProjects'] = [];
    for (const [root, kind] of roots) {
      if (kind === 'java') out.push({ root, label: relativePath(root) || path.basename(root), kind, runner: 'junit' });
      else {
        const pkg = await readJson(path.join(root, 'package.json'));
        const setup = detectNodeSetup(pkg, await exists(path.join(root, 'tsconfig.json')));
        out.push({ root, label: relativePath(root) || path.basename(root), kind, runner: setup.runnerMissing ? `${setup.runner} (not installed)` : setup.runner });
      }
    }
    this.testProjects = out;
  }
}

/** Actions the dashboard triggers directly. */
export interface IntelActions {
  compareContract: (file: string) => Promise<unknown>;
  generateTests: (endpointIds: string[], runner?: string) => Promise<unknown>;
}

export function registerIntelCommands(deps: IntelDeps, state: IntelState): IntelActions {
  const { context, controller, impact, dismissals, tree, logger } = deps;
  const reg = (id: string, fn: (...args: never[]) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: never[]) => {
        try {
          return await fn(...args);
        } catch (err) {
          logger.error(err instanceof Error ? err : String(err));
          void vscode.window.showErrorMessage(`API Shadow: ${err instanceof Error ? err.message : String(err)}`);
          return undefined;
        }
      }),
    );
  };
  const showTab = async (tab: DashboardTab, focus?: string): Promise<void> => {
    if (tab === 'contracts') await state.findContracts();
    if (tab === 'tests') await state.findTestProjects();
    deps.dashboard().show(tab, focus);
  };

  reg('apiShadow.showDashboard', async (tab?: string, focus?: string) => {
    const t = typeof tab === 'string' && (DASHBOARD_TABS as readonly string[]).includes(tab) ? (tab as DashboardTab) : undefined;
    if (!controller.current) void controller.refresh(false);
    await showTab(t ?? 'overview', typeof focus === 'string' ? focus : undefined);
  });
  reg('apiShadow.showGraph', () => showTab('graph'));
  reg('apiShadow.runSecurityAnalysis', async () => {
    await controller.refresh(true);
    await showTab('security');
    return controller.current?.security;
  });

  reg('apiShadow.analyzeImpact', async () => {
    if (!controller.settings.impact.enabled) {
      const choice = await vscode.window.showInformationMessage('API Shadow: impact analysis is turned off for this workspace.', 'Turn On');
      if (choice !== 'Turn On') return undefined;
      await vscode.workspace.getConfiguration('apiShadow').update('impact.enabled', true, vscode.ConfigurationTarget.Workspace);
    }
    if (!controller.current) await controller.refresh(false);
    else if (controller.current) await impact.update(controller.current);
    await showTab('impact');
    return impact.report;
  });
  reg('apiShadow.setImpactBaseline', () => impact.chooseBaseline());

  reg('apiShadow.dismissFinding', async (id?: string) => {
    if (typeof id !== 'string' || !id) return;
    await dismissals.add(id);
    void vscode.window.setStatusBarMessage('API Shadow: finding dismissed. Restore it from the Security view or the dashboard.', 4000);
  });
  reg('apiShadow.restoreFinding', async (node?: { type?: string; finding?: { id: string } }) => {
    if (node?.finding?.id) await dismissals.remove(node.finding.id);
  });
  reg('apiShadow.dismissFindingFromTree', async (node?: { type?: string; finding?: { id: string } }) => {
    if (node?.finding?.id) await dismissals.add(node.finding.id);
  });
  reg('apiShadow.restoreDismissedFindings', async () => {
    const n = dismissals.ids.size;
    if (n === 0) return;
    await dismissals.clear();
    void vscode.window.showInformationMessage(`API Shadow: restored ${n} dismissed finding(s).`);
  });
  reg('apiShadow.disableSecurityRule', async (arg?: string) => {
    let rule = typeof arg === 'string' ? arg : undefined;
    if (!rule) {
      const disabled = new Set(controller.settings.security.disabledRules);
      const pick = await vscode.window.showQuickPick(
        Object.values(SECURITY_RULES).filter((r) => !disabled.has(r.id)).map((r) => ({ label: r.title, description: r.id, detail: r.description, id: r.id })),
        { title: 'Turn Off Security Rule', matchOnDescription: true },
      );
      rule = pick?.id;
    }
    if (!rule || !(rule in SECURITY_RULES)) return;
    const title = SECURITY_RULES[rule as keyof typeof SECURITY_RULES].title;
    const choice = await vscode.window.showWarningMessage(`Turn off "${title}" (${rule}) for this workspace?`, { modal: true, detail: 'This adds the rule to apiShadow.security.disabledRules in the workspace settings (.vscode/settings.json).' }, 'Turn Off');
    if (choice !== 'Turn Off') return;
    const config = vscode.workspace.getConfiguration('apiShadow');
    const current = config.get<string[]>('security.disabledRules', []);
    await config.update('security.disabledRules', [...new Set([...current, rule])], vscode.ConfigurationTarget.Workspace);
  });
  reg('apiShadow.enableSecurityRule', async (rule?: string) => {
    if (typeof rule !== 'string') return;
    const config = vscode.workspace.getConfiguration('apiShadow');
    const inspect = config.inspect<string[]>('security.disabledRules');
    const target = inspect?.workspaceFolderValue ? vscode.ConfigurationTarget.WorkspaceFolder : inspect?.workspaceValue ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await config.update('security.disabledRules', config.get<string[]>('security.disabledRules', []).filter((r) => r !== rule), target);
  });

  reg('apiShadow.exportReport', async (target?: vscode.Uri) => {
    const result = controller.current ?? (await controller.refresh(false), controller.current);
    if (!result) return undefined;
    const uri = target instanceof vscode.Uri ? target : await saveTarget('api-shadow-report.md', { Markdown: ['md'] }, 'Export API Shadow Report');
    if (!uri) return undefined;
    const md = toReport(result, { title: `${workspaceTitle()} API report`, relativePath, impact: impact.report, dismissed: dismissals.ids });
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(md));
    logger.info(`Exported report to ${uri.fsPath}`);
    await announceExport(uri, target === undefined);
    return uri;
  });

  reg('apiShadow.exportGraph', async (target?: vscode.Uri, format?: string) => {
    const result = controller.current;
    if (!result) return undefined;
    let kind = format === 'json' || format === 'mermaid' ? format : undefined;
    if (!kind) {
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'Mermaid (Markdown)', description: 'renders on GitHub and in Markdown previews', format: 'mermaid' as const },
          { label: 'JSON', description: 'nodes and edges, for other tools', format: 'json' as const },
        ],
        { title: 'Export Dependency Graph' },
      );
      if (!pick) return undefined;
      kind = pick.format;
    }
    const graph = buildGraph(result, { maxEndpoints: controller.settings.graphMaxEndpoints, impact: impact.report, relativePath });
    const uri = target instanceof vscode.Uri ? target : await saveTarget(kind === 'json' ? 'api-graph.json' : 'api-graph.md', kind === 'json' ? { JSON: ['json'] } : { Markdown: ['md'] }, 'Export Dependency Graph');
    if (!uri) return undefined;
    const content =
      kind === 'json'
        ? JSON.stringify({ ...graph, nodes: graph.nodes.map((n) => ({ ...n, location: n.location ? { file: relativePath(n.location.file), line: n.location.line } : undefined })) }, null, 2) + '\n'
        : `# ${workspaceTitle()} API dependency graph\n\n${graph.endpoints.shown < graph.endpoints.total ? `Showing ${graph.endpoints.shown} of ${graph.endpoints.total} endpoints.\n\n` : ''}\`\`\`mermaid\n${graphToMermaid(graph)}\n\`\`\`\n`;
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
    await announceExport(uri, target === undefined);
    return uri;
  });

  // -------------------------------------------------------------------------------------------
  // Contracts
  // -------------------------------------------------------------------------------------------

  const compareContract = async (file: string, mode?: 'git' | 'two-refs' | 'file' | 'implementation', refs?: [string, string?]): Promise<ContractDiff | undefined> => {
    const text = await readText(file);
    if (text === undefined) throw new Error(`Could not read ${relativePath(file)}.`);
    let chosen = mode;
    if (!chosen) {
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(git-compare) Working tree vs. a git revision', description: 'what changed in this contract', mode: 'git' as const },
          { label: '$(git-branch) Two git revisions', description: 'e.g. main → feature branch', mode: 'two-refs' as const },
          { label: '$(file) Another OpenAPI file…', mode: 'file' as const },
          { label: '$(code) Implementation vs. this contract', description: 'documented operations missing in code, undocumented routes', mode: 'implementation' as const },
        ],
        { title: `Compare ${relativePath(file)}` },
      );
      if (!pick) return undefined;
      chosen = pick.mode;
    }
    let before: string | undefined;
    let after: string | undefined = text;
    let beforeLabel = '';
    let afterLabel = 'working tree';
    if (chosen === 'implementation') {
      const result = controller.current;
      if (!result) return undefined;
      const contract = parse(text, file);
      const implemented = result.endpoints
        .filter((e) => e.pathIsStatic && e.method !== 'ALL')
        .map((e) => ({ method: e.method, path: toOpenApiPath(e.path).path ?? e.path, label: `${e.method} ${e.path}` }));
      const diff = contractDrift(contract, implemented);
      await showContractDiff(diff, relativePath(file), 'implementation', file, false);
      return diff;
    }
    if (chosen === 'file') {
      const other = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { OpenAPI: ['json', 'yaml', 'yml'] }, title: 'Older version of the contract' });
      if (!other?.[0]) return undefined;
      before = await readText(other[0].fsPath);
      beforeLabel = path.basename(other[0].fsPath);
      afterLabel = path.basename(file);
    } else {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showWarningMessage('API Shadow: comparing with a git revision runs git, so it is only available in trusted workspaces.');
        return undefined;
      }
      const repo = await gitRepoRoot(path.dirname(file));
      if (!repo) {
        void vscode.window.showInformationMessage('API Shadow: this contract is not in a git repository. Compare it with another file instead.');
        return undefined;
      }
      const base = refs?.[0] ?? (await pickRef(repo, chosen === 'two-refs' ? 'Older revision (base)' : 'Compare the working tree with…'));
      if (!base) return undefined;
      before = await gitFileAt(repo, base, file);
      beforeLabel = base;
      if (before === undefined) {
        void vscode.window.showInformationMessage(`API Shadow: ${relativePath(file)} does not exist in ${base}; every operation would be new.`);
        return undefined;
      }
      if (chosen === 'two-refs') {
        const head = refs?.[1] ?? (await pickRef(repo, 'Newer revision'));
        if (!head) return undefined;
        after = await gitFileAt(repo, head, file);
        afterLabel = head;
        if (after === undefined) {
          void vscode.window.showInformationMessage(`API Shadow: ${relativePath(file)} does not exist in ${head}.`);
          return undefined;
        }
      }
    }
    if (before === undefined || after === undefined) return undefined;
    const diff = diffContracts(parse(before, `${relativePath(file)} (${beforeLabel})`), parse(after, `${relativePath(file)} (${afterLabel})`));
    await showContractDiff(diff, beforeLabel, afterLabel, file, false);
    return diff;
  };

  const showContractDiff = async (diff: ContractDiff, beforeLabel: string, afterLabel: string, file: string | undefined, bestEffort: boolean): Promise<void> => {
    state.lastContract = {
      title: file ? relativePath(file) : 'Inferred API',
      beforeLabel,
      afterLabel,
      bestEffort,
      counts: diff.counts,
      changes: diff.changes.map((c) => ({ severity: c.severity, operation: c.display, area: c.area, text: c.text })),
      file: file ? relativePath(file) : undefined,
    };
    const md = contractDiffToMarkdown(diff, beforeLabel, afterLabel, file ? relativePath(file) : undefined);
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
    await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
    logger.info(`Contract diff ${beforeLabel} → ${afterLabel}: ${diff.counts.breaking} breaking, ${diff.counts['potentially-breaking']} potentially breaking.`);
    deps.dashboard().refresh();
  };

  reg('apiShadow.compareContracts', async (file?: vscode.Uri | string, mode?: string, base?: string, head?: string) => {
    const files = await state.findContracts();
    let target = file instanceof vscode.Uri ? file.fsPath : typeof file === 'string' ? file : undefined;
    if (!target) {
      if (files.length === 0) {
        const choice = await vscode.window.showInformationMessage(
          'API Shadow: no OpenAPI 3 document was found in the workspace.',
          { detail: 'Add one (openapi.yaml, swagger.json, *.openapi.yaml) or list it in apiShadow.contracts.files. You can also compare the API inferred from code with a branch (best effort).' },
          'Compare Inferred API',
        );
        if (choice) await vscode.commands.executeCommand('apiShadow.compareWithRef');
        return undefined;
      }
      if (files.length === 1) target = files[0];
      else {
        const pick = await vscode.window.showQuickPick(files.map((f) => ({ label: relativePath(f), file: f })), { title: 'Compare which contract?' });
        if (!pick) return undefined;
        target = pick.file;
      }
    }
    const m = mode === 'git' || mode === 'two-refs' || mode === 'file' || mode === 'implementation' ? mode : undefined;
    return compareContract(target, m, base ? [base, head] : undefined);
  });

  // -------------------------------------------------------------------------------------------
  // Test generation
  // -------------------------------------------------------------------------------------------

  const generate = async (endpoints: Endpoint[], runner?: string): Promise<vscode.Uri[]> => {
    const groups = new Map<string, Endpoint[]>();
    for (const e of endpoints) {
      const name = e.framework === 'spring' || e.framework === 'nestjs' ? (e.controller ?? path.basename(e.location.file)) : path.basename(e.location.file).replace(/\.[^.]+$/, '');
      const key = `${e.projectRoot}|${e.framework === 'spring' ? 'java' : 'node'}|${name}`;
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    const generated: GeneratedTest[] = [];
    for (const [key, list] of groups) {
      const [, , name] = key.split('|');
      const project = await testProject(list[0], runner);
      generated.push(generateTests(list, project, name));
    }
    // Preview first: open each file as an unsaved document.
    for (const g of generated) {
      const doc = await vscode.workspace.openTextDocument({ language: g.runner === 'junit' ? 'java' : g.file.endsWith('.ts') ? 'typescript' : 'javascript', content: g.content });
      await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
    }
    const targets: string[] = [];
    for (const g of generated) {
      const target = await nextFreeName(g.file, exists);
      targets.push(target);
      // A Java class must match its file name.
      if (target !== g.file && g.runner === 'junit') {
        const from = path.basename(g.file, '.java');
        g.content = g.content.replace(new RegExp(`\\bclass ${from}\\b`), `class ${path.basename(target, '.java')}`);
      }
    }
    const warnings = [...new Set(generated.flatMap((g) => g.warnings))];
    const detail = [
      ...targets.map((t, i) => `${relativePath(t)}${t !== generated[i].file ? ' (a file with the original name exists; it is not overwritten)' : ''}`),
      ...(warnings.length ? ['', 'Before running them:', ...warnings.map((w) => `• ${w}`)] : []),
      '',
      'The tests are not run.',
    ].join('\n');
    const choice = await vscode.window.showInformationMessage(`Create ${generated.length} test file(s)?`, { modal: true, detail }, 'Create');
    if (choice !== 'Create') return [];
    const written: vscode.Uri[] = [];
    for (let i = 0; i < generated.length; i++) {
      const uri = vscode.Uri.file(targets[i]);
      if (!insideWorkspace(uri)) throw new Error(`Refusing to write outside the workspace: ${targets[i]}`);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(targets[i])));
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(generated[i].content));
      written.push(uri);
      logger.info(`Generated tests: ${targets[i]}`);
    }
    if (written[0]) await vscode.window.showTextDocument(written[0], { preview: false });
    return written;
  };

  const testProject = async (e: Endpoint, runner?: string): Promise<TestProject> => {
    const root = e.projectRoot;
    const configured = controller.settings.testDirectory;
    if (e.framework === 'spring') {
      const info = controller.javaClass(e.location.file, e.controller ?? '');
      const contextNote = e.notes.find((n) => n.startsWith('Context path "'));
      const build = (await readText(path.join(root, 'pom.xml'))) ?? (await readText(path.join(root, 'build.gradle'))) ?? (await readText(path.join(root, 'build.gradle.kts'))) ?? '';
      const version = /<artifactId>spring-boot-starter-parent<\/artifactId>\s*<version>([^<]+)<\/version>/.exec(build)?.[1] ?? /org\.springframework\.boot['"]?\)?\s*version\s*['"]([^'"]+)['"]/.exec(build)?.[1];
      return {
        kind: 'java',
        root,
        testDir: configured ? path.resolve(root, configured) : path.join(root, 'src', 'test', 'java'),
        packageName: info?.packageName ?? '',
        dependencies: info?.fields ?? {},
        springBootVersion: version,
        contextPath: contextNote ? /^Context path "([^"]+)"/.exec(contextNote)?.[1] : undefined,
        security: controller.hasSpringSecurity(root),
      };
    }
    const pkg = await readJson(path.join(root, 'package.json'));
    const setup = detectNodeSetup(pkg, await exists(path.join(root, 'tsconfig.json')));
    if (runner === 'jest' || runner === 'vitest' || runner === 'mocha') {
      setup.runner = runner;
      setup.runnerMissing = !hasDep(pkg, runner);
    }
    let testDir = configured ? path.resolve(root, configured) : undefined;
    if (!testDir) {
      for (const candidate of ['test/api', 'tests/api', '__tests__/api', 'test', 'tests', '__tests__']) {
        if (await exists(path.join(root, candidate))) {
          testDir = path.join(root, candidate);
          break;
        }
      }
    }
    const apps = controller.appModules().filter((a) => a.file.startsWith(root + path.sep));
    const lib = e.framework === 'fastify' || e.framework === 'koa' ? e.framework : 'express';
    const app = apps.find((a) => a.lib === lib) ?? apps[0];
    let nestAppModule: string | undefined;
    if (e.framework === 'nestjs') {
      const found = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/app.module.ts'), '**/node_modules/**', 1);
      nestAppModule = found[0]?.fsPath;
    }
    return { kind: 'node', root, ...setup, testDir: testDir ?? path.join(root, 'tests', 'api'), app: app ? { file: app.file, exportName: app.exportName, lib: app.lib } : undefined, nestAppModule };
  };

  reg('apiShadow.generateTests', async (target?: EndpointTreeNode | Endpoint | string[], runner?: string) => {
    if (!controller.current) await controller.refresh(false);
    const all = controller.current?.endpoints ?? [];
    let endpoints: Endpoint[] = [];
    if (Array.isArray(target)) endpoints = all.filter((e) => target.includes(e.id));
    else {
      const one = endpointOf(target as EndpointTreeNode | Endpoint | undefined);
      if (one) endpoints = [one];
    }
    if (endpoints.length === 0) {
      if (all.length === 0) {
        void vscode.window.showInformationMessage('API Shadow: no endpoints discovered yet.');
        return [];
      }
      const picks = await vscode.window.showQuickPick(
        tree.allEndpoints().map((e) => ({ label: `${e.method} ${e.path}`, description: [e.controller, e.handler].filter(Boolean).join(' · '), detail: `${relativePath(e.location.file)}:${e.location.line}`, endpoint: e })),
        { title: 'Generate API Tests', placeHolder: 'Select the endpoints to generate tests for', canPickMany: true, matchOnDescription: true, matchOnDetail: true },
      );
      if (!picks?.length) return [];
      endpoints = picks.map((p) => p.endpoint);
    }
    return generate(endpoints, typeof runner === 'string' ? runner : undefined);
  });

  return {
    compareContract: (file) => compareContract(file),
    generateTests: async (ids, runner) => vscode.commands.executeCommand('apiShadow.generateTests', ids, runner),
  };
}

function parse(text: string, label: string): ReturnType<typeof parseContract> {
  try {
    return parseContract(text, label);
  } catch (err) {
    if (err instanceof ContractError) throw new Error(err.message);
    throw err;
  }
}

async function pickRef(repo: string, title: string): Promise<string | undefined> {
  const refs = await gitRefs(repo);
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'HEAD', description: 'last commit', iconPath: new vscode.ThemeIcon('git-commit') },
      ...refs.map((r) => ({ label: r.name, description: r.kind, iconPath: new vscode.ThemeIcon(r.kind === 'tag' ? 'tag' : r.kind === 'remote' ? 'cloud' : 'git-branch') })),
    ],
    { title, placeHolder: 'Choose a branch, tag or commit' },
  );
  return pick?.label;
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(file)));
  } catch {
    return undefined;
  }
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  const text = await readText(file);
  if (!text) return undefined;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(file));
    return true;
  } catch {
    return false;
  }
}

function hasDep(pkg: Record<string, unknown> | undefined, name: string): boolean {
  const deps = { ...((pkg?.dependencies as object) ?? {}), ...((pkg?.devDependencies as object) ?? {}) };
  return Object.prototype.hasOwnProperty.call(deps, name);
}

function insideWorkspace(uri: vscode.Uri): boolean {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return false;
  const rel = path.relative(folder.uri.fsPath, uri.fsPath);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
