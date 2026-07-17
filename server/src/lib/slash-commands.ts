import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SlashCommand } from '@macaron/shared';
import { HOME } from '../config.js';

// Curated CLI built-ins worth surfacing in the palette. Deliberately not
// exhaustive — rarely-used / removed commands are dropped to keep the menu
// readable. These are handled by the CLI the SDK spawns, so listing them is
// purely a discoverability aid.
const BUILTINS: SlashCommand[] = [
  { name: 'clear', source: 'builtin', description: 'Clear conversation history' },
  { name: 'compact', source: 'builtin', description: 'Summarise then replace the transcript' },
  { name: 'context', source: 'builtin', description: 'Show current context usage' },
  { name: 'config', source: 'builtin', description: 'Open the config panel' },
  { name: 'cost', source: 'builtin', description: 'Show token cost of this session' },
  { name: 'help', source: 'builtin', description: 'List available commands' },
  { name: 'init', source: 'builtin', description: 'Bootstrap a CLAUDE.md for this repo' },
  { name: 'mcp', source: 'builtin', description: 'Manage MCP servers' },
  { name: 'memory', source: 'builtin', description: 'Edit CLAUDE.md memory files' },
  { name: 'model', source: 'builtin', description: 'Switch the active model' },
  { name: 'review', source: 'builtin', description: 'Review a pull request' },
];

// Minimal front-matter reader — pulls the two keys we render. Avoids a YAML
// dependency: split on the first fenced `---` block and grab `key: value`
// lines. Anything fancier (nested YAML, lists) is ignored by design.
function parseFrontmatter(raw: string): { description?: string; argumentHint?: string } {
  if (!raw.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return {};
  const block = raw.slice(3, end);
  const out: { description?: string; argumentHint?: string } = {};
  for (const line of block.split('\n')) {
    const m = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.replace(/^['"]|['"]$/g, '');
    if (key === 'description') out.description = value;
    else if (key === 'argument-hint' || key === 'argumenthint') out.argumentHint = value;
  }
  return out;
}

// Recursively collect `.md` files under a `.claude/commands` root. A
// subdirectory becomes the command's namespace (label only). Best-effort:
// a missing dir yields []. Depth-capped and dotfile-skipping, mirroring the
// existing session walks.
async function walkCommands(
  root: string,
  source: 'project' | 'user',
): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  async function walk(dir: string, namespace: string, depth: number): Promise<void> {
    if (depth > 5) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing dir — best-effort
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, namespace ? `${namespace}/${e.name}` : e.name, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        let fm: { description?: string; argumentHint?: string } = {};
        try {
          fm = parseFrontmatter(await fs.readFile(full, 'utf8'));
        } catch {
          /* unreadable file — list it without metadata */
        }
        out.push({
          name: e.name.slice(0, -3),
          description: fm.description,
          argumentHint: fm.argumentHint,
          source,
          namespace: namespace || undefined,
        });
      }
    }
  }
  await walk(root, '', 0);
  return out;
}

// Build the full palette list for a session cwd: built-ins first, then the
// project's `.claude/commands`, then the user's `~/.claude/commands`.
export async function listSlashCommands(cwd: string): Promise<SlashCommand[]> {
  const [project, user] = await Promise.all([
    cwd ? walkCommands(path.join(cwd, '.claude', 'commands'), 'project') : Promise.resolve([]),
    walkCommands(path.join(HOME, '.claude', 'commands'), 'user'),
  ]);
  return [...BUILTINS, ...project, ...user];
}
