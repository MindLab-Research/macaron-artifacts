import { useState } from 'react';
import { ArrowUp, Circle } from 'lucide-react';

// Inline diff card for Claude's file-editing tools. Everything needed is
// already in the tool_use `input` (old/new strings), so this renders straight
// from the streamed call — no server round-trip and no wait for the result.

const DIFF_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'str_replace', 'str_replace_editor', 'str_replace_based_edit_tool']);
export function isDiffTool(name: string): boolean {
  return DIFF_TOOLS.has(name);
}

export type DiffHunk = { oldText: string; newText: string; replaceAll?: boolean };
export type ParsedDiff = { filePath: string; hunks: DiffHunk[] };

// Pull the before/after text off the tool input. Shapes:
//   Write     → { file_path, content }               (whole file, all additions)
//   Edit      → { file_path, old_string, new_string, replace_all? }
//   MultiEdit → { file_path, edits: [{ old_string, new_string, replace_all? }] }
// Returns null when the input is missing/partial (e.g. mid-stream before the
// full tool_use has landed) so the caller can fall back to the plain tool row.
export function extractDiff(name: string, input: unknown): ParsedDiff | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, any>;
  const filePath = String(o.file_path ?? o.path ?? '');
  if (name === 'Write') {
    if (typeof o.content !== 'string') return null;
    return { filePath, hunks: [{ oldText: '', newText: o.content }] };
  }
  if (name === 'MultiEdit') {
    const raw = Array.isArray(o.edits) ? o.edits : [];
    const hunks = raw
      .filter((e: any) => e && (typeof e.old_string === 'string' || typeof e.new_string === 'string'))
      .map((e: any) => ({ oldText: String(e.old_string ?? ''), newText: String(e.new_string ?? ''), replaceAll: Boolean(e.replace_all) }));
    return hunks.length ? { filePath, hunks } : null;
  }
  // Edit / str_replace variants
  if (typeof o.old_string !== 'string' && typeof o.new_string !== 'string') return null;
  return { filePath, hunks: [{ oldText: String(o.old_string ?? ''), newText: String(o.new_string ?? ''), replaceAll: Boolean(o.replace_all) }] };
}

function countChanges(hunks: DiffHunk[]): { plus: number; minus: number } {
  let plus = 0, minus = 0;
  for (const h of hunks) {
    if (h.oldText) minus += toLines(h.oldText).length;
    if (h.newText) plus += toLines(h.newText).length;
  }
  return { plus, minus };
}

function toLines(text: string): string[] {
  return text.replace(/\n$/, '').split('\n');
}

function isFailureResult(result?: string, isError?: boolean): boolean {
  if (isError) return true;
  const t = result?.trim();
  if (!t) return false;
  return !/^The file .* (has been (updated|created) successfully|file state is current)/.test(t);
}

// …parent/file.ext — same tail the plain tool header shows for file tools.
function shortPath(p: string): string {
  return p ? '…' + p.split('/').slice(-2).join('/') : '';
}

// Auto-expand small diffs; collapse anything bigger so a large Write doesn't
// flood the thread. Mirrors sugyan's 20-line threshold.
const AUTO_EXPAND_MAX_LINES = 20;

export function DiffCard({ name, diff, result, isError }: { name: string; diff: ParsedDiff; result?: string; isError?: boolean }) {
  const { plus, minus } = countChanges(diff.hunks);
  const canCollapse = plus + minus > AUTO_EXPAND_MAX_LINES;
  const failed = isFailureResult(result, isError);
  const [open, setOpen] = useState(!canCollapse);

  return (
    <div className={'ti-diff' + (failed ? ' err' : '')}>
      <div className="ti-diff-head">
        <span className="ti-dot"><Circle size={8} fill="currentColor" aria-hidden="true" /></span>
        <span className="ti-tool-name">{name}</span>
        {diff.filePath && (
          <span className="ti-diff-path" title={diff.filePath}>{shortPath(diff.filePath)}</span>
        )}
        <span className="ti-diff-stat">
          <span className="ti-diff-plus">+{plus}</span> <span className="ti-diff-minus">−{minus}</span>
        </span>
      </div>
      {open && (
        <div className="ti-diff-body">
          {diff.hunks.map((h, i) => <HunkView key={i} hunk={h} />)}
        </div>
      )}
      {failed && result?.trim() && (
        <div className="ti-tool-out ti-diff-result">
          <span className="ti-rail">└</span>
          <div className="ti-tool-body"><pre>{result}</pre></div>
        </div>
      )}
      {canCollapse && (
        <button className="ti-expand" onClick={() => setOpen((v) => !v)}>
          {open ? <><ArrowUp size={12} aria-hidden="true" /> collapse</> : `… expand diff (+${plus} −${minus})`}
        </button>
      )}
    </div>
  );
}

function HunkView({ hunk }: { hunk: DiffHunk }) {
  const oldLines = hunk.oldText ? toLines(hunk.oldText) : [];
  const newLines = hunk.newText ? toLines(hunk.newText) : [];
  return (
    <div className="ti-diff-hunk">
      {hunk.replaceAll && <div className="ti-diff-tag">replace_all</div>}
      {oldLines.map((line, i) => (
        <div key={`o${i}`} className="ti-diff-row ti-diff-del">
          <span className="ti-diff-sign">−</span>
          <span className="ti-diff-code">{line || ' '}</span>
        </div>
      ))}
      {newLines.map((line, i) => (
        <div key={`n${i}`} className="ti-diff-row ti-diff-add">
          <span className="ti-diff-sign">+</span>
          <span className="ti-diff-code">{line || ' '}</span>
        </div>
      ))}
    </div>
  );
}
