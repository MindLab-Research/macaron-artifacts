// Read/write the user-scope Claude Code config files from the WebUI:
//   ~/.claude/settings.json  — JSON, schema-guarded before write
//   ~/.claude/CLAUDE.md      — free-form memory markdown
//
// User scope only for now. Project/local scope (.claude/settings.json,
// CLAUDE.md next to a workspace) needs a cwd the global Settings page
// doesn't have; deferred until the editor grows a workspace selector.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { HOME } from '../config.js';
import type { ConfigFile, ConfigFileId, ConfigFileMeta } from '@macaron/shared';

type FileDef = Omit<ConfigFileMeta, 'exists'>;

const FILES: Record<ConfigFileId, FileDef> = {
  'user-settings': {
    id: 'user-settings',
    label: 'User settings',
    path: path.join(HOME, '.claude', 'settings.json'),
    format: 'json',
  },
  'user-memory': {
    id: 'user-memory',
    label: 'User memory (CLAUDE.md)',
    path: path.join(HOME, '.claude', 'CLAUDE.md'),
    format: 'markdown',
  },
};

export function isConfigFileId(id: string): id is ConfigFileId {
  return id === 'user-settings' || id === 'user-memory';
}

// Loose schema: Claude Code's settings.json has a large, evolving key set and
// the CLI rejects a user file only when it fails validation *as a whole*. We
// mirror that leniently — require a JSON object and type-check a handful of
// well-known keys, but pass every other key through untouched so a valid file
// using newer keys never gets blocked by a stale schema here.
const SettingsSchema = z.looseObject({
  model: z.string().optional(),
  // Claude Code tolerates non-string env values (it fixed a crash on numeric
  // env values upstream), so type the value as unknown — otherwise a valid
  // file like {"env":{"PORT":8080}} would be blocked on Save by a stale schema.
  env: z.record(z.string(), z.unknown()).optional(),
  permissions: z
    .looseObject({
      allow: z.array(z.string()).optional(),
      ask: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
      defaultMode: z.string().optional(),
      additionalDirectories: z.array(z.string()).optional(),
    })
    .optional(),
  apiKeyHelper: z.string().optional(),
  cleanupPeriodDays: z.number().optional(),
  includeCoAuthoredBy: z.boolean().optional(),
});

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function listConfigFiles(): Promise<ConfigFileMeta[]> {
  return Promise.all(
    (Object.values(FILES) as FileDef[]).map(async (f) => ({ ...f, exists: await exists(f.path) })),
  );
}

export async function readConfigFile(id: ConfigFileId): Promise<ConfigFile> {
  const def = FILES[id];
  let content = '';
  let present = false;
  try {
    content = await fs.readFile(def.path, 'utf8');
    present = true;
  } catch {
    // Not created yet — return empty; a save will create it.
  }
  return { ...def, exists: present, content };
}

// Validate a settings.json edit before it touches disk. Returns a
// human-readable error string, or null when the content is safe to write.
export function validateSettingsJson(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null; // empty file is allowed (means "no overrides")
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return `Invalid JSON: ${(e as Error).message}`;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'settings.json must be a JSON object';
  }
  const r = SettingsSchema.safeParse(parsed);
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first?.path.length ? first.path.join('.') : '(root)';
    return `Invalid settings: ${where} — ${first?.message ?? 'schema error'}`;
  }
  return null;
}

// Write a config file back to disk, creating ~/.claude if needed. JSON files
// are validated first; an invalid edit throws before any write so a bad save
// can never brick the session. Returns the persisted content (JSON is
// normalized to 2-space indentation).
export async function writeConfigFile(id: ConfigFileId, content: string): Promise<ConfigFile> {
  const def = FILES[id];
  let toWrite = content;
  if (def.format === 'json') {
    const err = validateSettingsJson(content);
    if (err) throw new Error(err);
    const trimmed = content.trim();
    // Re-serialize valid JSON so the on-disk file stays tidy. A blank edit
    // writes a truly-empty file, not raw whitespace, so it can't leave a
    // present-but-unparseable settings.json behind.
    toWrite = trimmed ? `${JSON.stringify(JSON.parse(trimmed), null, 2)}\n` : '';
  }
  await fs.mkdir(path.dirname(def.path), { recursive: true });
  await fs.writeFile(def.path, toWrite, 'utf8');
  return { ...def, exists: true, content: toWrite };
}
