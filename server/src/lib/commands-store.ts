// Saved prompts / custom slash commands, stored as one `.md` file per command
// under ~/.claude/commands/ — the exact layout Claude Code's CLI reads for
// user-scoped `/name` commands. A saved prompt IS a command file, so the
// WebUI's library and the CLI's `/` palette stay the same source of truth.
//
// File shape (optional YAML frontmatter + Markdown body):
//   ---
//   description: Review a PR for correctness and risk
//   argument-hint: <PR number>
//   ---
//   Review pull request $ARGUMENTS with the following structure: …

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CLAUDE_COMMANDS } from '../config.js';
import type { SavedCommand } from '@macaron/shared';

// `/name` invocation → filename stem. Keep it filesystem- and CLI-safe:
// lowercase, digits, dash, underscore. Reject path separators so a crafted
// name can't escape the commands dir.
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function isValidName(name: string): boolean {
  return NAME_RE.test(name) && name.length <= 64;
}

function fileFor(name: string): string {
  return path.join(CLAUDE_COMMANDS, `${name}.md`);
}

type ParsedCommand = { description: string; argumentHint: string; body: string; frontmatterLines: string[] };

const COMMAND_FRONTMATTER_KEYS = new Set(['description', 'argument-hint', 'allowed-tools', 'model', 'disable-model-invocation']);

function frontmatterKey(line: string): string | null {
  return line.match(/^([A-Za-z-]+):\s*(.*)$/)?.[1]?.toLowerCase() || null;
}

function parseScalar(raw: string): string {
  const val = raw.trim();
  if (val.startsWith('"') && val.endsWith('"')) {
    try { return JSON.parse(val) as string; } catch { return val.slice(1, -1); }
  }
  if (val.startsWith("'") && val.endsWith("'")) return val.slice(1, -1).replace(/''/g, "'");
  return val;
}

// Split a `.md` file into frontmatter + body. We only surface the two fields
// the UI edits, but preserve all other command-level frontmatter lines so a
// routine save does not delete permission/model metadata authored in the CLI.
function parse(raw: string): ParsedCommand {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const m = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!m) return { description: '', argumentHint: '', body: normalized.trim(), frontmatterLines: [] };
  const [, fm = '', body = ''] = m;
  const lines = fm.split('\n');
  if (!lines.some((line) => {
    const key = frontmatterKey(line);
    return key ? COMMAND_FRONTMATTER_KEYS.has(key) : false;
  })) {
    return { description: '', argumentHint: '', body: normalized.trim(), frontmatterLines: [] };
  }
  let description = '';
  let argumentHint = '';
  for (const line of lines) {
    const kv = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const val = parseScalar(kv[2]!);
    if (key === 'description') description = val;
    else if (key === 'argument-hint') argumentHint = val;
  }
  return { description, argumentHint, body: body.trim(), frontmatterLines: lines };
}

function serialize(input: { description: string; argumentHint: string; body: string }, existingFrontmatter: string[] = []): string {
  let wroteDescription = false;
  let wroteArgumentHint = false;
  const fm: string[] = [];
  for (const line of existingFrontmatter) {
    const key = frontmatterKey(line);
    if (key === 'description') {
      if (!wroteDescription && input.description) fm.push(`description: ${JSON.stringify(input.description)}`);
      wroteDescription = true;
      continue;
    }
    if (key === 'argument-hint') {
      if (!wroteArgumentHint && input.argumentHint) fm.push(`argument-hint: ${JSON.stringify(input.argumentHint)}`);
      wroteArgumentHint = true;
      continue;
    }
    fm.push(line);
  }
  if (!wroteDescription && input.description) fm.push(`description: ${JSON.stringify(input.description)}`);
  if (!wroteArgumentHint && input.argumentHint) fm.push(`argument-hint: ${JSON.stringify(input.argumentHint)}`);
  while (fm.length && !fm[fm.length - 1]!.trim()) fm.pop();
  const head = fm.length ? `---\n${fm.join('\n')}\n---\n\n` : '';
  return `${head}${input.body.trim()}\n`;
}

export async function listCommands(): Promise<SavedCommand[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(CLAUDE_COMMANDS);
  } catch {
    return []; // dir doesn't exist yet — no commands
  }
  const out: SavedCommand[] = [];
  for (const f of entries) {
    if (!f.endsWith('.md')) continue;
    const name = f.slice(0, -3);
    if (!isValidName(name)) continue; // skip namespaced/subdir shapes for now
    try {
      const full = path.join(CLAUDE_COMMANDS, f);
      const [raw, st] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
      const { frontmatterLines: _frontmatterLines, ...parsed } = parse(raw);
      out.push({ name, ...parsed, mtime: st.mtimeMs });
    } catch {
      /* unreadable file — skip */
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function getCommand(name: string): Promise<SavedCommand | null> {
  if (!isValidName(name)) return null;
  try {
    const full = fileFor(name);
    const [raw, st] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
    const { frontmatterLines: _frontmatterLines, ...parsed } = parse(raw);
    return { name, ...parsed, mtime: st.mtimeMs };
  } catch {
    return null;
  }
}

export type CommandInput = { description?: string; argumentHint?: string; body: string };

// Create fails if the name is taken; callers rename or edit instead of
// silently clobbering someone's existing command.
export async function createCommand(name: string, input: CommandInput): Promise<SavedCommand> {
  if (!isValidName(name)) throw new Error('invalid name');
  await fs.mkdir(CLAUDE_COMMANDS, { recursive: true });
  const full = fileFor(name);
  const doc = serialize({ description: input.description || '', argumentHint: input.argumentHint || '', body: input.body });
  try {
    await fs.writeFile(full, doc, { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('command already exists');
    throw e;
  }
  return (await getCommand(name))!;
}

export async function updateCommand(name: string, input: CommandInput): Promise<SavedCommand | null> {
  if (!isValidName(name)) return null;
  const full = fileFor(name);
  let parsed: ParsedCommand;
  try {
    parsed = parse(await fs.readFile(full, 'utf8'));
  } catch {
    return null;
  }
  const doc = serialize({ description: input.description || '', argumentHint: input.argumentHint || '', body: input.body }, parsed.frontmatterLines);
  await fs.writeFile(full, doc, 'utf8');
  return await getCommand(name);
}

export async function deleteCommand(name: string): Promise<boolean> {
  if (!isValidName(name)) return false;
  try {
    await fs.unlink(fileFor(name));
    return true;
  } catch {
    return false;
  }
}
