import { createHash } from 'node:crypto';
import type { FormInfo1, FormAnswer1 } from '@opencode/client';
import type { ChatChunk } from '../../shared/types.js';
import type { Question } from '../../shared/questions.js';
import type { HarnessAdapter, HarnessTurn } from './types.js';
import { abortable, abortError, EventQueue, record, string } from './common.js';
import { openCodeBinary } from './opencode-binary.js';
import { OpenCodeV2EventMapper, openCodeV2Error } from './opencode-v2-events.js';
import { openCodeV2Model, startOpenCodeV2, type OpenCodeV2Connection } from './opencode-v2-server.js';

/** App message IDs and native IDs occupy different namespaces. Stable across retries/restarts. */
export function openCodeV2MessageID(appID: string): string {
  return `msg_${createHash('sha256').update(appID).digest('hex')}`;
}

/** Project native question forms into the existing question UI; never silently answer hidden/external fields. */
export function openCodeV2Questions(form: FormInfo1): Question[] {
  return form.fields.map(field => {
    if (field.type === 'external' || field.hidden || field.when?.length) throw new Error('This OpenCode v2 form requires the native UI (external or conditional fields)');
    const options = 'options' in field ? field.options || [] : [];
    return { id: field.key, question: field.description || field.title || field.key, header: field.title || form.title, options: field.type === 'boolean' ? [{ label: 'true' }, { label: 'false' }] : options.map(option => ({ label: option.label, description: option.description })), multiple: field.type === 'multiselect', custom: field.type === 'boolean' ? false : !options.length || ('custom' in field && field.custom !== false), ...('placeholder' in field ? { placeholder: field.placeholder } : {}) };
  });
}

export function openCodeV2Answers(form: FormInfo1, answers: Record<string, string[]>): FormAnswer1 {
  return Object.fromEntries(form.fields.map(field => {
    const selected = answers[field.key];
    if (!selected?.length) throw new Error(`Missing answer for ${field.key}`);
    const options = 'options' in field ? field.options || [] : [];
    const values = selected.map(value => options.find(option => option.label === value)?.value ?? value);
    if (field.type === 'multiselect') return [field.key, values];
    if (field.type === 'boolean') { if (!['true', 'false'].includes(values[0])) throw new Error('Invalid boolean answer'); return [field.key, values[0] === 'true']; }
    if (field.type === 'number' || field.type === 'integer') {
      const value = Number(values[0]);
      if (!Number.isFinite(value) || (field.type === 'integer' && !Number.isInteger(value)) || (field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum)) throw new Error('Invalid numeric answer');
      return [field.key, value];
    }
    return [field.key, values[0]];
  }));
}

