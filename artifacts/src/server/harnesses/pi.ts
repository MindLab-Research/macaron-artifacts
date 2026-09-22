import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentSession, CreateAgentSessionOptions, ExtensionUIDialogOptions, ExtensionUIContext, FileEntry, SessionHeader, SessionManager } from '@earendil-works/pi-coding-agent';
import type { ChatChunk } from '../../shared/types.js';
import type { Question } from '../../shared/questions.js';
import type { ProfileOptions } from '../../shared/profiles.js';
import type { HarnessAdapter, HarnessTurn, ResolvedProfile } from './types.js';
import { abortable, abortError, EventQueue, record, safeError } from './common.js';
import { PiEventMapper } from './pi-events.js';

type PiSdk = typeof import('@earendil-works/pi-coding-agent');
/**
 * Minimal structural mirrors of the pi-ai transcript types. Pre-0.86 SDKs do not export
 * `SystemMessage` or the transcript helpers at all, so this adapter declares exactly the
 * fields it reads instead of importing names that only exist in one generation.
 */
type PiTool = { name: string; description: string; parameters: unknown; constrainedSampling?: unknown };
type PiMessage = { role: string; timestamp: number };
type PiSystemMessage = PiMessage & { role: 'system'; content: string | unknown[]; sections?: Record<string, string | null>; toolsAdded?: PiTool[]; toolsRemoved?: { name: string }[] };
/** Whatever the installed SDK actually hands the stream function: `TranscriptContext` from 0.86, `Context` before it. */
type RequestContext = Parameters<AgentSession['agent']['streamFunction']>[1];
/** Pre-0.86 stream contexts carry the prompt and tool declarations as top-level request fields. */
type LegacyRequestContext = { systemPrompt?: string; messages: PiMessage[]; tools?: PiTool[] };
type LegacyBootstrapTools = { name: string; description: string; parameters: unknown };
type TranscriptHelpers = { normalizeContext: (context: { messages: PiMessage[] }) => RequestContext; toToolDeclaration: (tool: PiTool) => PiTool };

let transcriptHelpers: TranscriptHelpers | null | undefined;
/**
 * 0.86 moved the prompt and tool declarations out of the top-level request fields and into
 * the transcript's system messages, adding `normalizeContext`/`toToolDeclaration`. Their
 * presence in the loaded module is the generation probe; older SDKs return null and the
 * adapter uses the flattened contract instead.
 */
export async function piTranscriptHelpers(): Promise<TranscriptHelpers | null> {
  if (transcriptHelpers !== undefined) return transcriptHelpers;
  const module: Record<string, unknown> = { ...await import('@earendil-works/pi-ai') };
  const normalize = module.normalizeContext, declare = module.toToolDeclaration;
  transcriptHelpers = typeof normalize === 'function' && typeof declare === 'function'
    ? { normalizeContext: normalize as TranscriptHelpers['normalizeContext'], toToolDeclaration: declare as TranscriptHelpers['toToolDeclaration'] }
    : null;
  return transcriptHelpers;
}
export function piQuestionUI(turn: HarnessTurn): Pick<ExtensionUIContext, 'select' | 'input'> {
  const ask = async (question: Question, options?: ExtensionUIDialogOptions) => {
    if (turn.enrichment) return undefined;
    const controller = new AbortController(), signal = AbortSignal.any([turn.signal, controller.signal, ...(options?.signal ? [options.signal] : [])]);
    const timer = options?.timeout === undefined ? undefined : setTimeout(() => controller.abort(), Math.max(0, options.timeout));
    try { const response = await turn.ask({ questions: [question] }, signal); return 'answers' in response ? response.answers[question.id][0] : undefined; }
    finally { clearTimeout(timer); }
  };
  return {
    select: (title, options, opts) => ask({ id: 'answer', question: title, options: options.map(label => ({ label })), custom: false }, opts),
    input: (title, placeholder, opts) => ask({ id: 'answer', question: title, options: [], custom: true, placeholder }, opts),
  };
}
type PayloadPrefix = { api: string; history: string; fields: Record<string, unknown>; instructions: unknown[] };
/**
 * Version 3 records the transcript system messages that carry the prompt and tool
 * declarations. Version 2 stores the flattened `systemPrompt`/`tools` pair that pre-0.86
 * SDKs put in the top-level request fields; that shape cannot express sections or
 * mid-conversation tool evolution, so a version-2 entry is only replayed under an SDK that
 * still sends those fields, never reinterpreted as a version-3 transcript.
 */
