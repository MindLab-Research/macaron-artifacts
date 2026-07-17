// Tool classifier — decides which tools collapse into a "Searching / reading
// / listing …" summary badge (see collapseReadSearch.ts). Mirrors Claude
// Code CLI's `tool.isSearchOrReadCommand()` protocol, but hard-coded here
// since we don't own the tool registry.
//
// Read-only shell commands (grep / cat / ls / du / …) collapse alongside
// the built-in Read / Grep / Glob tools. Anything else — Edit, Write,
// Bash mutations, Task, etc. — breaks the group so a summary badge can't
// hide destructive work.

export type ToolCollapseKind = 'search' | 'read' | 'list' | 'other';

// First word of a Bash command → its category. Only truly read-only utilities
// go in the collapsible buckets; things like `mv`, `rm`, `git commit`,
// `pnpm install` intentionally return 'other' so their card stays visible.
const BASH_SEARCH = /^(?:grep|rg|ripgrep|ag|ack|fgrep|egrep|pcregrep)$/;
const BASH_READ = /^(?:cat|bat|head|tail|less|more|file|wc|md5|md5sum|shasum|sha256sum|hexdump|xxd|strings|od)$/;
const BASH_LIST = /^(?:ls|tree|find|du|stat|readlink|which|whereis|pwd|basename|dirname|realpath)$/;

export function classifyTool(name: string, input: unknown): ToolCollapseKind {
  if (name === 'Read') return 'read';
  if (name === 'Grep') return 'search';
  if (name === 'Glob') return 'search';
  if (name === 'Bash') {
    const cmd = String((input as { command?: string })?.command || '').trim();
    if (!cmd) return 'other';
    // Split off pipes / && / ; — only the leading command matters for
    // classification. `grep foo | wc -l` is still a search.
    const head = cmd.split(/[\s|;&]+/)[0] || '';
    // Strip an env prefix like `LC_ALL=C grep …`.
    const bin = head.includes('=') ? (cmd.split(/\s+/).find((w) => !w.includes('=')) || '') : head;
    const stem = bin.split('/').pop() || '';
    if (BASH_SEARCH.test(stem)) return 'search';
    if (BASH_READ.test(stem)) return 'read';
    if (BASH_LIST.test(stem)) return 'list';
  }
  return 'other';
}

// Short single-line hint shown under a collapsed group (`└ …`). For a file
// read that's the display path; for a search that's the pattern; for a
// bash command that's the first ~60 chars.
export function toolHint(name: string, input: unknown): string {
  if (name === 'Read') {
    const p = (input as { file_path?: string })?.file_path;
    if (p) return displayPath(p);
  }
  if (name === 'Grep') {
    const q = (input as { pattern?: string })?.pattern;
    if (q) return `"${q}"`;
  }
  if (name === 'Glob') {
    const q = (input as { pattern?: string })?.pattern;
    if (q) return q;
  }
  if (name === 'Bash') {
    const cmd = String((input as { command?: string })?.command || '').trim();
    if (cmd) return cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd;
  }
  return '';
}

function displayPath(p: string): string {
  // No filesystem introspection from the browser — just return the path
  // as-is. Session.tsx does its own ~/… collapse where a real home dir
  // is available (via the workspace cwd).
  return p;
}
