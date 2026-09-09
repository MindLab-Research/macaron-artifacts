import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import type { ChatChunk } from '../../shared/types.js';
import type { HarnessAdapter, HarnessTurn } from './types.js';
import { abortable, abortError, executableVersion, record, safeError, safeProfileError, string } from './common.js';
import { claudeProfileOptions, prepareClaudeProfile, type PreparedClaudeProfile } from './claude-profile.js';

type Block = { id: string; kind: 'text' | 'reasoning' | 'tool'; name: string; json: string; input: unknown; ended: boolean };

/** Translate the SDK's original deltas; completed assistant messages are only a non-streaming fallback. */
export class ClaudeEventMapper {
  private messages = new Map<string, string>();
  private blocks = new Map<string, Block>();
  private completedMessages = new Set<string>();
  private tools = new Set<string>();
  private sequence = 0;
  private currentUsage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } = {};
  constructor(private diagnostic: (error: unknown) => string = safeError) {}

  map(raw: unknown): ChatChunk[] {
    const message = record(raw), chunks: ChatChunk[] = [];
    if (message.type === 'stream_event') {
      const scope = string(message.parent_tool_use_id) || 'main';
      const event = record(message.event);
      if (event.type === 'message_start') {
        const source = record(event.message);
        this.messages.set(scope, string(source.id) || `message-${++this.sequence}`);
        this.usage(source.usage, chunks);
      }
      const messageId = this.messages.get(scope) ?? `message-${this.sequence}`;
      const key = `${scope}:${messageId}:${event.index}`;
      if (event.type === 'content_block_start') {
        const source = record(event.content_block), type = string(source.type);
        if (!['text', 'thinking', 'tool_use', 'server_tool_use'].includes(type)) return chunks;
        const block: Block = { id: string(source.id) || `claude:${key}`, kind: type === 'text' ? 'text' : type === 'thinking' ? 'reasoning' : 'tool', name: string(source.name), json: '', input: source.input ?? {}, ended: false };
        this.blocks.set(key, block);
        if (block.kind === 'tool') {
          this.tools.add(block.id);
          chunks.push({ type: 'tool-input-start', toolCallId: block.id, toolName: block.name, dynamic: true, providerExecuted: true });
        } else {
          chunks.push({ type: block.kind === 'text' ? 'text-start' : 'reasoning-start', id: block.id });
          const initial = string(block.kind === 'text' ? source.text : source.thinking);
          if (initial) chunks.push({ type: block.kind === 'text' ? 'text-delta' : 'reasoning-delta', id: block.id, delta: initial });
        }
      } else if (event.type === 'content_block_delta') {
        const block = this.blocks.get(key), delta = record(event.delta);
        if (!block) return chunks;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') chunks.push({ type: 'text-delta', id: block.id, delta: delta.text });
        else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') chunks.push({ type: 'reasoning-delta', id: block.id, delta: delta.thinking });
        else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          block.json += delta.partial_json;
          chunks.push({ type: 'tool-input-delta', toolCallId: block.id, inputTextDelta: delta.partial_json });
        }
      } else if (event.type === 'content_block_stop') {
        const block = this.blocks.get(key);
        if (block) this.close(block, chunks);
      } else if (event.type === 'message_delta') this.usage(event.usage, chunks);
      else if (event.type === 'message_stop') {
        this.completedMessages.add(`${scope}:${messageId}`);
        for (const [id, block] of this.blocks) if (id.startsWith(`${scope}:${messageId}:`)) this.close(block, chunks);
      }
    } else if (message.type === 'assistant') {
      const source = record(message.message), scope = string(message.parent_tool_use_id) || 'main';
      const messageId = string(source.id) || `fallback-${++this.sequence}`;
      if (this.completedMessages.has(`${scope}:${messageId}`)) return chunks;
      for (const [index, value] of (Array.isArray(source.content) ? source.content : []).entries()) {
        const block = record(value), id = `claude:${scope}:${messageId}:${index}`;
        if (this.blocks.has(`${scope}:${messageId}:${index}`)) continue;
        if (block.type === 'text' && typeof block.text === 'string') chunks.push({ type: 'text-start', id }, { type: 'text-delta', id, delta: block.text }, { type: 'text-end', id });
        else if (block.type === 'thinking' && typeof block.thinking === 'string') chunks.push({ type: 'reasoning-start', id }, { type: 'reasoning-delta', id, delta: block.thinking }, { type: 'reasoning-end', id });
        else if ((block.type === 'tool_use' || block.type === 'server_tool_use') && !this.tools.has(string(block.id))) {
          const toolCallId = string(block.id);
          this.tools.add(toolCallId);
          chunks.push({ type: 'tool-input-available', toolCallId, toolName: string(block.name), input: block.input ?? {}, dynamic: true, providerExecuted: true });
        }
      }
      this.completedMessages.add(`${scope}:${messageId}`);
    } else if (message.type === 'user') {
      const source = record(message.message);
      for (const value of Array.isArray(source.content) ? source.content : []) {
        const block = record(value), toolCallId = string(block.tool_use_id);
        if (block.type !== 'tool_result' || !this.tools.has(toolCallId)) continue;
        if (block.is_error) chunks.push({ type: 'tool-output-error', toolCallId, errorText: this.diagnostic(typeof block.content === 'string' ? block.content : JSON.stringify(block.content)), dynamic: true, providerExecuted: true });
        else chunks.push({ type: 'tool-output-available', toolCallId, output: block.content ?? '', dynamic: true, providerExecuted: true });
      }
    } else if (message.type === 'result') this.usage(message.usage, chunks);
    return chunks;
  }

  finish(): ChatChunk[] { const chunks: ChatChunk[] = []; for (const block of this.blocks.values()) this.close(block, chunks); return chunks; }
  private close(block: Block, chunks: ChatChunk[]) {
    if (block.ended) return;
    block.ended = true;
    if (block.kind !== 'tool') { chunks.push({ type: block.kind === 'text' ? 'text-end' : 'reasoning-end', id: block.id }); return; }
    let input = block.input;
    try { if (block.json) input = JSON.parse(block.json); }
    catch { chunks.push({ type: 'tool-input-error', toolCallId: block.id, toolName: block.name, input: block.json, errorText: 'The harness returned incomplete tool arguments', dynamic: true, providerExecuted: true }); return; }
    chunks.push({ type: 'tool-input-available', toolCallId: block.id, toolName: block.name, input, dynamic: true, providerExecuted: true });
  }
  private usage(value: unknown, chunks: ChatChunk[]) {
    const usage = record(value), data: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } = {};
    // Anthropic's input_tokens excludes both cache buckets; expose the inclusive total used by the shared UI contract.
    if (typeof usage.input_tokens === 'number') data.inputTokens = usage.input_tokens + (typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0) + (typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0);
    if (typeof usage.output_tokens === 'number') data.outputTokens = usage.output_tokens;
    if (typeof usage.cache_read_input_tokens === 'number') data.cachedInputTokens = usage.cache_read_input_tokens;
    if (Object.keys(data).length) { this.currentUsage = { ...this.currentUsage, ...data }; chunks.push({ type: 'data-usage', id: 'usage', data: this.currentUsage }); }
  }
}