type BootstrapSystem = { before: number; message: PiSystemMessage }[];
type TranscriptBootstrap = { version: 3; instructions: string; system: BootstrapSystem; payload?: PayloadPrefix };
type LegacyBootstrap = { version: 2; instructions: string; systemPrompt?: string; tools?: LegacyBootstrapTools[]; payload?: PayloadPrefix };
type Bootstrap = TranscriptBootstrap | LegacyBootstrap;
const BOOTSTRAP = 'macaron-artifacts:pi-bootstrap';

/** Preserve each instruction/tool delta and its position among conversation messages. */
export function captureBootstrapSystem(messages: readonly { role: string }[], toToolDeclaration: TranscriptHelpers['toToolDeclaration']): BootstrapSystem {
  let before = 0;
  return structuredClone(messages.flatMap(message => {
    if (message.role !== 'system') { before++; return []; }
    const system = message as PiSystemMessage;
    return [{ before, message: { ...system, ...(system.toolsAdded ? { toolsAdded: system.toolsAdded.map(toToolDeclaration) } : {}) } }];
  }));
}

/**
 * Replace fork-only instructions without moving the parent's historical system deltas.
 * Returns a plain message list; the caller normalizes it with the installed SDK.
 */
export function restoreBootstrapSystem<T extends { role: string }>(context: { messages: readonly T[] }, system: BootstrapSystem): { messages: (T | PiSystemMessage)[] } {
  const conversation = context.messages.filter(message => message.role !== 'system'), messages: (T | PiSystemMessage)[] = [];
  let offset = 0;
  for (const entry of structuredClone(system)) {
    if (!Number.isSafeInteger(entry.before) || entry.before < offset || entry.before > conversation.length || entry.message.role !== 'system') throw new Error('Pi metadata transcript no longer matches its parent');
    messages.push(...conversation.slice(offset, entry.before), entry.message);
    offset = entry.before;
  }
  messages.push(...conversation.slice(offset));
  return { messages };
}

/**
 * Pre-0.86 request fields hold the whole prompt and tool set, so the parent's pair replaces
 * the fork's outright. The conversation itself is untouched: those SDKs keep no system
 * messages in the transcript.
 */
export function captureLegacyBootstrap(context: { systemPrompt?: unknown; tools?: unknown }, instructions: string): LegacyBootstrap {
  const prompt = typeof context.systemPrompt === 'string' ? context.systemPrompt : undefined;
  // Registered tools carry `execute` and other host-only callbacks that no clone can copy.
  // Persist only the declaration the model actually saw, exactly as the pre-0.86 wire did.
  const tools = Array.isArray(context.tools) ? (context.tools as PiTool[]).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) : undefined;
  return structuredClone({ version: 2 as const, instructions, systemPrompt: prompt, tools });
}

/** Validate the saved pair before it replaces a live legacy request's prompt and tool fields. */
export function restoreLegacyBootstrap<T extends { role: string }>(context: { messages: readonly T[] }, bootstrap: LegacyBootstrap): { messages: T[]; systemPrompt?: string; tools?: LegacyBootstrapTools[] } {
  if (context.messages.some(message => message.role === 'system')) throw new Error('Pi metadata transcript no longer matches its parent');
  if (bootstrap.systemPrompt !== undefined && typeof bootstrap.systemPrompt !== 'string') throw new Error('Pi metadata bootstrap has an invalid systemPrompt');
  if (bootstrap.tools !== undefined && (!Array.isArray(bootstrap.tools) || bootstrap.tools.some(tool => !tool || typeof tool !== 'object' || typeof tool.name !== 'string' || typeof tool.description !== 'string' || typeof (tool as { parameters?: unknown }).parameters !== 'object'))) throw new Error('Pi metadata bootstrap has invalid tools');
  const restored = structuredClone(bootstrap);
  return { ...context, messages: [...context.messages], systemPrompt: restored.systemPrompt, tools: restored.tools };
}
const PREFIX_FIELDS = ['model', 'modelId', 'system', 'instructions', 'tools', 'toolConfig', 'prompt_cache_key', 'promptCacheKey', 'user', 'metadata', 'config.systemInstruction', 'config.tools', 'config.toolConfig', 'context.systemPrompt', 'context.tools', 'options.sessionId'];
const field = (value: unknown, key: string): unknown => key.split('.').reduce<unknown>((value, key) => record(value)[key], value);
const instruction = (value: unknown) => ['system', 'developer'].includes(String(record(value).role));

