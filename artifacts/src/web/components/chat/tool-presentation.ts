import { structuredPatch } from 'diff';
import type { ChatMessage } from '../../../shared/types';

export type ToolPart = { type: string; toolName?: string; state?: string; input?: unknown; output?: unknown; errorText?: string; toolCallId?: string };
export const toolName = (part: ToolPart) => part.toolName ?? part.type.replace(/^tool-/, '');
const readTools = new Set(['read', 'read_file', 'readfile', 'glob', 'grep', 'list_files', 'list_directory', 'search', 'web_search', 'web_fetch']);
export function isReadTool(part: ToolPart) {
  // Unknown tools and shell commands may mutate state; never infer safety from their arguments.
  return (part.type.startsWith('tool-') || part.type === 'dynamic-tool') && readTools.has(toolName(part).toLowerCase()) && part.state === 'output-available' && !part.errorText;
}
export function readRunAt(parts: ChatMessage['parts'], index: number) {
  if (!isReadTool(parts[index]) || index > 0 && isReadTool(parts[index - 1])) return null;
  let end = index + 1;
  while (end < parts.length && isReadTool(parts[end])) end++;
  return end - index > 1 ? parts.slice(index, end) as ToolPart[] : null;
}
export function toolHint(part: ToolPart) {
  const input = part.input as Record<string, unknown> | undefined;
  const hint = input?.file_path ?? input?.path ?? input?.filePath ?? input?.filename ?? input?.pattern ?? input?.query;
  return typeof hint === 'string' ? hint : toolName(part);
}
export function editDiff(part: ToolPart) {
  if (part.state !== 'output-available' || part.errorText || !/^(edit|edit_file|multiedit|replace|replace_in_file)$/i.test(toolName(part))) return;
  const input = part.input as Record<string, unknown> | undefined;
  if (!input) return;
  const edits = Array.isArray(input.edits) ? input.edits : [input];
  if (edits.length > 50) return;
  const patches = [];
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object') return;
    const before = edit.old_string ?? edit.oldText ?? edit.old_text, after = edit.new_string ?? edit.newText ?? edit.new_text;
    // Counts describe supplied edit fragments, never an invented snapshot of the whole workspace file.
    if (typeof before !== 'string' || typeof after !== 'string' || before.length + after.length > 100_000) return;
    const patch = structuredPatch(toolHint(part), toolHint(part), before, after, '', '', { context: 3, timeout: 30 });
    if (!patch) return;
    patches.push(patch);
  }
  const lines = patches.flatMap(patch => patch.hunks.flatMap(hunk => [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines]));
  if (!lines.length) return;
  return { added: lines.filter(line => line.startsWith('+')).length, removed: lines.filter(line => line.startsWith('-')).length, code: lines.join('\n') };
}
