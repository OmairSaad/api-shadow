/**
 * Links response reads across files. A page calls `getUser()` from a service module, the service
 * calls `axios.get('/api/users/:id')` and returns `data`; the page reads `user.name`. The read is
 * attached to the axios call (and so to the endpoint it matches), with the page as its consumer.
 */
import type { ClientCallFact, ConsumerCallFact, JsFileFacts, ReadFact } from '../analyzers/facts';
import type { ExpressLinker } from '../linkers/expressLinker';
import { loc } from '../linkers/context';
import { own } from './records';
import type { ClientCall, ResponseConsumer, ResponseRead } from './types';

const MAX_DEPTH = 6;
const MAX_READS_PER_CALL = 300;

export interface ConsumerInput {
  file: string;
  fact: ClientCallFact;
}

/** Fills `reads` and `consumers` of each call; `inputs[i]` produced `calls[i]`. */
export function linkConsumers(inputs: ConsumerInput[], calls: ClientCall[], facts: ReadonlyMap<string, JsFileFacts>, resolver: ExpressLinker): void {
  const byFact = new Map<ClientCallFact, ClientCall>();
  inputs.forEach((input, i) => byFact.set(input.fact, calls[i]));
  for (const input of inputs) {
    const call = byFact.get(input.fact)!;
    const reads: ResponseRead[] = [];
    for (const r of input.fact.reads ?? []) {
      const path = unwrapClient(input.fact, r.path);
      if (path) reads.push({ path, location: loc(input.file, r.pos), within: r.within ?? input.fact.within });
    }
    if (reads.length) call.reads = reads;
    if (input.fact.within) call.within = input.fact.within;
  }
  for (const [file, f] of facts) {
    for (const consumer of f.consumers ?? []) {
      const target = resolver.resolve(file, consumer.callee);
      if (target?.t !== 'fn') continue;
      const reads = consumer.reads.map((r) => ({ raw: r.path, read: r }));
      const via = calleeLabel(consumer);
      follow(target.file, target.key, reads, 0, (callFile, idx, paths) => {
        const fact = facts.get(callFile)?.clientCalls[idx];
        const call = fact ? byFact.get(fact) : undefined;
        if (!call) return;
        const consumerRef: ResponseConsumer = { within: consumer.within, callee: via, location: loc(file, consumer.pos) };
        call.consumers = [...(call.consumers ?? []), consumerRef];
        if (paths.length === 0) return;
        const list = call.reads ?? [];
        for (const { path: raw, read } of paths) {
          if (list.length >= MAX_READS_PER_CALL) break;
          const path = fact ? unwrapClient(fact, raw) : raw;
          if (path) list.push({ path, location: loc(file, read.pos), within: read.within ?? consumer.within, indirect: true });
        }
        call.reads = list;
      });
    }
  }

  /**
   * Walks from a function that returns (part of) a response to the client call it came from,
   * rewriting each read path from "relative to the returned value" to "relative to the body".
   */
  function follow(
    file: string,
    key: string,
    reads: { raw: string; read: ReadFact }[],
    depth: number,
    done: (file: string, callIndex: number, paths: { path: string; read: ReadFact }[]) => void,
  ): void {
    if (depth > MAX_DEPTH) return;
    const f = facts.get(file);
    const rb = own(f?.callables, key)?.returnsBody;
    if (!f || !rb) return;
    const join = (a: string, b: string): string => (a && b ? `${a}.${b}` : a || b);
    const relative = reads.map((r) => ({ ...r, raw: join(rb.path, r.raw) }));
    if (rb.call !== undefined) {
      const paths: { path: string; read: ReadFact }[] = [];
      for (const r of relative) {
        const body = toBody(rb.stage, r.raw);
        if (body !== undefined && body !== '') paths.push({ path: body, read: r.read });
      }
      if (rb.stage !== 'fetch') done(file, rb.call, paths);
      return;
    }
    const inner = rb.consumer !== undefined ? f.consumers[rb.consumer] : undefined;
    if (!inner) return;
    const target = resolver.resolve(file, inner.callee);
    if (target?.t !== 'fn') return;
    // The returned value is the inner call's raw result, possibly unwrapped: `return (await getUser()).data`.
    follow(target.file, target.key, relative, depth + 1, done);
  }
}

/**
 * Imported API clients (`api.get(…)` from `./api`) may be axios instances or wrappers that
 * already unwrap the body. Paths through `data` are taken as axios; others as the body itself.
 */
function unwrapClient(fact: ClientCallFact, path: string): string | undefined {
  if (!fact.unknownBase) return path;
  if (path === 'data') return undefined;
  return path.startsWith('data.') ? path.slice(5) : path;
}

/** Converts a path relative to a returned value of the given stage into a body path. */
function toBody(stage: string, raw: string): string | undefined {
  const [head, ...rest] = raw.split('.');
  switch (stage) {
    case 'body':
      return raw;
    case 'axios':
      return head === 'data' ? rest.join('.') : undefined;
    case 'agent':
      return head === 'body' ? rest.join('.') : undefined;
    case 'raw':
      return raw;
    default:
      return undefined;
  }
}

function calleeLabel(c: ConsumerCallFact): string {
  if (c.callee.k !== 'import') return 'function';
  const base = c.callee.name === 'default' || c.callee.name === '*' || c.callee.name === '*cjs' ? c.callee.source.split('/').pop()! : c.callee.name;
  return c.callee.member ? `${base}.${c.callee.member}` : base;
}