/** A fresh runtime owns each turn's provider overlays and temporary credentials, including metadata forks. */
export async function createPiModelRuntime(sdk: PiSdk, agentDir: string, signal: AbortSignal, profile?: ResolvedProfile, modelOverride?: string) {
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: path.join(agentDir, 'models.json'), signal });
  const config = profile?.config, selection = modelOverride || config?.model, apiKey = config?.authMode === 'inherit' ? undefined : profile?.apiKey;
  let resolved = selection ? sdk.resolveCliModel({ cliModel: selection, modelRuntime }) : undefined;
  if (resolved?.error) throw new Error(resolved.error);
  const provider = config?.provider || resolved?.model?.provider;
  if (config?.baseUrl || apiKey) {
    if (!provider) throw new Error('Choose a pi provider or model before overriding its endpoint or API key');
    if (!modelRuntime.getProvider(provider)) throw new Error('Configure this provider in pi models.json before using it in a profile');
    // Registering only an endpoint keeps the native model catalog, compatibility settings and authentication intact.
    if (config?.baseUrl) modelRuntime.registerProvider(provider, { baseUrl: config.baseUrl });
    if (apiKey) await modelRuntime.setRuntimeApiKey(provider, apiKey, { signal });
    resolved = selection ? sdk.resolveCliModel({ cliModel: selection, modelRuntime }) : undefined;
    if (resolved?.error) throw new Error(resolved.error);
  }
  return { modelRuntime, resolved };
}

export async function piProfileOptions(profile?: ResolvedProfile, sdk?: PiSdk): Promise<ProfileOptions> {
  const runtimeSdk = sdk ?? await import('@earendil-works/pi-coding-agent');
  const { getSupportedThinkingLevels } = await import('@earendil-works/pi-ai/compat');
  const { modelRuntime } = await createPiModelRuntime(runtimeSdk, runtimeSdk.getAgentDir(), AbortSignal.timeout(15_000), profile);
  return { models: modelRuntime.getModels().map(model => ({ id: `${model.provider}/${model.id}`, name: model.name, provider: model.provider, efforts: getSupportedThinkingLevels(model) })), efforts: [] };
}

/** These are the native SDK's provider payload layouts. Unknown/custom layouts fail closed for metadata. */
export function piPayloadPrefix(payload: unknown, api: string): PayloadPrefix | undefined {
  const history = ['messages', 'input', 'contents', 'context.messages'].find(key => Array.isArray(field(payload, key)));
  if (!history) return;
  const messages = field(payload, history) as unknown[], first = messages.findIndex(value => !instruction(value));
  const end = first < 0 ? messages.length : first;
  if (messages.slice(end).some(instruction)) return;
  return { api, history, fields: structuredClone(Object.fromEntries(PREFIX_FIELDS.flatMap(key => field(payload, key) === undefined ? [] : [[key, field(payload, key)]]))), instructions: structuredClone(messages.slice(0, end)) };
}

export function restorePiPayloadPrefix(payload: unknown, api: string, prefix: PayloadPrefix): unknown {
  const current = piPayloadPrefix(payload, api);
  if (!current || current.api !== prefix.api || current.history !== prefix.history || current.fields.model !== prefix.fields.model || current.fields.modelId !== prefix.fields.modelId) throw new Error('Pi metadata provider payload no longer matches its parent');
  const output = { ...record(payload) };
  const set = (key: string, value: unknown) => {
    const keys = key.split('.'); let object = output;
    for (const name of keys.slice(0, -1)) { if (object[name] === undefined && value === undefined) return; object[name] = { ...record(object[name]) }; object = object[name] as Record<string, unknown>; }
    if (value === undefined) delete object[keys.at(-1)!]; else object[keys.at(-1)!] = structuredClone(value);
  };
  for (const key of PREFIX_FIELDS) set(key, prefix.fields[key]);
  set(prefix.history, [...prefix.instructions, ...(field(payload, prefix.history) as unknown[]).slice(current.instructions.length)]);
  return output;
}