export async function* runOpenCodeV2Connection(turn: HarnessTurn, connection: OpenCodeV2Connection): AsyncGenerator<ChatChunk> {
  const { client, options } = connection, queue = new EventQueue<ChatChunk>(), mapper = new OpenCodeV2EventMapper(), controller = new AbortController();
  const signal = AbortSignal.any([turn.signal, controller.signal]);
  let nativeID = '', started = false, terminal = false, pump: Promise<void> | undefined;
  const ready = Promise.withResolvers<void>(), done = Promise.withResolvers<void>();
  void ready.promise.catch(() => {}); void done.promise.catch(() => {});
  const pending = new Map<string, AbortController>(), replies = new Set<Promise<void>>();
  const fail = (error: unknown) => { ready.reject(error); done.reject(error); queue.fail(error); };
  const abort = () => fail(abortError());
  turn.signal.addEventListener('abort', abort, { once: true });
  const producer = (async () => {
    if (signal.aborted) throw abortError();
    if (turn.enrichment && !turn.nativeId) throw new Error('Metadata generation requires a completed native OpenCode v2 session');
    const original = turn.nativeId ? await client.session.get({ sessionID: turn.nativeId }, options(signal)) : undefined;
    const session = turn.enrichment ? await client.session.fork({ sessionID: turn.nativeId! }, options(signal)) : original ?? await client.session.create({ title: 'Macaron Artifacts', location: { directory: turn.cwd } }, options(signal));
    nativeID = session.id;
    if (turn.enrichment) {
      if (nativeID === turn.nativeId) { nativeID = ''; throw new Error('OpenCode v2 failed to create an isolated metadata fork'); }
      if (session.fork?.sessionID !== turn.nativeId) throw new Error('OpenCode v2 fork has no matching parent');
      if (original?.permissions) await client.session.update({ sessionID: nativeID, permissions: original.permissions }, options(signal));
    } else turn.onNativeSession(nativeID);
    await connection.guard(nativeID, turn.instructions, turn.enrichment ? turn.nativeId : undefined);
    if (!turn.enrichment && !turn.retry) {
      const defaults = turn.profile ? await connection.defaults(signal) : undefined, selected = turn.profile?.config;
      const model = turn.model || selected?.model;
      const desired = model ? openCodeV2Model(model) : defaults?.model || original?.model;
      const agent = selected?.agent || defaults?.agent;
      if (agent && agent !== session.agent) await client.session.switchAgent({ sessionID: nativeID, agent }, options(signal));
      if (desired) {
        const same = desired.providerID === original?.model?.providerID && desired.id === original?.model?.id;
        const variant = selected?.variant || (defaults ? defaults.model?.variant : same ? original?.model?.variant : undefined);
        await client.session.switchModel({ sessionID: nativeID, model: { providerID: desired.providerID, id: desired.id, ...(variant ? { variant } : {}) } }, options(signal));
      }
    }
    const reply = (id: string, action: (signal: AbortSignal) => Promise<void>) => {
      if (pending.has(id)) return;
      const local = new AbortController(); pending.set(id, local);
      const work = action(AbortSignal.any([signal, local.signal])); replies.add(work);
      void work.catch(error => { if (!signal.aborted && !local.signal.aborted && !terminal) fail(error); }).finally(() => { replies.delete(work); if (pending.get(id) === local) pending.delete(id); });
    };
    pump = (async () => {
      for await (const event of client.event.subscribe(options(signal))) {
        if (event.type === 'server.connected') { ready.resolve(); continue; }
        const data = record(record(event).data), form = record(data.form);
        if (!started || (data.sessionID ?? form.sessionID) !== nativeID) continue;
        if (event.type === 'permission.asked') reply(`permission:${string(data.id)}`, async local => {
          const approved = !turn.enrichment && await abortable(turn.approve({ id: string(data.id), tool: string(data.action), input: data }), local);
          if (!local.aborted) await client.permission.reply({ sessionID: nativeID, requestID: string(data.id), decision: approved ? 'once' : 'reject' }, options(local));
        });
        else if (event.type === 'form.created') reply(`form:${string(form.id)}`, async local => {
          const info = event.data.form;
          const response = turn.enrichment ? { cancelled: true } as const : await abortable(turn.ask({ questions: openCodeV2Questions(info) }, local), local);
          if (local.aborted) return;
          if ('answers' in response) await client.session.form.reply({ sessionID: nativeID, formID: info.id, answer: openCodeV2Answers(info, response.answers) }, options(local));
          else await client.session.form.cancel({ sessionID: nativeID, formID: info.id }, options(local));
        });
        else if (event.type === 'form.replied' || event.type === 'form.cancelled') pending.get(`form:${string(data.id)}`)?.abort();
        else if (event.type === 'permission.replied') pending.get(`permission:${string(data.requestID)}`)?.abort();
        for (const chunk of mapper.map(event)) queue.push(chunk);
        if (event.type === 'session.execution.failed') { terminal = true; throw new Error(openCodeV2Error(data.error)); }
        if (event.type === 'session.execution.interrupted') { terminal = true; throw abortError(); }
        if (event.type === 'session.execution.succeeded') { terminal = true; for (const chunk of mapper.finish()) queue.push(chunk); done.resolve(); return; }
      }
      if (!terminal && !signal.aborted) throw new Error('OpenCode v2 event stream ended before the turn completed');
    })();
    void pump.catch(fail);
    await abortable(ready.promise, signal);
    started = true;
    await client.session.prompt({ sessionID: nativeID, text: turn.prompt, ...(turn.messageId ? { id: openCodeV2MessageID(turn.messageId) } : {}), ...(turn.retry ? { resume: true } : {}) }, options(signal));
    await abortable(done.promise, signal);
  })();
  void producer.then(() => queue.end(), fail);
  try { yield* queue; }
  finally {
    turn.signal.removeEventListener('abort', abort);
    if (nativeID && started && !terminal) await client.session.interrupt({ sessionID: nativeID }, options(AbortSignal.timeout(2000))).catch(() => {});
    controller.abort(); done.reject(abortError()); ready.reject(abortError());
    for (const local of pending.values()) local.abort();
    await producer.catch(() => {}); await pump?.catch(() => {}); await Promise.allSettled(replies);
    try { if (turn.enrichment && nativeID) await client.session.remove({ sessionID: nativeID }, options(AbortSignal.timeout(2000))); }
    finally { await connection.close(); }
  }
}

export const openCodeV2Adapter: HarnessAdapter = {
  id: 'opencode-v2',
  async info() {
    const result = await openCodeBinary(2);
    return { id: 'opencode-v2', name: 'OpenCode v2', available: result.available, detail: result.detail, capabilities: { textDeltas: true, reasoningDeltas: true, toolInputDeltas: true, commandOutputDeltas: false, approvals: true, fork: true } };
  },
  async profileOptions(cwd, profile) {
    const signal = AbortSignal.timeout(20000), connection = await startOpenCodeV2(cwd, signal, profile);
    try { return await connection.profileOptions(signal); } finally { await connection.close(); }
  },
  async *run(turn) { yield* runOpenCodeV2Connection(turn, await startOpenCodeV2(turn.cwd, turn.signal, turn.profile, turn.model)); },
};
