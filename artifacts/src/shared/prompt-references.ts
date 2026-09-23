export interface PromptReference { path: string; label: string }
export const MAX_PROMPT_REFERENCES = 8;
const referencePattern = /(^|\s)@([A-Za-z0-9_./-]{1,180})/g;
export function promptReferences(text: string): PromptReference[] { const seen = new Set<string>(), result: PromptReference[] = []; for (const match of text.matchAll(referencePattern)) { if (seen.has(match[2])) continue; seen.add(match[2]); result.push({ path: match[2], label: match[2] === 'Canvas' ? 'Canvas' : match[2] }); } return result; }
export function removePromptReference(text: string, path: string) { const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return text.replace(new RegExp(`(^|\\s)@${escaped}(?=\\s|$)`, 'g'), '$1').replace(/[ \t]{2,}/g, ' ').trimStart(); }
export function referenceQuery(text: string, caret = text.length) { const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret)); return match ? { query: match[1], start: caret - match[1].length - 1, end: caret } : null; }
export function selectReference(text: string, caret: number) { const query = referenceQuery(text, caret); return query ? { text: text.slice(0, query.start) + text.slice(query.end), caret: query.start } : { text, caret }; }
