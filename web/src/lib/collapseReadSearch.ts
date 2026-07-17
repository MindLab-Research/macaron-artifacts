// Merge consecutive read-only tool operations (Read / Grep / Glob / cat /
// grep / ls / …) into a single summary badge. Ported from Claude Code
// CLI's collapseReadSearch.ts (~1100 lines), pared down to the core
// counters we render.
//
// Input is any Item-like union; we only touch entries with `kind: 'tool'`
// and pass everything else through unchanged. Callers use the shape:
//
//   { kind: 'collapsed', ids, searchCount, readFiles: Set<string>,
//     readOpCount, listCount, latestHint, allDone, isError, items }
//
// where `items` is the raw sequence so a click-to-expand row can render
// each collapsed row individually.

import { classifyTool, toolHint } from './toolClassify.js';

// Minimal shape we need from an item to classify + merge it.
type ToolLike = {
  id: string;
  kind: 'tool';
  name: string;
  input: unknown;
  result?: string;
  durationMs?: number;
  isError?: boolean;
};

// A collapsed group. `items` preserves original insertion order for the
// expand-toggle path so each collapsed tool row can render at full detail.
export type CollapsedGroup<T> = {
  id: string;
  kind: 'collapsed';
  ids: string[];
  searchCount: number;
  readFiles: Set<string>;
  readOpCount: number; // reads that have no file_path (bash `cat`, `head`, etc.)
  listCount: number;
  latestHint: string;
  allDone: boolean;
  anyError: boolean;
  items: T[];
};

// Anything with a `kind: string` — kept generic so callers don't need to
// re-declare their whole Item union here. Only 'tool' items are eligible
// for merging; everything else passes through untouched.
type WithKind = { kind: string };

export function collapseReadSearchGroups<T extends WithKind>(
  items: T[],
): (T | CollapsedGroup<T>)[] {
  const out: (T | CollapsedGroup<T>)[] = [];
  let group: CollapsedGroup<T> | null = null;
  let groupIdSeq = 0;

  const flush = () => {
    if (!group) return;
    // Single-item group = don't bother collapsing, render it as-is.
    if (group.items.length === 1) {
      out.push(group.items[0]!);
    } else {
      out.push(group);
    }
    group = null;
  };

  for (const it of items) {
    if (it.kind !== 'tool') {
      // Non-tool items break the group (assistant text, thinking, todo,
      // genui, permission, live-*, subagent, system_event, user, image).
      flush();
      out.push(it);
      continue;
    }

    const tool = it as unknown as ToolLike;
    const kind = classifyTool(tool.name, tool.input);
    if (kind === 'other') {
      // Non-collapsible tool (Edit / Write / Task / Bash-that-mutates / …).
      flush();
      out.push(it);
      continue;
    }

    if (!group) {
      group = {
        id: `collapsed-${++groupIdSeq}`,
        kind: 'collapsed',
        ids: [],
        searchCount: 0,
        readFiles: new Set(),
        readOpCount: 0,
        listCount: 0,
        latestHint: '',
        allDone: true,
        anyError: false,
        items: [],
      };
    }

    group.ids.push(tool.id);
    group.items.push(it);
    if (tool.result === undefined) group.allDone = false;
    if (tool.isError) group.anyError = true;

    if (kind === 'search') {
      group.searchCount++;
    } else if (kind === 'list') {
      group.listCount++;
    } else {
      // kind === 'read' — dedupe by file_path when we can, else count ops.
      const fp = (tool.input as { file_path?: string })?.file_path;
      if (fp && typeof fp === 'string') {
        group.readFiles.add(fp);
      } else {
        group.readOpCount++;
      }
    }

    const hint = toolHint(tool.name, tool.input);
    if (hint) group.latestHint = hint;
  }

  flush();
  return out;
}

// Human summary line. Matches the CLI's "Searching for N patterns, reading
// M files, listing K directories" pattern with present/past tense driven
// by whether every tool in the group has finished.
export function summarize(g: CollapsedGroup<unknown>): string {
  const parts: string[] = [];
  const active = !g.allDone;
  const push = (label: string, count: number, singular: string, plural: string) => {
    if (count <= 0) return;
    const verb = parts.length === 0 ? label : label.toLowerCase();
    parts.push(`${verb} ${count} ${count === 1 ? singular : plural}`);
  };
  push(active ? 'Searching for' : 'Searched for', g.searchCount, 'pattern', 'patterns');
  const readCount = g.readFiles.size + g.readOpCount;
  push(active ? 'Reading' : 'Read', readCount, 'file', 'files');
  push(active ? 'Listing' : 'Listed', g.listCount, 'directory', 'directories');
  const text = parts.join(', ');
  return active ? `${text}…` : text;
}
