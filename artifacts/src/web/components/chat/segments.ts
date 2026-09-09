export type Segment = { kind: 'markdown'; text: string } | { kind: 'ui4a'; code: string; complete: boolean };
const OPEN = /(?<!`)(`{3,})ui4a\/tsx([^\n]*)(\n|$)/;
const CODE_LINE = /^(import|export|const|function|type|interface|let|\/\/)\b/;
const TRAILING_MARKUP = /\n?(?:<\/(?:antml:|｜｜DSML｜｜)?(?:parameter|invoke|tool_calls)>\s*)+$/;
function closer(text: string, fence: string): { index: number; length: number } | null {
  for (let index = text.indexOf(fence); index >= 0; index = text.indexOf(fence, index + 1)) {
    if (text[index - 1] === '`' || text[index + fence.length] === '`') continue;
    if (/^[^\S\n]*(?:\n|$)/.test(text.slice(index + fence.length))) return { index, length: fence.length };
  }
  // Models occasionally close a four-backtick fence with three. Only standalone shorter runs qualify.
  const short = /(?:^|\n)[^\S\n]*(`{3,})[^\S\n]*(?:\n|$)/.exec(text);
  return short ? { index: short.index + short[0].indexOf('`'), length: short[1].length } : null;
}
export function parseSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let rest = text;
  let markdown = '';
  while (rest) {
    const open = OPEN.exec(rest);
    if (!open) { markdown += rest; break; }
    const trailing = open[2].trim();
    const bodyStart = open.index + open[0].length;
    if (trailing && !CODE_LINE.test(trailing) && !/^[\w-]+=/.test(trailing)) { markdown += rest.slice(0, bodyStart); rest = rest.slice(bodyStart); continue; }
    if (/^[^\S\n]*`{3,}ui4a\/tsx/.test(rest.slice(bodyStart))) { markdown += rest.slice(0, open.index); rest = rest.slice(bodyStart); continue; }
    markdown += rest.slice(0, open.index);
    if (markdown.trim()) segments.push({ kind: 'markdown', text: markdown });
    markdown = '';
    const body = rest.slice(bodyStart);
    const close = closer(body, open[1]);
    const prefix = CODE_LINE.test(trailing) ? `${trailing}\n` : '';
    segments.push({ kind: 'ui4a', code: (prefix + (close ? body.slice(0, close.index) : body)).replace(TRAILING_MARKUP, ''), complete: Boolean(close) });
    if (!close) return segments;
    rest = body.slice(close.index + close.length).replace(/^[^\S\n]*\n?/, '');
  }
  if (markdown.trim()) segments.push({ kind: 'markdown', text: markdown });
  return segments;
}