export function claudeOptions(turn: HarnessTurn, abortController: AbortController): Options {
  const model = turn.model || turn.profile?.config.model || string(turn.profile?.nativeConfig?.model);
  return {
    cwd: turn.cwd, ...(turn.nativeId && !turn.retry ? { resume: turn.nativeId } : {}), ...(model ? { model } : {}), abortController,
    ...(process.env.MACARON_CLAUDE_PATH ? { pathToClaudeCodeExecutable: process.env.MACARON_CLAUDE_PATH } : {}),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: turn.instructions }, includePartialMessages: true, permissionMode: 'default',
    ...(turn.enrichment ? { forkSession: true, persistSession: false, maxTurns: 1 } : {}),
    ...(turn.retry ? { continue: true } : {}),
    // Always register the same callbacks, including for forks. Removing tools or interactive callbacks changes the cached prompt prefix.
    hooks: { PreToolUse: [{ hooks: [async () => turn.enrichment ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Metadata generation cannot execute tools' } } : {}] }] },
    canUseTool: async (tool, input, context) => {
      if (turn.enrichment) return { behavior: 'deny', message: 'Metadata generation cannot execute tools', interrupt: true };
      const approved = await abortable(turn.approve({ id: context.requestId || context.toolUseID, tool, input }), context.signal);
      return approved ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Denied by the user', interrupt: false };
    },
  };
}

type CreateClaudeQuery = (prompt: string, options: Options) => Promise<Query>;
const createClaudeQuery: CreateClaudeQuery = async (prompt, options) => (await import('@anthropic-ai/claude-agent-sdk')).query({ prompt, options });

export async function* runClaudeTurn(turn: HarnessTurn, createQuery: CreateClaudeQuery = createClaudeQuery): AsyncGenerator<ChatChunk> {
  if (turn.signal.aborted) throw abortError();
  if (turn.enrichment && !turn.nativeId) throw new Error('Metadata generation requires a completed native Claude session');
  const abortController = new AbortController(), abort = () => abortController.abort();
  turn.signal.addEventListener('abort', abort, { once: true });
  let stream: Query | undefined, profile: PreparedClaudeProfile | undefined;
  try {
    profile = await prepareClaudeProfile(turn.profile);
    if (turn.signal.aborted) throw abortError();
    stream = await createQuery(turn.prompt, { ...claudeOptions(turn, abortController), ...profile.options });
    const mapper = new ClaudeEventMapper(error => safeProfileError(error, turn.profile));
    let nativeId = turn.nativeId, settled = false;
    for await (const message of stream) {
      if (!turn.enrichment && 'session_id' in message && message.session_id && message.session_id !== nativeId) { nativeId = message.session_id; turn.onNativeSession(nativeId); }
      for (const chunk of mapper.map(message)) yield chunk;
      if (message.type === 'result') {
        settled = true;
        if (message.is_error) throw new Error('errors' in message ? message.errors.join('\n') : message.result || message.subtype);
      }
    }
    if (turn.signal.aborted) throw abortError();
    if (!settled) throw new Error('Claude ended without a result');
    for (const chunk of mapper.finish()) yield chunk;
  } catch (error) {
    if (turn.signal.aborted) throw abortError();
    throw new Error(safeProfileError(error, turn.profile));
  } finally {
    turn.signal.removeEventListener('abort', abort);
    try { stream?.close(); } finally { await profile?.dispose(); }
  }
}

export const claudeAdapter: HarnessAdapter = {
  id: 'claude-code',
  profileOptions: claudeProfileOptions,
  async info() {
    const version = await executableVersion(process.env.MACARON_CLAUDE_PATH || 'claude');
    return { id: 'claude-code', name: 'Claude Code', available: Boolean(version), detail: version || 'Install Claude Code', capabilities: { textDeltas: true, reasoningDeltas: true, toolInputDeltas: true, commandOutputDeltas: false, approvals: true, fork: true } };
  },
  run: runClaudeTurn,
};