/** A unique in-memory native identity prevents cleanup collisions; provider affinity still uses the parent's id. */
export function piMetadataEntries(entries: FileEntry[]): { entries: FileEntry[]; affinity: string } {
  const copy = structuredClone(entries), header = copy[0];
  if (header?.type !== 'session' || !header.id) throw new Error('Pi session has no valid header');
  if (!copy.some(entry => entry.type === 'message' && entry.message.role === 'assistant')) throw new Error('Metadata generation requires a completed native Pi response');
  const affinity = header.id;
  header.id = randomUUID();
  return { entries: copy, affinity };
}

/** Keep the native tool catalog unchanged; block execution before extension/tool callbacks on metadata turns. */
export function installPiApprovalGate(session: AgentSession, turn: HarnessTurn) {
  const previous = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (context, signal) => {
    if (turn.enrichment) return { block: true, terminate: true, reason: 'Metadata generation cannot execute tools' };
    const activeSignal = signal ? AbortSignal.any([turn.signal, signal]) : turn.signal;
    if (activeSignal.aborted) return { block: true, terminate: true, reason: 'The turn was interrupted' };
    const result = await previous?.(context, activeSignal);
    if (result?.block) return result;
    const approved = await abortable(turn.approve({ id: context.toolCall.id, tool: context.toolCall.name, input: context.args }), activeSignal);
    return approved ? undefined : { block: true, reason: 'Denied by the user' };
  };
}

async function readNativeSession(sdk: PiSdk, filename: string): Promise<FileEntry[]> {
  // SessionManager.open repairs unterminated JSONL by writing a newline. Metadata must be strictly read-only on the parent.
  const entries = sdk.parseSessionEntries(await readFile(filename, 'utf8'));
  if (entries[0]?.type !== 'session' || !entries[0].id) throw new Error('Pi session has no valid header');
  return entries;
}

