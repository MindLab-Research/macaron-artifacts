import type { ChatChunk } from '../../shared/types.js';
import type { HarnessAdapter, HarnessTurn } from './types.js';
import { abortable, abortError, EventQueue, executableVersion, record, safeError, string } from './common.js';
import { OpenCodeEventMapper } from './opencode-events.js';
import { startOpenCode, type OpenCodeConnection, type OpenCodePrompt } from './opencode-server.js';

export function openCodeModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf('/');
  if (slash < 1 || slash === model.length - 1) throw new Error('OpenCode models use provider/model format');
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

export async function* runOpenCodeConnection(turn: HarnessTurn, connection: OpenCodeConnection): AsyncGenerator<ChatChunk> {
  const queue = new EventQueue<ChatChunk>(), mapper = new OpenCodeEventMapper(), controller = new AbortController();
  const signal = AbortSignal.any([turn.signal, controller.signal]);
  let nativeID = '', started = false, terminal = false, active = false, resolveReady!: () => void, resolveDone!: () => void, rejectDone!: (error: unknown) => void;
  const assistantIDs = new Set<string>();
  let overflow: { error: Error; precedingIDs: Set<string> } | undefined;
  let pump: Promise<void> | undefined;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  void done.catch(() => {});
  const fail = (error: unknown) => { rejectDone(error); queue.fail(error); };
  const abort = () => fail(abortError());
  turn.signal.addEventListener('abort', abort, { once: true });
  const producer = (async () => {
    if (signal.aborted) throw abortError();
    if (turn.enrichment && !turn.nativeId) throw new Error('Metadata generation requires a completed native OpenCode session');
    const original = turn.nativeId ? await connection.getSession(turn.nativeId, signal) : undefined;
    const session = turn.enrichment ? await connection.forkSession(turn.nativeId!, signal) : original ?? await connection.createSession(signal);
    nativeID = session.id;
    if (!nativeID) throw new Error('OpenCode did not return a native session id');
    if (turn.enrichment) {
      if (nativeID === turn.nativeId) { nativeID = ''; throw new Error('OpenCode failed to create an isolated metadata fork'); }
      await connection.blockTools(nativeID);
      // Native fork copies messages but drops session permissions; restore them without filtering tools.
      if (original?.permission) await connection.copyPermissions(nativeID, original.permission, signal);
    } else turn.onNativeSession(nativeID);
    pump = (async () => {
      for await (const raw of connection.events(signal)) {
        const event = record(raw), properties = record(event.properties);
        if (event.type === 'server.connected') { resolveReady(); continue; }
        const eventSessionID = properties.sessionID ?? record(properties.info).sessionID ?? record(properties.part).sessionID;
        if (!started || eventSessionID !== nativeID) continue;
        if (event.type === 'session.status' && record(properties.status).type !== 'idle') active = true;
        const info = record(properties.info), assistant = event.type === 'message.updated' && info.role === 'assistant';
        if (assistant) { active = true; assistantIDs.add(string(info.id)); }
        if (event.type === 'permission.asked') {
          const approved = !turn.enrichment && await abortable(turn.approve({ id: string(properties.id), tool: string(properties.permission), input: properties }), signal);
          await connection.replyPermission(string(properties.id), approved, signal);
        } else if (event.type === 'question.asked') {
          // The shared approval surface cannot answer free-form native questionnaires.
          await connection.rejectQuestion(string(properties.id), signal);
        }
        const nativeError = event.type === 'session.error' ? properties.error : assistant ? info.error : undefined;
        if (nativeError || event.type === 'session.error') {
          const error = new Error(safeError(record(record(nativeError).data).message || record(nativeError).name || 'OpenCode turn failed'));
          if (record(nativeError).name !== 'ContextOverflowError') throw error;
          // Overflow also announces automatic compaction. The failed message's final snapshot and a compaction summary are not recovery.
          active = true;
          if (!overflow || !assistant || !overflow.precedingIDs.has(string(info.id))) overflow = { error, precedingIDs: new Set(assistantIDs) };
        } else if (overflow && assistant && !overflow.precedingIDs.has(string(info.id)) && !info.summary && record(info.time).completed !== undefined && info.finish && info.finish !== 'error') overflow = undefined;
        const mapped = assistant && record(info.error).name === 'ContextOverflowError' ? { ...event, properties: { ...properties, info: { ...info, error: undefined } } } : raw;
        for (const chunk of mapper.map(mapped)) queue.push(chunk);
        if (active && (event.type === 'session.idle' || (event.type === 'session.status' && record(properties.status).type === 'idle'))) {
          terminal = true;
          for (const chunk of mapper.finish()) queue.push(chunk);
          if (overflow) throw overflow.error;
          resolveDone();
          return;
        }
      }
      if (!terminal && !signal.aborted) throw new Error('OpenCode event stream ended before the turn completed');
    })();
    void pump.catch(fail);
    await abortable(Promise.race([ready, done]), signal);
    const defaults = turn.profile && !turn.enrichment && !turn.retry ? await connection.defaults(signal) : undefined;
    const selected = turn.profile?.config, model = turn.model || selected?.model || defaults?.model;
    const selectedModel = model ? openCodeModel(model) : original?.model ? { providerID: original.model.providerID, modelID: original.model.id } : undefined;
    const agent = selected?.agent || defaults?.agent || original?.agent;
    // A previous model's variant can be invalid for the newly selected model.
    const sameModel = selectedModel?.providerID === original?.model?.providerID && selectedModel?.modelID === original?.model?.id;
    const variant = selected?.variant || (defaults ? defaults.variant ?? '' : sameModel ? original?.model?.variant : undefined);
    const prompt: OpenCodePrompt = { system: turn.instructions, parts: [{ type: 'text', text: turn.prompt }], ...(selectedModel ? { model: selectedModel } : {}), ...(agent ? { agent } : {}), ...(variant !== undefined ? { variant } : {}) };
    started = true;
    if (turn.retry) await connection.retry(nativeID, turn.messageId, turn.prompt, signal); else await connection.prompt(nativeID, prompt, signal);
    await abortable(done, signal);
  })();
  void producer.then(() => queue.end(), fail);
  try { yield* queue; }
  finally {
    turn.signal.removeEventListener('abort', abort);
    if (nativeID && started && !terminal) await connection.abort(nativeID, AbortSignal.timeout(2000)).catch(() => {});
    controller.abort();
    rejectDone(abortError());
    await producer.catch(() => {});
    await pump?.catch(() => {});
    try { if (turn.enrichment && nativeID) await connection.deleteSession(nativeID, AbortSignal.timeout(2000)); }
    finally { await connection.close(); }
  }
}

export const openCodeAdapter: HarnessAdapter = {
  id: 'opencode',
  async info() {
    const version = await executableVersion(process.env.MACARON_OPENCODE_PATH || 'opencode');
    return { id: 'opencode', name: 'OpenCode', available: Boolean(version), detail: version || 'Install the OpenCode CLI', capabilities: { textDeltas: true, reasoningDeltas: true, toolInputDeltas: false, commandOutputDeltas: false, approvals: true, fork: true } };
  },
  async profileOptions(cwd, profile) {
    const signal = AbortSignal.timeout(20_000), connection = await startOpenCode(cwd, signal, profile);
    try { return await connection.profileOptions(signal); } finally { await connection.close(); }
  },
  async *run(turn) { yield* runOpenCodeConnection(turn, await startOpenCode(turn.cwd, turn.signal, turn.profile, turn.model)); },
};
