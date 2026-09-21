import { randomUUID } from 'node:crypto';
import type { ChatChunk, HarnessInfo } from '../../shared/types.js';
import type { ProfileOptions } from '../../shared/profiles.js';
import type { HarnessAdapter, HarnessTurn } from './types.js';
import { abortError, EventQueue, executableVersion, record, safeError, string } from './common.js';

type GatewayClient = import('@openclaw/gateway-client').GatewayClient;
type GatewayOptions = import('@openclaw/gateway-client').GatewayClientOptions;
type GatewayEvent = { event: string; payload?: unknown };
type NativeSession = { key: string; id?: string; cwd: string };
type StreamState = { text: string; thought: string; textId: string; thoughtId: string; tools: Set<string> };

const OPENCLAW = () => process.env.MACARON_OPENCLAW_PATH || 'openclaw';
const decode = (value: string | undefined, cwd: string): NativeSession | undefined => {
  if (!value) return;
  try { const decoded = JSON.parse(Buffer.from(value.startsWith('openclaw:') ? value.slice('openclaw:'.length) : value, 'base64url').toString('utf8')); if (decoded.key) return { key: String(decoded.key), id: decoded.id ? String(decoded.id) : undefined, cwd: String(decoded.cwd || cwd) }; } catch { /* Old sessions stored the Gateway key directly. */ }
  return { key: value, cwd };
};
const encode = (session: NativeSession) => `openclaw:${Buffer.from(JSON.stringify(session)).toString('base64url')}`;
const payload = (event: GatewayEvent) => record(event.payload);
const eventSession = (event: GatewayEvent) => string(payload(event).sessionKey || payload(event).session_key);
const eventRun = (event: GatewayEvent) => string(payload(event).runId || payload(event).run_id);
const textValue = (value: unknown): string => typeof value === 'string' ? value : string(record(value).text || record(value).delta || record(value).message || record(value).output);
export const encodeOpenClawNativeId = encode;
export const decodeOpenClawNativeId = decode;
const METADATA_PLUGIN_ID = 'macaron-artifacts-metadata-gate';
const METADATA_SESSION_PREFIX = 'macaron-metadata:';