export async function createPiSession(turn: HarnessTurn, suppliedSdk?: PiSdk) {
  const sdk = suppliedSdk ?? await import('@earendil-works/pi-coding-agent');
  if (turn.signal.aborted) throw abortError();
  if (turn.enrichment && !turn.nativeId) throw new Error('Metadata generation requires a completed native Pi session');
  const agentDir = sdk.getAgentDir(), settingsManager = sdk.SettingsManager.create(turn.cwd, agentDir);
  const loader = new sdk.DefaultResourceLoader({ cwd: turn.cwd, agentDir, settingsManager, appendSystemPromptOverride: base => [...base, turn.instructions] });
  // The installed SDK generation decides which bootstrap contract this turn can capture or replay.
  const transcript = await piTranscriptHelpers();
  let manager: SessionManager | undefined, affinity: string | undefined, bootstrap: Bootstrap | undefined, session: AgentSession | undefined;
  if (turn.nativeId) {
    const entries = await readNativeSession(sdk, turn.nativeId), header = entries[0] as SessionHeader;
    if (path.resolve(header.cwd) !== path.resolve(turn.cwd)) throw new Error('Pi session belongs to a different working directory');
    if (turn.enrichment) {
      const fork = piMetadataEntries(entries); affinity = fork.affinity;
      manager = sdk.SessionManager.inMemory(turn.cwd, undefined, fork.entries);
      const saved = manager.getBranch().findLast(entry => entry.type === 'custom' && entry.customType === BOOTSTRAP);
      const value = saved?.type === 'custom' ? record(saved.data) : {};
      const expected = transcript ? 3 : 2;
      // A version-2 entry holds the flattened prompt/tool pair that only pre-0.86 SDKs send,
      // and a version-3 entry holds transcript system messages only newer SDKs accept. Across
      // generations neither can reproduce the other's request prefix, so metadata fails closed
      // instead of reconstructing a prefix the parent never sent. Normal resume is unaffected:
      // it recaptures a bootstrap for the running generation from the live stream context.
      if (value.version === 2 && expected === 3) throw new Error('Pi session has a legacy UI4A bootstrap from an older SDK; complete a normal turn before generating metadata');
      if (value.version === 3 && expected === 2) throw new Error('Pi session has a UI4A bootstrap from a newer SDK; complete a normal turn before generating metadata');
      if (value.version !== expected || value.instructions !== turn.instructions || !value.payload) throw new Error('Pi session is missing its matching UI4A bootstrap');
      if (expected === 3 && !Array.isArray(value.system)) throw new Error('Pi session is missing its matching UI4A bootstrap');
      bootstrap = value as Bootstrap;
    } else manager = sdk.SessionManager.open(turn.nativeId);
  }
  try {
    await loader.reload();
    if (turn.signal.aborted) throw abortError();
    const { modelRuntime, resolved: model } = await createPiModelRuntime(sdk, agentDir, turn.signal, turn.profile, turn.model);
    const effort = turn.profile?.config.effort;
    let options: CreateAgentSessionOptions = { cwd: turn.cwd, agentDir, settingsManager, resourceLoader: loader, modelRuntime, sessionManager: manager, ...(model?.model ? { model: model.model, thinkingLevel: model.thinkingLevel } : {}), ...(effort ? { thinkingLevel: effort as CreateAgentSessionOptions['thinkingLevel'] } : {}) };
    if (turn.profile && turn.nativeId && !turn.enrichment && !turn.retry) {
      // Ask the native SDK for startup defaults without old model-change entries. This keeps
      // native provider fallback and per-model effort rules intact when an override is removed.
      const defaults = await sdk.createAgentSession({ ...options, sessionManager: sdk.SessionManager.inMemory(turn.cwd) });
      try { options = { ...options, model: defaults.session.model, thinkingLevel: defaults.session.thinkingLevel }; }
      finally { defaults.session.dispose(); }
    }
    const created = await sdk.createAgentSession(options);
    session = created.session;
    if (effort && !session.getAvailableThinkingLevels().includes(effort as NonNullable<CreateAgentSessionOptions['thinkingLevel']>)) throw new Error(`This pi model does not support thinking level ${effort}`);
    if (turn.enrichment && created.modelFallbackMessage) throw new Error(created.modelFallbackMessage);
    if (turn.profile && turn.nativeId && !turn.enrichment && !turn.retry) {
      // createAgentSession accepts resume overrides but does not record them. Metadata must
      // restore the configuration that actually produced the latest response.
      const previous = session.sessionManager.buildSessionContext(), currentModel = session.model;
      if (currentModel && (previous.model?.provider !== currentModel.provider || previous.model?.modelId !== currentModel.id)) session.sessionManager.appendModelChange(currentModel.provider, currentModel.id);
      if (previous.thinkingLevel !== session.thinkingLevel) session.sessionManager.appendThinkingLevelChange(session.thinkingLevel);
    }
    const current = session;
    installPiApprovalGate(current, turn);
    // Native extension dialogs share the conversation; arbitrary terminal widgets still use SDK defaults.
    const ui = current.extensionRunner.getUIContext();
    await current.bindExtensions({ mode: 'print', uiContext: { ...ui, ...piQuestionUI(turn), confirm: async (title, message, options) => turn.enrichment ? false : abortable(turn.approve({ id: randomUUID(), tool: title, input: { message } }), options?.signal ? AbortSignal.any([turn.signal, options.signal]) : turn.signal) }, abortHandler: () => { void current.abort(); } });
    if (turn.signal.aborted) throw abortError();
    if (affinity) {
      current.agent.sessionId = affinity;
      // Pi keys provider WebSocket caches by this affinity, while dispose uses the
      // distinct native id. SSE preserves server caching without sharing live sockets.
      current.agent.transport = 'sse';
    }
    const nativeStream = current.agent.streamFunction;
    let captured: Bootstrap | undefined;
    current.agent.streamFunction = (model, context, options) => {
      // 0.86+ puts the prompt and tool declarations in the transcript's system messages; older
      // SDKs send them as top-level `systemPrompt`/`tools` request fields. Metadata replaces
      // the fork-only instructions with the parent's prefix — system messages for transcript
      // SDKs, the flattened pair for legacy SDKs — and keeps every later message, so sections
      // and tool evolution replay exactly as they did.
      // The two generations model this argument with incompatible types (branded
      // `TranscriptContext` from 0.86, plain `Context` before it) while agreeing on the
      // `messages` array these helpers read. Bridging through the structural view here, once,
      // is what lets identical source compile and run against both installed SDKs.
      const incoming = context as unknown as { messages: PiMessage[]; systemPrompt?: unknown; tools?: unknown };
      if (!Array.isArray(incoming.messages)) throw new Error('Pi stream context has no message list');
      if (bootstrap) {
        if (bootstrap.version === 3 && transcript) context = transcript.normalizeContext(restoreBootstrapSystem(incoming, bootstrap.system));
        else if (bootstrap.version === 2 && !transcript) context = restoreLegacyBootstrap(incoming, bootstrap) as unknown as RequestContext;
        else throw new Error('Pi metadata bootstrap does not match the running SDK generation');
      } else if (transcript) captured = { version: 3, instructions: turn.instructions, system: captureBootstrapSystem(incoming.messages, transcript.toToolDeclaration) };
      else captured = captureLegacyBootstrap(incoming, turn.instructions);
      const previous = options?.onPayload;
      return nativeStream(model, context, { ...options, ...(bootstrap ? { transport: 'sse' as const } : {}), onPayload: async (payload, model) => {
        const changed = await previous?.(payload, model), final = changed === undefined ? payload : changed;
        // The native extension hook runs after provider serialization and can rewrite
        // system messages, schemas and affinity. Protect its final output, not its input.
        if (bootstrap) return restorePiPayloadPrefix(final, model.api, bootstrap.payload!);
        if (captured) { try { captured.payload = piPayloadPrefix(final, model.api); } catch { captured.payload = undefined; } }
        return changed;
      } });
    };
    return {
      session: current,
      saveBootstrap() { if (!turn.enrichment && captured) current.sessionManager.appendCustomEntry(BOOTSTRAP, captured); },
      async dispose() {
        try { await current.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); }
        finally { current.dispose(); await settingsManager.flush(); }
      },
    };
  } catch (error) { session?.dispose(); await settingsManager.flush(); throw error; }
}

