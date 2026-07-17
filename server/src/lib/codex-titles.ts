// Macaron-side sidecar mapping a Codex threadId → a generated sidebar title.
//
// The rollout `.jsonl` under ~/.codex/sessions is Codex-owned, so we never
// write titles into it. Instead we keep our own tiny JSON map in the macaron
// config dir, exactly like codex-config.ts persists provider settings.
//
// Cache is warmed at startup so getCodexTitle() is synchronous on the
// listCodexSessions() hot path (one lookup per rendered row).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HOME } from '../config.js';

const TITLES_PATH = path.join(HOME, '.claude', 'macaron-codex-titles.json');

let cache: Record<string, string> | null = null;

async function loadFromDisk(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(TITLES_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function persist(): Promise<void> {
  if (!cache) return;
  await fs.mkdir(path.dirname(TITLES_PATH), { recursive: true });
  await fs.writeFile(TITLES_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

export async function warmCodexTitlesCache(): Promise<void> {
  cache = await loadFromDisk();
}

export function getCodexTitle(sid: string): string | undefined {
  return (cache ?? {})[sid];
}

export async function setCodexTitle(sid: string, title: string): Promise<void> {
  if (!cache) cache = await loadFromDisk();
  cache[sid] = title;
  await persist();
}

export async function deleteCodexTitle(sid: string): Promise<void> {
  if (!cache) cache = await loadFromDisk();
  if (!(sid in cache)) return;
  delete cache[sid];
  await persist();
}
