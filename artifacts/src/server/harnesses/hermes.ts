import type { ChatChunk } from '../../shared/types.js';
import type { HarnessAdapter, HarnessTurn, ResolvedProfile } from './types.js';
import type { ProfileOptions } from '../../shared/profiles.js';
import { abortError, executableVersion, record, safeError, string, EventQueue, abortable } from './common.js';
import { HermesRpc, rpcPayload } from './hermes-server.js';

type NativeRef = { sessionId: string; storedId?: string; profile?: string };
const encode = (value: NativeRef) => `hermes:${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
const decode = (value: string): NativeRef => { if (!value.startsWith('hermes:')) return { sessionId: value }; try { return JSON.parse(Buffer.from(value.slice(7), 'base64url').toString('utf8')) as NativeRef; } catch { return { sessionId: value }; } };
const gatewayUrl = (profile: HarnessTurn['profile']) => profile?.config.gatewayUrl || process.env.MACARON_HERMES_URL;
const profileName = (profile: HarnessTurn['profile']) => profile?.config.nativeProfile;
const connections = new Map<string, HermesRpc>();
const connectionKey = (turn: HarnessTurn) => `${turn.cwd}\0${gatewayUrl(turn.profile) || 'managed'}\0${profileName(turn.profile) || ''}`;
const connectionFor = (turn: Pick<HarnessTurn, 'cwd' | 'profile'>, token?: string) => {
  const key = connectionKey(turn as HarnessTurn), existing = connections.get(key);
  if (existing) return existing;
  const rpc = new HermesRpc({ cwd: turn.cwd, binary: process.env.MACARON_HERMES_PATH || 'hermes', profile: profileName(turn.profile), token, url: gatewayUrl(turn.profile), secrets: token ? [token] : [], onFailure: () => { if (connections.get(key) === rpc) connections.delete(key); } });
  connections.set(key, rpc); return rpc;
};
export async function closeHermesConnections() { const values = [...connections.values()]; connections.clear(); await Promise.allSettled(values.map(value => value.close())); }

function assertSupported(profile: HarnessTurn['profile']) {
  if (profile?.config.baseUrl || profile?.apiKey) throw new Error('Hermes uses its own profile/provider credentials; base URL and API-key overrides are not supported by the native gateway adapter');
}

export const hermesAdapter: HarnessAdapter = {
  id: 'hermes' as HarnessAdapter['id'],
  async info() { const version = await executableVersion(process.env.MACARON_HERMES_PATH || 'hermes'); return { id: 'hermes' as HarnessAdapter['id'], name: 'Hermes', available: Boolean(version), detail: version || 'Install Hermes Agent', capabilities: { textDeltas: true, reasoningDeltas: true, toolInputDeltas: false, commandOutputDeltas: false, approvals: true, fork: false } }; },
  async profileOptions(cwd: string, profile?: ResolvedProfile): Promise<ProfileOptions> {
    const rpc = connectionFor({ cwd, profile });
    const payload = rpcPayload(await rpc.request('model.options', { explicit_only: true }, AbortSignal.timeout(15_000)));
    const models = [] as ProfileOptions['models'];
    for (const row of Array.isArray(payload.providers) ? payload.providers : []) {
      const provider = record(row), slug = string(provider.slug), name = string(provider.name) || slug;
      for (const model of Array.isArray(provider.models) ? provider.models : []) { const id = string(model); if (id) models.push({ id: slug ? `${slug}/${id}` : id, name: `${name} · ${id}`, provider: slug }); }
    }
    return { models, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] };
  },
  async *run(turn: HarnessTurn): AsyncGenerator<ChatChunk> {
    if (turn.signal.aborted) throw abortError(); assertSupported(turn.profile);
    const ref = turn.nativeId ? decode(turn.nativeId) : undefined;
    if (ref?.profile && ref.profile !== profileName(turn.profile)) throw new Error('Hermes session belongs to a different native profile; start a new session before switching Hermes profiles');
    const token = turn.profile?.authToken;
    const rpc = connectionFor(turn, token);
    let nativeId = ref?.sessionId || '', storedId = ref?.storedId, activeTurn = false, done = false, textStarted = false, thoughtId = '', thoughtSequence = 0, streamed = false, metadataText = '', resolveDone!: () => void, rejectDone!: (error: Error) => void;
    const completed = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    void completed.catch(() => {});
    const queue = new EventQueue<ChatChunk>();
    const push = (items: ChatChunk[]) => { for (const item of items) queue.push(item); };
    // Preserve the tool/text boundary when the next native thinking delta starts a new segment.
    const endThought = () => { if (thoughtId) { push([{ type: 'reasoning-end', id: thoughtId }]); thoughtId = ''; } };
    const fail = (error: Error) => { queue.fail(error); rejectDone(error); };
    const unsub = rpc.onEvent(event => {
      const type = string(event.type), sid = string(event.session_id), payload = record(event.payload);
      if (nativeId && sid && sid !== nativeId) return;
      if (turn.enrichment && type === 'btw.complete') { metadataText += string(payload.text); if (metadataText) push([{ type: 'text-start', id: 'hermes-metadata' }, { type: 'text-delta', id: 'hermes-metadata', delta: metadataText }, { type: 'text-end', id: 'hermes-metadata' }]); done = true; queue.end(); resolveDone(); return; }
      if (turn.enrichment) return;
      if (!activeTurn) return;
      if (type === 'message.start') { push([]); return; }
      if (type === 'message.delta') { const text = string(payload.text); if (text) endThought(); if (text && !textStarted) { textStarted = true; push([{ type: 'text-start', id: 'hermes-message' }]); } if (text) { streamed = true; push([{ type: 'text-delta', id: 'hermes-message', delta: text }]); } }
      else if (type === 'reasoning.delta' || type === 'thinking.delta') { const text = string(payload.text); if (text && !thoughtId) { thoughtId = `hermes-reasoning-${++thoughtSequence}`; push([{ type: 'reasoning-start', id: thoughtId }]); } if (text) push([{ type: 'reasoning-delta', id: thoughtId, delta: text }]); }
      else if (type === 'tool.start') { endThought(); push([{ type: 'tool-input-available', toolCallId: string(payload.tool_id), toolName: string(payload.name), input: payload.args ?? {}, dynamic: true, providerExecuted: true }]); }
      else if (type === 'tool.complete') { const id = string(payload.tool_id); push([{ type: 'tool-output-available', toolCallId: id, output: payload.result ?? payload.result_text ?? '', dynamic: true, providerExecuted: true }]); }
      else if (type === 'message.complete') { endThought(); const text = string(payload.text); if (!streamed && text) { textStarted = true; push([{ type: 'text-start', id: 'hermes-message' }, { type: 'text-delta', id: 'hermes-message', delta: text }]); } if (textStarted) push([{ type: 'text-end', id: 'hermes-message' }]); done = true; queue.end(); resolveDone(); }
      else if (type === 'error' || type === 'connection.error') fail(new Error(string(payload.message) || 'Hermes turn failed'));
      else if (type === 'approval.request') {
        void abortable(turn.approve({ id: string(payload.request_id), tool: 'terminal', input: payload }), turn.signal)
          .then(approved => rpc.request('approval.respond', { session_id: nativeId, request_id: payload.request_id, choice: approved ? 'once' : 'deny' }))
          .catch(error => fail(error instanceof Error ? error : new Error(String(error))));
      }
    });
    const abort = () => { if (!turn.enrichment) void rpc.request('session.interrupt', { session_id: nativeId }).catch(() => {}); fail(abortError()); };
    turn.signal.addEventListener('abort', abort, { once: true });
    try {
      if (turn.enrichment) {
        if (!nativeId) throw new Error('Hermes metadata generation requires a completed native session');
        activeTurn = true;
        await rpc.request('prompt.btw', { session_id: nativeId, text: turn.prompt }, turn.signal);
      } else {
        if (!nativeId) {
          const seed = turn.instructions ? [{ role: 'system', content: turn.instructions, display_kind: 'hidden' }] : [];
          const result = rpcPayload(await rpc.request('session.create', { cwd: turn.cwd, messages: seed, ...(turn.model ? { model: turn.model } : {}), ...(turn.profile?.config.effort ? { reasoning_effort: turn.profile.config.effort } : {}) }, turn.signal));
          nativeId = string(result.session_id); storedId = string(result.stored_session_id) || nativeId; if (!nativeId) throw new Error('Hermes did not return a session id'); turn.onNativeSession(encode({ sessionId: nativeId, storedId, profile: profileName(turn.profile) }));
        } else { const resumed = rpcPayload(await rpc.request('session.resume', { session_id: storedId || nativeId, omit_messages: true }, turn.signal)); nativeId = string(resumed.session_id) || nativeId; storedId = storedId || string(resumed.stored_session_id) || nativeId; turn.onNativeSession(encode({ sessionId: nativeId, storedId, profile: profileName(turn.profile) })); }
        if (turn.model) await rpc.request('config.set', { session_id: nativeId, key: 'model', value: `${turn.model} --session` }, turn.signal);
        if (turn.profile?.config.effort) await rpc.request('config.set', { session_id: nativeId, key: 'reasoning', value: `${turn.profile.config.effort} --session` }, turn.signal);
        activeTurn = true; await rpc.request('prompt.submit', { session_id: nativeId, text: turn.prompt }, turn.signal);
      }
      yield* queue;
      await completed;
    } catch (error) { if (turn.signal.aborted) throw abortError(); throw new Error(safeError(error)); }
    finally { turn.signal.removeEventListener('abort', abort); unsub(); }
  },
};

export { decode as decodeHermesNativeId, encode as encodeHermesNativeId };