export async function* runPiSession(turn: HarnessTurn, create = createPiSession): AsyncIterable<ChatChunk> {
  const local = new AbortController(), signal = AbortSignal.any([turn.signal, local.signal]), activeTurn = { ...turn, signal };
  const runtime = await create(activeTurn), session = runtime.session, queue = new EventQueue<ChatChunk>(), mapper = new PiEventMapper();
  let task: Promise<void> | undefined, cancelling: Promise<void> | undefined;
  const cancel = () => { cancelling ??= session.abort(); void cancelling.catch(error => queue.fail(error)); };
  const unsubscribe = session.subscribe(event => { for (const chunk of mapper.map(event)) queue.push(chunk); });
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) throw abortError();
    if (!turn.enrichment) {
      if (!session.sessionFile) throw new Error('Pi did not create a durable session');
      turn.onNativeSession(session.sessionFile);
    }
    task = (async () => {
      try {
        if (turn.retry) await session.agent.continue(); else await session.prompt(turn.prompt);
        await session.waitForIdle();
        if (signal.aborted) throw abortError();
        const assistant = session.messages.findLast(message => message.role === 'assistant');
        if (assistant?.role === 'assistant' && ['error', 'aborted'].includes(assistant.stopReason)) throw new Error(assistant.errorMessage || 'Pi ended without a completed response');
        runtime.saveBootstrap();
        for (const chunk of mapper.finish()) queue.push(chunk);
        queue.end();
      } catch (error) { queue.fail(error); }
    })();
    for await (const chunk of queue) yield chunk;
  } catch (error) { if (signal.aborted) throw abortError(); throw new Error(safeError(error)); }
  finally {
    local.abort();
    try { await task; await cancelling; }
    finally { signal.removeEventListener('abort', cancel); unsubscribe(); await runtime.dispose(); }
  }
}

export const piAdapter: HarnessAdapter = {
  id: 'pi',
  async info() {
    let version: string | undefined;
    try {
      const sdk = await import('@earendil-works/pi-coding-agent');
      if (typeof sdk.createAgentSession === 'function' && typeof sdk.SessionManager?.inMemory === 'function') version = sdk.VERSION;
    } catch { /* Missing or broken bundled SDK. */ }
    return { id: 'pi', name: 'pi', available: Boolean(version), source: 'bundled-sdk', detail: version ? `内置 Pi SDK ${version}，无需单独安装 pi CLI` : 'Pi SDK 不可用，请重新安装 Artifacts', capabilities: { textDeltas: true, reasoningDeltas: true, toolInputDeltas: true, commandOutputDeltas: true, approvals: true, fork: true } };
  },
  async profileOptions(_cwd, profile) { return piProfileOptions(profile); },
  run: runPiSession,
};
