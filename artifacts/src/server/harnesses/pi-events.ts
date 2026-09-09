import type { ChatChunk } from '../../shared/types.js';
import { record, safeError, string } from './common.js';

type Part = { id: string; kind: 'text' | 'reasoning' | 'tool'; name: string; text: string; ended: boolean };

/** SDK partial objects are mutable snapshots. Read identifiers synchronously and forward only original deltas. */
export class PiEventMapper {
  private sequence = 0;
  private parts = new Map<number, Part>();
  private tools = new Map<string, Part>();
  private outputs = new Set<string>();
  private commandOutput = new Map<string, string>();
  private replacedCommandOutput = new Set<string>();
  private totals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

  map(raw: unknown): ChatChunk[] {
    const event = record(raw), chunks: ChatChunk[] = [], message = record(event.message);
    if (event.type === 'message_start' && message.role === 'assistant') { this.closeParts(chunks); this.parts.clear(); this.sequence++; }
    else if (event.type === 'message_update') {
      const delta = record(event.assistantMessageEvent), index = Number(delta.contentIndex), type = string(delta.type);
      if (!Number.isSafeInteger(index) || index < 0) return chunks;
      const content = record(delta.partial).content ?? message.content, source = record(Array.isArray(content) ? content[index] : undefined);
      const kind = type.startsWith('text_') ? 'text' : type.startsWith('thinking_') ? 'reasoning' : type.startsWith('toolcall_') ? 'tool' : undefined;
      if (!kind) return chunks;
      let part = this.parts.get(index);
      if (!part) {
        const tool = record(delta.toolCall);
        part = { id: kind === 'tool' ? string(source.id) || string(delta.id) || string(tool.id) : `pi:${this.sequence}:${index}`, kind, name: string(source.name) || string(delta.toolName) || string(tool.name), text: '', ended: false };
        if (kind === 'tool' && (!part.id || !part.name)) return chunks;
        this.parts.set(index, part);
        this.start(part, chunks);
      }
      if (part.ended) return chunks;
      if (type.endsWith('_delta') && typeof delta.delta === 'string') {
        part.text += delta.delta;
        if (kind === 'tool') chunks.push({ type: 'tool-input-delta', toolCallId: part.id, inputTextDelta: delta.delta });
        else chunks.push({ type: kind === 'text' ? 'text-delta' : 'reasoning-delta', id: part.id, delta: delta.delta });
      } else if (type.endsWith('_end')) {
        if (kind !== 'tool' && !part.text && typeof delta.content === 'string' && delta.content) chunks.push({ type: kind === 'text' ? 'text-delta' : 'reasoning-delta', id: part.id, delta: delta.content });
        this.close(part, chunks, kind === 'tool' ? record(delta.toolCall).arguments : undefined);
      }
    } else if (event.type === 'message_end' && message.role === 'assistant') {
      for (const [index, value] of (Array.isArray(message.content) ? message.content : []).entries()) {
        const source = record(value), existing = this.parts.get(index);
        if (existing) { this.close(existing, chunks, source.type === 'toolCall' ? source.arguments : undefined); continue; }
        if (!['text', 'thinking', 'toolCall'].includes(string(source.type))) continue;
        const kind = source.type === 'toolCall' ? 'tool' : source.type === 'thinking' ? 'reasoning' : 'text';
        const part: Part = { id: kind === 'tool' ? string(source.id) : `pi:${this.sequence}:${index}`, kind, name: string(source.name), text: '', ended: false };
        if (kind === 'tool' && this.tools.has(part.id)) continue;
        this.parts.set(index, part); this.start(part, chunks);
        const text = string(kind === 'text' ? source.text : source.thinking);
        if (kind !== 'tool' && text) chunks.push({ type: kind === 'text' ? 'text-delta' : 'reasoning-delta', id: part.id, delta: text });
        this.close(part, chunks, source.arguments);
      }
      this.closeParts(chunks);
      const usage = record(message.usage);
      if (typeof usage.input === 'number' || typeof usage.output === 'number') {
        this.totals.inputTokens += Number(usage.input || 0) + Number(usage.cacheRead || 0) + Number(usage.cacheWrite || 0);
        this.totals.outputTokens += Number(usage.output || 0); this.totals.cachedInputTokens += Number(usage.cacheRead || 0);
        chunks.push({ type: 'data-usage', id: 'usage', data: { ...this.totals } });
      }
    } else if (event.type === 'tool_execution_start') {
      const id = string(event.toolCallId);
      let tool = this.tools.get(id);
      if (!tool) { tool = { id, kind: 'tool', name: string(event.toolName), text: '', ended: false }; this.start(tool, chunks); }
      this.close(tool, chunks, event.args);
    } else if (event.type === 'tool_execution_update' && ['bash', 'powershell'].includes(string(event.toolName))) {
      const result = record(event.partialResult), output = (Array.isArray(result.content) ? result.content : []).map(item => { const part = record(item); return part.type === 'text' ? string(part.text) : ''; }).join('');
      const id = string(event.toolCallId);
      const previous = this.commandOutput.get(id) ?? '';
      this.commandOutput.set(id, output);
      // Native buffers may truncate or replace their prefix. The final tool result is
      // authoritative then; do not turn a replacement into fabricated append-only output.
      if (!output.startsWith(previous)) this.replacedCommandOutput.add(id);
      if (!this.replacedCommandOutput.has(id) && output.length > previous.length) chunks.push({ type: 'data-command', data: { toolCallId: id, output: output.slice(previous.length) } });
    } else if (event.type === 'tool_execution_end') this.output(string(event.toolCallId), event.result, event.isError === true, chunks);
    else if (event.type === 'message_end' && message.role === 'toolResult') this.output(string(message.toolCallId), message.content, message.isError === true, chunks);
    return chunks;
  }

  finish(): ChatChunk[] { const chunks: ChatChunk[] = []; this.closeParts(chunks); return chunks; }
  private start(part: Part, chunks: ChatChunk[]) {
    if (part.kind === 'tool') { this.tools.set(part.id, part); chunks.push({ type: 'tool-input-start', toolCallId: part.id, toolName: part.name, dynamic: true, providerExecuted: true }); }
    else chunks.push({ type: part.kind === 'text' ? 'text-start' : 'reasoning-start', id: part.id });
  }
  private closeParts(chunks: ChatChunk[]) { for (const part of this.parts.values()) this.close(part, chunks); }
  private close(part: Part, chunks: ChatChunk[], input?: unknown) {
    if (part.ended) return;
    part.ended = true;
    if (part.kind !== 'tool') { chunks.push({ type: part.kind === 'text' ? 'text-end' : 'reasoning-end', id: part.id }); return; }
    if (input === undefined) {
      try { input = JSON.parse(part.text); }
      catch { chunks.push({ type: 'tool-input-error', toolCallId: part.id, toolName: part.name, input: part.text, errorText: 'Pi returned incomplete tool arguments', dynamic: true, providerExecuted: true }); return; }
    }
    chunks.push({ type: 'tool-input-available', toolCallId: part.id, toolName: part.name, input, dynamic: true, providerExecuted: true });
  }
  private output(id: string, output: unknown, failed: boolean, chunks: ChatChunk[]) {
    if (!this.tools.has(id) || this.outputs.has(id)) return;
    this.outputs.add(id);
    if (failed) chunks.push({ type: 'tool-output-error', toolCallId: id, errorText: safeError(typeof output === 'string' ? output : JSON.stringify(output)), dynamic: true, providerExecuted: true });
    else chunks.push({ type: 'tool-output-available', toolCallId: id, output, dynamic: true, providerExecuted: true });
  }
}
