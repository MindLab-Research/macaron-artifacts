// Tolerant partial-JSON helpers used for live-rendering Claude's
// in-progress tool_input. Claude streams `partial_json` chunks; we
// concatenate them and try to extract specific fields before the JSON
// is syntactically complete.

/**
 * Extracts the in-progress value of a string field from an incomplete JSON
 * blob. Returns '' if the field hasn't started yet. Handles common JSON
 * escape sequences so the renderer gets valid text.
 *
 * Example: `{"code":"import {Bu` → `import {Bu`
 */
export function extractPartialCode(raw: string, field = 'code'): string {
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`);
  const m = re.exec(raw);
  if (!m) return '';
  return m[1]!
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\\\/g, '\\');
}