function options(turn: HarnessTurn, onEvent: (event: GatewayEvent) => void, onError: (error: Error) => void): GatewayOptions {
  const profile = turn.profile, url = profile?.config.gatewayUrl || process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789', token = profile?.authToken || process.env.OPENCLAW_GATEWAY_TOKEN;
  return { url, ...(token ? { token } : {}), clientName: 'gateway-client', clientDisplayName: 'Macaron Artifacts', clientVersion: '0.1.0', platform: process.platform, mode: 'backend', role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.approvals'], caps: ['tool-events'], minProtocol: 4, maxProtocol: 4, onEvent, onConnectError: onError };
}

const selectedAgent = (turn: HarnessTurn) => turn.profile?.config.agent || turn.profile?.config.nativeProfile;

async function assertMetadataGate(client: GatewayClient): Promise<void> {
  const inspected = record(await client.request('plugins.inspect', { pluginId: METADATA_PLUGIN_ID }));
  const plugin = record(inspected.plugin), declared = record(inspected.declared);
  const contracts = Array.isArray(declared.contracts) ? declared.contracts.map(String) : [];
  if (plugin.enabled !== true || !contracts.some(value => value.includes('macaron-metadata-gate'))) throw new Error('OpenClaw metadata gate plugin is not enabled on this Gateway; refusing an unguarded metadata fork');
}

function emitSnapshot(data: Record<string, unknown>, state: StreamState, queue: EventQueue<ChatChunk>): void {
  const text = textValue(data.text ?? data.delta ?? data.content);
  if (text && text !== state.text) { const delta = text.startsWith(state.text) ? text.slice(state.text.length) : text; if (!state.text) { state.textId = `openclaw-text-${randomUUID()}`; queue.push({ type: 'text-start', id: state.textId }); } state.text = text; if (delta) queue.push({ type: 'text-delta', id: state.textId, delta }); }
  const thought = textValue(data.thinking ?? data.reasoning ?? data.thought);
  if (thought && thought !== state.thought) { const delta = thought.startsWith(state.thought) ? thought.slice(state.thought.length) : thought; if (!state.thought) { state.thoughtId = `openclaw-thought-${randomUUID()}`; queue.push({ type: 'reasoning-start', id: state.thoughtId }); } state.thought = thought; if (delta) queue.push({ type: 'reasoning-delta', id: state.thoughtId, delta }); }
}

function emitTool(data: Record<string, unknown>, state: StreamState, queue: EventQueue<ChatChunk>): void {
  const phase = string(data.phase || data.type), toolCallId = string(data.toolCallId || data.tool_call_id || data.id) || `openclaw-tool-${state.tools.size + 1}`;
  if (!/tool/i.test(phase) && data.toolCallId === undefined && data.tool_call_id === undefined) return;
  const toolName = string(data.name || data.toolName || data.tool_name || data.title) || 'tool';
  if (!state.tools.has(toolCallId)) { state.tools.add(toolCallId); queue.push({ type: 'tool-input-start', toolCallId, toolName, dynamic: true, providerExecuted: true }); }
  const input = data.args ?? data.input ?? data.arguments; if (input !== undefined) queue.push({ type: 'tool-input-available', toolCallId, toolName, input, dynamic: true, providerExecuted: true });
  const output = data.result ?? data.output ?? data.result_text; if (output !== undefined) queue.push({ type: 'tool-output-available', toolCallId, output, dynamic: true, providerExecuted: true });
}

async function createClient(turn: HarnessTurn, queue: EventQueue<ChatChunk>, session: { key?: string; runId: string }, state: StreamState, signal: AbortSignal, approve: HarnessTurn['approve']): Promise<GatewayClient> {
  let client: GatewayClient | undefined;
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const onError = (error: Error) => { readyReject(error); queue.fail(error); };
  const onEvent = (event: GatewayEvent) => {
    const p = payload(event), sid = eventSession(event), rid = eventRun(event);
    if (session.key && ((sid && sid !== session.key) || (rid && rid !== session.runId) || (!sid && !rid))) return;
    if (event.event === 'connect.challenge') return;
    if (event.event === 'exec.approval.requested') { if (!sid && !rid) return; const request = record(p.request), approvalId = string(p.id || p.approvalId); void approve({ id: approvalId, tool: string(request.command || request.tool || 'exec'), input: request }).then(ok => client?.request('exec.approval.resolve', { id: approvalId, decision: ok ? 'allow-once' : 'deny' })).catch(onError); return; }
    const data = record(p.data || p), stream = string(p.stream || event.event), phase = string(data.phase || data.state || data.type || p.state || p.phase);
    if (stream === 'assistant' || /assistant|message/i.test(stream)) emitSnapshot(data, state, queue); else if (stream === 'tool' || /tool/i.test(stream)) emitTool(data, state, queue);
    // Tool items and compaction also emit "end"; only a run terminal can finish the assistant turn.
    if ((stream === 'lifecycle' && ['end', 'error'].includes(phase)) || (event.event === 'chat' && ['final', 'aborted', 'error'].includes(phase))) { if (state.textId) queue.push({ type: 'text-end', id: state.textId }); if (state.thoughtId) queue.push({ type: 'reasoning-end', id: state.thoughtId }); if (phase === 'error') queue.fail(new Error(safeError(data.error || data.errorMessage || 'OpenClaw run failed'))); else queue.end(); }
  };
  const clientOptions = options(turn, onEvent, onError);
  clientOptions.onClose = (_code, reason) => { if (reason) queue.fail(new Error(`OpenClaw Gateway closed: ${reason}`)); };
  clientOptions.onHelloOk = () => readyResolve();
  client = new (await import('@openclaw/gateway-client')).GatewayClient(clientOptions);
  client.start();
  await Promise.race([ready, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(abortError()), { once: true }))]);
  return client;
}

