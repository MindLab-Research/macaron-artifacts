// Header line shown next to a tool call in the timeline — the most useful
// one-liner for each tool. Pure and dependency-free so it can be unit-tested
// without dragging in the Session view's GenUI runtime graph.
export function toolHeader(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  if (name === 'Bash') {
    return String(input.description || input.command || '').replace(/\s+/g, ' ').slice(0, 240);
  }
  if (name === 'Read' || name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
    const p = String(input.file_path || '');
    return p ? '…' + p.split('/').slice(-2).join('/') : '';
  }
  if (name === 'Glob') return String(input.pattern || '');
  if (name === 'Grep') return String(input.pattern || '');
  if (name === 'TaskCreate') return String(input.subject || '');
  if (name === 'TaskUpdate') return `#${input.taskId || ''} → ${input.status || input.subject || ''}`;
  if (name === 'WebFetch' || name === 'WebSearch') return String(input.url || input.query || '');
  const s = JSON.stringify(input);
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

// The raw shell script of a Bash tool call, shown (syntax-highlighted) at the top of the
// expanded body — the header only carries the terse `description`. Empty for non-Bash.
export function bashCommand(name: string, input: any): string {
  if (name !== 'Bash' || !input || typeof input !== 'object') return '';
  return String(input.command || '');
}

// A tool row is expandable when either the Bash input script OR the output overflows the
// inline preview — both collapse to `previewLines` and reveal the rest on expand. A script or
// output that already fits within the preview adds no expand affordance (no pointless toggle).
export function isToolExpandable(commandLineCount: number, outputLineCount: number, previewLines: number): boolean {
  return commandLineCount > previewLines || outputLineCount > previewLines;
}
