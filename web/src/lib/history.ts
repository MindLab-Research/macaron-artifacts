// Per-project prompt history for the Session composer. Scoped to project
// (not per-sid) so users can recall recent prompts across sessions inside
// the same workspace — closer to shell history than to a chat-per-thread
// buffer. Latest entries live at the end of the array.

const STORAGE_PREFIX = 'macaron.history.';
const MAX_ENTRIES = 100;

function storageKey(project: string): string {
  return STORAGE_PREFIX + project;
}

export function loadHistory(project: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(project));
    if (!raw) return [];
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export function pushHistory(project: string, text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return loadHistory(project);
  const cur = loadHistory(project);
  // De-dupe consecutive repeats: pressing Send on the same prompt twice
  // shouldn't flood the history with copies.
  if (cur[cur.length - 1] === trimmed) return cur;
  const next = [...cur, trimmed].slice(-MAX_ENTRIES);
  try {
    localStorage.setItem(storageKey(project), JSON.stringify(next));
  } catch {
    /* quota exceeded — silently ignore */
  }
  return next;
}
