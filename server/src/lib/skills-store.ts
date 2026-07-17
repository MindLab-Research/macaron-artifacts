// Browse / toggle / author Claude Code skills under ~/.claude/skills.
//
// Each skill is a directory holding a SKILL.md whose YAML frontmatter carries
// name + description (+ optional allowed-tools). Skills are enabled by default;
// disabling one writes a `skillOverrides` entry (value "off") into
// ~/.claude/settings.json — the official non-destructive toggle. A skill with
// no override entry counts as enabled. See:
//   https://code.claude.com/docs/en/skills#override-skill-visibility-from-settings

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SkillInfo, SkillDetail } from '@macaron/shared';
import { HOME } from '../config.js';

const SKILLS_DIR = path.join(HOME, '.claude', 'skills');
const SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');

// Directory name = the /skill-name command + the skillOverrides key. Keep it a
// safe slug so we never create paths outside SKILLS_DIR or write odd JSON keys.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// Minimal frontmatter reader. Skill frontmatter is a flat block of single-line
// scalars (name, description, allowed-tools, …) — no need to pull in a YAML
// dependency and bloat the packaged server. Returns the parsed keys plus the body
// with the frontmatter stripped.
function parseSkillMd(text: string): { fm: Record<string, string>; body: string } {
  const fm: Record<string, string> = {};
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text);
  if (!m) return { fm, body: text };
  for (const rawLine of m[1]!.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const c = line.indexOf(':');
    if (c < 0) continue;
    const key = line.slice(0, c).trim();
    let val = line.slice(c + 1).trim();
    const quotedWithSingle = val.startsWith("'");
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
      if (quotedWithSingle) val = val.replace(/''/g, "'");
    }
    if (key) fm[key] = val;
  }
  return { fm, body: text.slice(m[0].length) };
}

type Overrides = Record<string, string>;

// Reads ~/.claude/settings.json — Claude Code's user-scope config, not ours; it
// also holds env, permissions, mcpServers, hooks, etc. A missing file is normal
// (start fresh → {}). Any OTHER failure (malformed JSON, EACCES, a partial read
// of a mid-write file) MUST throw so a mutation aborts instead of serializing
// {} back over the file and wiping every other user setting.
async function readSettings(): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fs.readFile(SETTINGS_PATH, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

function readOverrides(settings: Record<string, unknown>): Overrides {
  const o = settings.skillOverrides;
  return o && typeof o === 'object' ? (o as Overrides) : {};
}

// A skill is "enabled" (Claude can invoke it) unless its override is "off".
function isEnabled(overrides: Overrides, dir: string): boolean {
  return overrides[dir] !== 'off';
}

function yamlScalar(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function readEntryInfo(dir: string, isSymlink: boolean, overrides: Overrides): Promise<SkillInfo | null> {
  const skillMd = path.join(SKILLS_DIR, dir, 'SKILL.md');
  let text: string;
  try {
    text = await fs.readFile(skillMd, 'utf8');
  } catch {
    return null; // dir without a SKILL.md is not a skill
  }
  const { fm } = parseSkillMd(text);
  return {
    dir,
    name: fm.name || dir,
    description: fm.description || '',
    allowedTools: fm['allowed-tools'] || undefined,
    enabled: isEnabled(overrides, dir),
    source: isSymlink ? 'symlink' : 'dir',
  };
}

export async function listSkills(): Promise<SkillInfo[]> {
  let entries;
  try {
    entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return []; // no skills dir yet
  }
  const overrides = readOverrides(await readSettings());
  const out = await Promise.all(
    entries.map(async (e) => {
      // Follow symlinks: a linked skill dir reports isSymbolicLink(), so stat
      // the target to confirm it's actually a directory before reading it.
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          isDir = (await fs.stat(path.join(SKILLS_DIR, e.name))).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (!isDir || !SLUG_RE.test(e.name)) return null;
      return readEntryInfo(e.name, e.isSymbolicLink(), overrides);
    }),
  );
  return out
    .filter((s): s is SkillInfo => s !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkillDetail(dir: string): Promise<SkillDetail | null> {
  if (!SLUG_RE.test(dir)) return null;
  const skillMd = path.join(SKILLS_DIR, dir, 'SKILL.md');
  let text: string;
  try {
    text = await fs.readFile(skillMd, 'utf8');
  } catch {
    return null;
  }
  const { fm, body } = parseSkillMd(text);
  const overrides = readOverrides(await readSettings());
  let source: 'dir' | 'symlink' = 'dir';
  try {
    if ((await fs.lstat(path.join(SKILLS_DIR, dir))).isSymbolicLink()) source = 'symlink';
  } catch {
    /* keep default */
  }
  return {
    dir,
    name: fm.name || dir,
    description: fm.description || '',
    allowedTools: fm['allowed-tools'] || undefined,
    enabled: isEnabled(overrides, dir),
    source,
    body: body.trim(),
    path: skillMd,
  };
}

// Toggle a skill. Disabling writes skillOverrides[dir] = "off"; enabling drops
// the key so the skill returns to its default-on state (keeps settings tidy).
export async function setSkillEnabled(dir: string, enabled: boolean): Promise<boolean> {
  if (!SLUG_RE.test(dir)) return false;
  const skills = await listSkills();
  if (!skills.some((s) => s.dir === dir)) return false;
  const settings = await readSettings();
  const overrides = readOverrides(settings);
  if (enabled) delete overrides[dir];
  else overrides[dir] = 'off';
  if (Object.keys(overrides).length > 0) settings.skillOverrides = overrides;
  else delete settings.skillOverrides;
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return true;
}

export type CreateSkillInput = { name: string; description: string; body?: string };

// Author a new skill: create ~/.claude/skills/<name>/SKILL.md with frontmatter.
// Returns { dir } on success, or an { error } the route maps to a 4xx.
export async function createSkill(
  input: CreateSkillInput,
): Promise<{ dir: string } | { error: string }> {
  const dir = input.name.trim();
  if (!SLUG_RE.test(dir)) {
    return { error: 'name must be lowercase letters, digits and hyphens (e.g. my-skill)' };
  }
  const description = input.description.trim();
  if (!description) return { error: 'description is required' };
  // description goes into the frontmatter as a single-line scalar and is read
  // back line-by-line (parseSkillMd). A newline would silently truncate it on
  // read; a `---` on its own line would end the frontmatter early. Rejecting
  // newlines rules out both — the docs treat description as a short scalar.
  if (/[\r\n]/.test(description)) {
    return { error: 'description must be a single line (no line breaks)' };
  }
  const skillDir = path.join(SKILLS_DIR, dir);
  try {
    await fs.access(skillDir);
    return { error: `a skill named "${dir}" already exists` };
  } catch {
    /* free to create */
  }
  const body = (input.body || '').trim();
  const content =
    `---\nname: ${dir}\ndescription: ${yamlScalar(description)}\n---\n\n` +
    (body ? body + '\n' : `# ${dir}\n\n${description}\n`);
  await fs.mkdir(skillDir, { recursive: true });
  // wx = fail if SKILL.md already appeared (race with a concurrent create).
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), content, { encoding: 'utf8', flag: 'wx' });
  return { dir };
}
