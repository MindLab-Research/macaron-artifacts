// Tolerant partial-JSON helpers for streaming JSON from LLMs.
// - extractPartialCode: pull a single string field from an in-progress blob
//   (Claude streams tool_input as `accumulated`); returns '' until it starts.
// - parseFollowups: parse a streaming JSON array of question strings, dropping
//   any element that isn't a fully-closed string so chips never render half-typed.

import { Allow, parse } from 'partial-json';

export function extractPartialCode(raw: string, field = 'code'): string {
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`);
  const m = re.exec(raw);
  if (!m) return '';
  return m[1]
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\\\/g, '\\');
}

// partial-json with Allow.ARR completes an unclosed array but drops any element
// that isn't a fully-closed string — so a chip appears only once its question
// is whole, never half-typed.
// We scan every '[' and keep the one yielding the MOST items rather than the
// first that parses: the model's reply is relayed verbatim, so a non-Anthropic
// provider may wrap the real array in prose that itself contains a decoy array
// (`For example ["thanks"]. Suggestions: [...]`) or a bracket (markdown link,
// citation). The real suggestion list is the longest; a decoy is near-always a
// single element, so picking the largest array beats first- or last-bracket.
export function parseFollowups(raw: string): string[] {
  let best: string[] = [];
  for (let i = raw.indexOf('['); i >= 0; i = raw.indexOf('[', i + 1)) {
    try {
      const parsed = parse(raw.slice(i), Allow.ARR);
      if (!Array.isArray(parsed)) continue;
      const items = parsed.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, 5);
      if (items.length > best.length) best = items;
    } catch {
      /* not the array's bracket — try the next one */
    }
  }
  return best;
}
