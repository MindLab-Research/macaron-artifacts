// Remembered "don't ask again" permission rules, split into two stores:
//
//   • session — in-memory Map<sid, Set<key>>. Survives across turns of the
//     same server process, dies on restart. Populated by "Allow for session".
//   • project — persisted ~/.claude/macaron-permissions.json, keyed by the
//     session's cwd. Populated by "Always allow". Mirrors settings-store's
//     lazy cache + async persist.
//
// A rule "key" is what canUseTool matches against. For non-Bash tools the key
// is just the tool name (e.g. `Read`). For Bash we go finer: one key per
// sub-command in a compound line, `Bash(<prefix>)`, where the prefix is the
// command's first word (first two for git/npm/docker/… so `git status` and
// `git push` stay distinct). A call auto-approves only when EVERY key it
// produces is already remembered — so a compound never slips through on a
// partial match.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HOME } from '../config.js';

const PERMS_PATH = path.join(HOME, '.claude', 'macaron-permissions.json');

type PermFile = { version: number; projects: Record<string, string[]> };

let cache: PermFile | null = null;
const sessionRules = new Map<string, Set<string>>();

// Commands where the second word is the real verb — keep it in the key so
// `git status` doesn't unlock `git push`. `sudo` is here for safety: without
// it every `sudo <x>` collapses to `Bash(sudo)`, so remembering a benign
// `sudo ls` would silently auto-approve `sudo rm -rf /`.
const TWO_WORD = new Set(['sudo', 'git', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx', 'pnpx', 'docker', 'cargo', 'go', 'kubectl']);

// Split a shell line into sub-commands on unquoted && || ; | & and newline
// operators. Quoted/backtick spans are treated opaquely so a separator inside
// a string doesn't mis-split (same limitation the references ship with).
//
// Newlines matter: a bare `\n` is a command separator in the shell, so a
// multi-line command like `git status\nrm -rf ~` runs BOTH lines. Without
// splitting on it, only the first line's prefix keyed the call, letting a
// remembered `git status` silently auto-approve the second line.
//
// KNOWN GAP: `$(...)` / backtick command substitution is NOT a split boundary,
// so `echo $(rm -rf /)` keys as `Bash(echo)` while the shell still runs the
// inner command. Auto-approving it requires the user to have already remembered
// the outer prefix; we accept that (matches every reference WebUI) rather than
// shipping a full shell parser to the trust boundary.
function splitCompound(cmd: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue; }
    if (cmd.slice(i, i + 2) === '&&' || cmd.slice(i, i + 2) === '||') { parts.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '\r') { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function bashPrefix(segment: string): string | null {
  const words = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++; // skip VAR=val env prefixes
  const first = words[i];
  if (!first) return null;
  const second = words[i + 1];
  if (TWO_WORD.has(first) && second && !second.startsWith('-')) return `${first} ${second}`;
  return first;
}

// The single source of truth for what a tool call resolves to. Returns the
// set of keys it must satisfy to auto-approve, plus a human label for the UI's
// "Session / Always" buttons (empty when there's nothing rememberable).
export function computeRuleKeys(toolName: string, input: unknown): { keys: string[]; label: string } {
  if (toolName !== 'Bash') return { keys: [toolName], label: toolName };
  const command = String((input as { command?: unknown } | null)?.command ?? '');
  const prefixes: string[] = [];
  for (const seg of splitCompound(command)) {
    const p = bashPrefix(seg);
    if (p && !prefixes.includes(p)) prefixes.push(p);
  }
  if (prefixes.length === 0) return { keys: [], label: '' };
  return { keys: prefixes.map((p) => `Bash(${p})`), label: prefixes.join(', ') };
}

async function load(): Promise<PermFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(PERMS_PATH, 'utf8')) as PermFile;
    if (parsed && typeof parsed === 'object' && parsed.projects) {
      return { version: parsed.version || 1, projects: parsed.projects };
    }
  } catch { /* no file yet */ }
  return { version: 1, projects: {} };
}

async function persist(): Promise<void> {
  if (!cache) return;
  await fs.mkdir(path.dirname(PERMS_PATH), { recursive: true });
  await fs.writeFile(PERMS_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

export async function warmPermissionRulesCache(): Promise<void> {
  if (!cache) cache = await load();
}

// Sync hot-path check (claude-runner calls this on every tool call). Cache is
// warmed at startup; if it somehow isn't, project rules read as empty and we
// fall back to prompting — never a spurious auto-approve.
export function isAllowed(sid: string, cwd: string, keys: string[]): boolean {
  if (keys.length === 0) return false;
  const sess = sid ? sessionRules.get(sid) : undefined;
  const proj = cache?.projects[cwd];
  const projSet = proj ? new Set(proj) : null;
  return keys.every((k) => sess?.has(k) || projSet?.has(k) || false);
}

export function rememberSession(sid: string, keys: string[]): void {
  if (!sid || keys.length === 0) return;
  let set = sessionRules.get(sid);
  if (!set) { set = new Set(); sessionRules.set(sid, set); }
  for (const k of keys) set.add(k);
}

// Serialize project writes: the load/edit/persist below is a read-modify-write
// with an await in the middle, so two concurrent sessions remembering for the
// same cwd could otherwise read the same stale array and clobber each other.
let writeChain: Promise<void> = Promise.resolve();

export async function rememberProject(cwd: string, keys: string[]): Promise<void> {
  if (!cwd || keys.length === 0) return;
  const run = writeChain.then(async () => {
    if (!cache) cache = await load();
    const cur = new Set(cache.projects[cwd] || []);
    for (const k of keys) cur.add(k);
    cache.projects[cwd] = [...cur];
    await persist();
  });
  writeChain = run.catch(() => {}); // keep the chain alive even if one write fails
  return run;
}
