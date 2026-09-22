import type { ChatChunk } from '../../shared/types.js';
import { record, safeError, string } from './common.js';

export function openCodeV2Error(value: unknown): string {
  const error = record(value);
  return safeError(error.message || record(error.data).message || error.name || error.type || 'OpenCode v2 turn failed');
}

/** Native v2 /api/event uses data, assistantMessageID and ordinal, not v1 parts. */
export class OpenCodeV2EventMapper {
  private parts = new Map<string, { kind: 'text' | 'reasoning'; text: string; ended: boolean }>();
  private tools = new Map<string, string>();
  private inputs = new Set<string>();
  private outputs = new Set<string>();
  private usage = new Map<string, { inputTokens: number; outputTokens: number; cachedInputTokens: number }>();
  map(raw: unknown): ChatChunk[] {
    const event = record(raw), data = record(event.data), type = string(event.type), chunks: ChatChunk[] = [];
    const match = type.match(/^session\.(text|reasoning)\.(started|delta|ended)$/);
    if (match) {
      const kind = match[1] as 'text' | 'reasoning', id = `${string(data.assistantMessageID)}:${kind}:${data.ordinal}`;
      let part = this.parts.get(id);
      if (!part) { part = { kind, text: '', ended: false }; this.parts.set(id, part); chunks.push({ type: kind === 'text' ? 'text-start' : 'reasoning-start', id }); }
      if (part.ended) return chunks;
      const text = string(data.text), delta = match[2] === 'delta' ? string(data.delta) : match[2] === 'ended' && text.startsWith(part.text) ? text.slice(part.text.length) : '';
      if (delta) { part.text += delta; chunks.push({ type: kind === 'text' ? 'text-delta' : 'reasoning-delta', id, delta }); }
      if (match[2] === 'ended') { part.ended = true; chunks.push({ type: kind === 'text' ? 'text-end' : 'reasoning-end', id }); }
    }
    const toolCallId = string(data.id);
    if (type === 'session.tool.input.started') {
      this.tools.set(toolCallId, string(data.name));
      chunks.push({ type: 'tool-input-start', toolCallId, toolName: string(data.name), dynamic: true, providerExecuted: true });
    } else if (type === 'session.tool.input.delta') chunks.push({ type: 'tool-input-delta', toolCallId, inputTextDelta: string(data.delta) });
    else if (type === 'session.tool.called' && !this.inputs.has(toolCallId)) {
      this.inputs.add(toolCallId);
      chunks.push({ type: 'tool-input-available', toolCallId, toolName: this.tools.get(toolCallId) || 'tool', input: data.input, dynamic: true, providerExecuted: true });
    } else if ((type === 'session.tool.success' || type === 'session.tool.failed') && !this.outputs.has(toolCallId)) {
      this.outputs.add(toolCallId);
      if (type === 'session.tool.failed') chunks.push({ type: 'tool-output-error', toolCallId, errorText: openCodeV2Error(data.error), dynamic: true, providerExecuted: true });
      else chunks.push({ type: 'tool-output-available', toolCallId, output: data.content, dynamic: true, providerExecuted: true });
    }
    if ((type === 'session.step.ended' || type === 'session.step.failed') && data.tokens) {
      const tokens = record(data.tokens), cache = record(tokens.cache);
      this.usage.set(string(data.assistantMessageID), { inputTokens: Number(tokens.input || 0) + Number(cache.read || 0) + Number(cache.write || 0), outputTokens: Number(tokens.output || 0) + Number(tokens.reasoning || 0), cachedInputTokens: Number(cache.read || 0) });
      const total = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      for (const usage of this.usage.values()) { total.inputTokens += usage.inputTokens; total.outputTokens += usage.outputTokens; total.cachedInputTokens += usage.cachedInputTokens; }
      chunks.push({ type: 'data-usage', id: 'usage', data: total });
    }
    return chunks;
  }
  finish(): ChatChunk[] {
    const chunks: ChatChunk[] = [];
    for (const [id, part] of this.parts) if (!part.ended) { part.ended = true; chunks.push({ type: part.kind === 'text' ? 'text-end' : 'reasoning-end', id }); }
    return chunks;
  }
}