export const openClawAdapter: HarnessAdapter = {
  id: 'openclaw' as never,
  async info(): Promise<HarnessInfo> { const version = await executableVersion(OPENCLAW()); return { id: 'openclaw' as never, name: 'OpenClaw', available: Boolean(version), detail: version || 'Install OpenClaw', capabilities: { textDeltas: true, reasoningDeltas: true, toolInputDeltas: true, commandOutputDeltas: true, approvals: true, fork: true } }; },
  async profileOptions(): Promise<ProfileOptions> { return { models: [], efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] }; },
  async *run(turn): AsyncIterable<ChatChunk> {
    if (turn.signal.aborted) throw abortError();
    const queue = new EventQueue<ChatChunk>(), state: StreamState = { text: '', thought: '', textId: '', thoughtId: '', tools: new Set() }, controller = new AbortController(), signal = AbortSignal.any([turn.signal, controller.signal]), runId = randomUUID(), parent = decode(turn.nativeId, turn.cwd), sessionRef = { key: parent?.key, runId };
    let client: GatewayClient | undefined, active: NativeSession | undefined, terminal = false;
    const abort = () => { controller.abort(); if (client && active) void client.request('chat.abort', { sessionKey: active.key, runId }).catch(() => {}); queue.fail(abortError()); };
    turn.signal.addEventListener('abort', abort, { once: true });
    try {
      client = await createClient(turn, queue, sessionRef, state, signal, turn.approve);
      if (turn.enrichment) { if (!parent?.key) throw new Error('OpenClaw metadata generation requires a completed native session'); await assertMetadataGate(client); }
      const agentId = selectedAgent(turn);
      const created = turn.enrichment ? await client.request<Record<string, unknown>>('sessions.create', { key: `${METADATA_SESSION_PREFIX}${randomUUID()}`, parentSessionKey: parent?.key, fork: true, forkFrom: 'last-completed', emitCommandHooks: true, succeedsParent: false, ...(agentId ? { agentId } : {}), cwd: turn.cwd, model: turn.model || turn.profile?.config.model, thinkingLevel: turn.profile?.config.effort }) : parent ? { key: parent.key, sessionId: parent.id } : await client.request<Record<string, unknown>>('sessions.create', { ...(agentId ? { agentId } : {}), cwd: turn.cwd, model: turn.model || turn.profile?.config.model, thinkingLevel: turn.profile?.config.effort });
      active = { key: string(created.key || created.sessionKey || created.id || created.sessionId), id: string(created.sessionId || created.id) || undefined, cwd: turn.cwd }; if (!active.key) throw new Error('OpenClaw did not return a session key'); sessionRef.key = active.key;
      if (!turn.enrichment) turn.onNativeSession(encode(active));
      const producer = client.request('agent', { sessionKey: active.key, sessionId: active.id, message: turn.prompt, extraSystemPrompt: turn.instructions, idempotencyKey: runId }).catch(error => queue.fail(error));
      yield* queue;
      await producer;
    } catch (error) { queue.fail(signal.aborted ? abortError() : new Error(safeError(error))); yield* queue; }
    finally { turn.signal.removeEventListener('abort', abort); controller.abort(); if (client && active && turn.enrichment) { const key = active.key, expectedSessionId = active.id; /* Deleting only archived forks stays within operator.write instead of requiring admin. */ await client.request('sessions.patch', { key, expectedSessionId, archived: true }).then(() => client!.request('sessions.delete', { key, expectedSessionId, deleteTranscript: true, archivedOnly: true })).catch(error => console.warn(`OpenClaw metadata fork cleanup failed: ${safeError(error)}`)); } await client?.stopAndWait({ timeoutMs: 1_000 }).catch(() => client?.stop()); }
  },
};
