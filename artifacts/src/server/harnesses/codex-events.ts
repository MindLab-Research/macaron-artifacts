import type { ChatChunk } from '../../shared/types.js';
import { record, safeError, string } from './common.js';

type Part = { id: string; itemId: string; kind: 'text' | 'summary' | 'full'; ended: boolean; receivedDelta: boolean };

/** Protocol fields verified with `codex app-server generate-ts --experimental` (0.153.4). */
export class CodexEventMapper {
  private parts = new Map<string, Part>();
  private inputs = new Set<string>();
  private outputs = new Set<string>();

  map(method: string, raw: unknown): ChatChunk[] {
    const params = record(raw), chunks: ChatChunk[] = [], itemId = string(params.itemId);
    if (method === 'item/agentMessage/delta' || method === 'item/plan/delta') {
      this.delta(itemId, itemId, 'text', params.delta, chunks);
    } else if (method === 'item/reasoning/summaryTextDelta') {
      this.delta(`${itemId}:summary:${params.summaryIndex ?? 0}`, itemId, 'summary', params.delta, chunks);
    } else if (method === 'item/reasoning/textDelta') {
      this.delta(`${itemId}:content:${params.contentIndex ?? 0}`, itemId, 'full', params.delta, chunks);
    } else if (method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') {
      if (typeof params.delta === 'string') chunks.push({ type: 'data-command', data: { toolCallId: itemId, output: params.delta } });
    } else if (method === 'thread/tokenUsage/updated') {
      // `last` is the latest API call; `total` includes this native thread's earlier turns.
      const usage = record(record(params.tokenUsage).last);
      chunks.push({ type: 'data-usage', id: 'usage', data: {
        ...(typeof usage.inputTokens === 'number' ? { inputTokens: usage.inputTokens } : {}),
        ...(typeof usage.outputTokens === 'number' ? { outputTokens: usage.outputTokens } : {}),
        ...(typeof usage.cachedInputTokens === 'number' ? { cachedInputTokens: usage.cachedInputTokens } : {}),
      } });
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = record(params.item), id = string(item.id), completed = method === 'item/completed';
      if (item.type === 'agentMessage' || item.type === 'plan') {
        if (completed) this.fallback(id, id, 'text', item.text, chunks);
        else this.start(id, id, 'text', chunks);
      } else if (item.type === 'reasoning') {
        if (completed) {
          for (const [index, text] of (Array.isArray(item.summary) ? item.summary : []).entries()) this.fallback(`${id}:summary:${index}`, id, 'summary', text, chunks);
          for (const [index, text] of (Array.isArray(item.content) ? item.content : []).entries()) this.fallback(`${id}:content:${index}`, id, 'full', text, chunks);
        }
      } else {
        const tool = this.tool(item);
        if (tool) {
          if (!this.inputs.has(id)) {
            this.inputs.add(id);
            // App-server exposes complete arguments only. Inventing character deltas here would misrepresent native streaming.
            chunks.push({ type: 'tool-input-available', toolCallId: id, toolName: tool.name, input: tool.input, dynamic: true, providerExecuted: true });
          }
          if (completed && !this.outputs.has(id)) {
            this.outputs.add(id);
            if (item.status === 'failed' || item.success === false || (typeof item.exitCode === 'number' && item.exitCode !== 0)) {
              chunks.push({ type: 'tool-output-error', toolCallId: id, errorText: safeError(record(item.error).message || item.aggregatedOutput || 'Tool execution failed'), dynamic: true, providerExecuted: true });
            } else chunks.push({ type: 'tool-output-available', toolCallId: id, output: item.aggregatedOutput ?? item.result ?? item.contentItems ?? item.output ?? item.changes ?? item.agentsStates ?? item.action ?? '', dynamic: true, providerExecuted: true });
          }
        }
      }
      if (completed) for (const part of this.parts.values()) if (part.itemId === id) this.end(part, chunks);
    }
    return chunks;
  }

  finish(): ChatChunk[] { const chunks: ChatChunk[] = []; for (const part of this.parts.values()) this.end(part, chunks); return chunks; }
  private start(id: string, itemId: string, kind: Part['kind'], chunks: ChatChunk[]): Part {
    const existing = this.parts.get(id);
    if (existing) return existing;
    const part: Part = { id, itemId, kind, ended: false, receivedDelta: false };
    this.parts.set(id, part);
    if (kind === 'text') chunks.push({ type: 'text-start', id });
    else chunks.push({ type: 'reasoning-start', id, providerMetadata: { macaron: { reasoningKind: kind, itemId } } });
    return part;
  }
  private delta(id: string, itemId: string, kind: Part['kind'], value: unknown, chunks: ChatChunk[]) {
    if (typeof value !== 'string') return;
    const part = this.start(id, itemId, kind, chunks);
    part.receivedDelta = true;
    chunks.push({ type: kind === 'text' ? 'text-delta' : 'reasoning-delta', id, delta: value });
  }
  private fallback(id: string, itemId: string, kind: Part['kind'], value: unknown, chunks: ChatChunk[]) {
    if (!this.parts.get(id)?.receivedDelta && typeof value === 'string' && value) this.delta(id, itemId, kind, value, chunks);
  }
  private end(part: Part, chunks: ChatChunk[]) {
    if (!part.ended) { part.ended = true; chunks.push({ type: part.kind === 'text' ? 'text-end' : 'reasoning-end', id: part.id }); }
  }
  private tool(item: Record<string, unknown>): { name: string; input: unknown } | undefined {
    switch (item.type) {
      case 'commandExecution': return { name: 'exec_command', input: { command: item.command, cwd: item.cwd } };
      case 'fileChange': return { name: 'apply_patch', input: { changes: item.changes } };
      case 'mcpToolCall': return { name: `mcp__${string(item.server)}__${string(item.tool)}`, input: item.arguments };
      case 'dynamicToolCall': return { name: [string(item.namespace), string(item.tool)].filter(Boolean).join('.'), input: item.arguments };
      case 'collabAgentToolCall': return { name: string(item.tool), input: { prompt: item.prompt, receiverThreadIds: item.receiverThreadIds } };
      case 'webSearch': return { name: 'web_search', input: item.action ?? {} };
      case 'imageView': return { name: 'view_image', input: { path: item.path } };
      case 'functionCallOutput': return { name: [string(item.namespace), string(item.name)].filter(Boolean).join('.'), input: {} };
      default: return undefined;
    }
  }
}
