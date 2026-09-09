import type { ChatChunk } from '../../shared/types.js';
import { record, safeError, string } from './common.js';

type Part = { id: string; kind: 'text' | 'reasoning'; text: string; ended: boolean };

/** OpenCode's stable /event protocol, including events received before their message role. */
export class OpenCodeEventMapper {
  private roles = new Map<string, string>();
  private waiting = new Map<string, unknown[]>();
  private parts = new Map<string, Part>();
  private deltas = new Map<string, string[]>();
  private inputs = new Set<string>();
  private outputs = new Set<string>();
  private usage = new Map<string, { inputTokens: number; outputTokens: number; cachedInputTokens: number }>();

  map(raw: unknown): ChatChunk[] {
    const event = record(raw), properties = record(event.properties), chunks: ChatChunk[] = [];
    if (event.type === 'message.updated') {
      const info = record(properties.info), id = string(info.id), role = string(info.role);
      this.roles.set(id, role);
      const pending = this.waiting.get(id) ?? [];
      this.waiting.delete(id);
      if (role !== 'assistant') return chunks;
      for (const queued of pending) chunks.push(...this.map(queued));
      if (info.error) throw new Error(safeError(record(record(info.error).data).message || record(info.error).name || 'OpenCode turn failed'));
      if (record(info.time).completed !== undefined) {
        const tokens = record(info.tokens), cache = record(tokens.cache);
        // OpenCode separates billable cache and reasoning buckets from input/output; the UI uses inclusive totals.
        this.usage.set(id, { inputTokens: Number(tokens.input ?? 0) + Number(cache.read ?? 0) + Number(cache.write ?? 0), outputTokens: Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0), cachedInputTokens: Number(cache.read ?? 0) });
        const total = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
        for (const usage of this.usage.values()) { total.inputTokens += usage.inputTokens; total.outputTokens += usage.outputTokens; total.cachedInputTokens += usage.cachedInputTokens; }
        chunks.push({ type: 'data-usage', id: 'usage', data: total });
      }
      return chunks;
    }
    if (event.type !== 'message.part.updated' && event.type !== 'message.part.delta') return chunks;
    const value = record(properties.part), messageID = string(properties.messageID || value.messageID), role = this.roles.get(messageID);
    if (!role) { const pending = this.waiting.get(messageID) ?? []; pending.push(raw); this.waiting.set(messageID, pending); return chunks; }
    if (role !== 'assistant') return chunks;
    if (event.type === 'message.part.delta') {
      if (properties.field !== 'text' || typeof properties.delta !== 'string') return chunks;
      const id = string(properties.partID), part = this.parts.get(id);
      // A delta does not identify text vs reasoning; retain its original boundary until the part arrives.
      if (!part) { const pending = this.deltas.get(id) ?? []; pending.push(properties.delta); this.deltas.set(id, pending); }
      else this.delta(part, properties.delta, chunks);
      return chunks;
    }
    const id = string(value.id);
    if (value.type === 'text' || value.type === 'reasoning') {
      let part = this.parts.get(id);
      if (!part) { part = { id, kind: value.type, text: '', ended: false }; this.parts.set(id, part); chunks.push({ type: value.type === 'text' ? 'text-start' : 'reasoning-start', id }); }
      for (const delta of this.deltas.get(id) ?? []) this.delta(part, delta, chunks);
      this.deltas.delete(id);
      const snapshot = string(value.text);
      // Snapshots are cumulative. Emit only a missing suffix, never simulated character deltas.
      if (snapshot.startsWith(part.text) && snapshot.length > part.text.length) this.delta(part, snapshot.slice(part.text.length), chunks);
      if (record(value.time).end !== undefined) this.end(part, chunks);
    } else if (value.type === 'tool') {
      const state = record(value.state), callID = string(value.callID), toolName = string(value.tool);
      if (state.status === 'pending') return chunks; // Stable OpenCode publishes no tool-input delta payload.
      if (!this.inputs.has(callID)) { this.inputs.add(callID); chunks.push({ type: 'tool-input-available', toolCallId: callID, toolName, input: state.input ?? {}, dynamic: true, providerExecuted: true }); }
      if (!this.outputs.has(callID) && (state.status === 'completed' || state.status === 'error')) {
        this.outputs.add(callID);
        if (state.status === 'error') chunks.push({ type: 'tool-output-error', toolCallId: callID, errorText: safeError(state.error), dynamic: true, providerExecuted: true });
        else chunks.push({ type: 'tool-output-available', toolCallId: callID, output: state.output ?? '', dynamic: true, providerExecuted: true });
      }
    }
    return chunks;
  }

  finish(): ChatChunk[] { const chunks: ChatChunk[] = []; for (const part of this.parts.values()) this.end(part, chunks); return chunks; }
  private delta(part: Part, delta: string, chunks: ChatChunk[]) { if (!part.ended && delta) { part.text += delta; chunks.push({ type: part.kind === 'text' ? 'text-delta' : 'reasoning-delta', id: part.id, delta }); } }
  private end(part: Part, chunks: ChatChunk[]) { if (!part.ended) { part.ended = true; chunks.push({ type: part.kind === 'text' ? 'text-end' : 'reasoning-end', id: part.id }); } }
}
