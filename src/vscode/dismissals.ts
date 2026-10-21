import * as vscode from 'vscode';

const KEY = 'apiShadow.dismissed';
const MAX = 5000;

/**
 * Findings the user dismissed in this workspace (security findings and impact warnings), by
 * stable id. Stored in workspace state, never in settings or the repository.
 */
export class Dismissals implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private set: Set<string>;

  constructor(private readonly state: vscode.Memento) {
    const stored = state.get<unknown>(KEY);
    this.set = new Set(Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : []);
  }

  get ids(): ReadonlySet<string> {
    return this.set;
  }

  has(id: string): boolean {
    return this.set.has(id);
  }

  async add(id: string): Promise<void> {
    if (this.set.has(id)) return;
    this.set.add(id);
    while (this.set.size > MAX) this.set.delete(this.set.values().next().value as string);
    await this.save();
  }

  async remove(id: string): Promise<void> {
    if (this.set.delete(id)) await this.save();
  }

  async clear(): Promise<void> {
    this.set.clear();
    await this.save();
  }

  private async save(): Promise<void> {
    await this.state.update(KEY, [...this.set]);
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Id of one impact warning: the change and the read it affects (by file and field, not line). */
export function impactId(endpointKey: string, change: string, file: string, readPath: string): string {
  let h = 0x811c9dc5;
  const input = `impact|${endpointKey}|${change}|${file}|${readPath}`;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `impact:${(h >>> 0).toString(16)}`;
}
