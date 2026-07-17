// Human-friendly session labels, held in ~/.claude/macaron-labels.json as a
// flat { sessionId: label } map.
//
// Sessions live in Claude-owned ~/.claude/projects/**/*.jsonl, which the CLI
// rewrites — so we can't store a name inside them. This sidecar is macaron's
// own writable place for the label, keyed by the session's UUID (globally
// unique, so no need to key by project). Same pattern as settings-store.ts.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HOME } from '../config.js';

const LABELS_PATH = path.join(HOME, '.claude', 'macaron-labels.json');

type LabelMap = Record<string, string>;

let cache: LabelMap | null = null;

async function load(): Promise<LabelMap> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(LABELS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    cache = parsed && typeof parsed === 'object' ? (parsed as LabelMap) : {};
  } catch {
    cache = {};
  }
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  await fs.mkdir(path.dirname(LABELS_PATH), { recursive: true });
  await fs.writeFile(LABELS_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

export async function getLabels(): Promise<LabelMap> {
  return load();
}

// Warm the cache at boot (before app.listen), like warmSettingsCache. Without
// this, two concurrent load()s in the cold-cache window each assign a fresh
// object to `cache` — the reader's overwrites the writer's, orphaning a
// just-persisted label. Warming makes `cache` non-null before any request.
export async function warmLabelsCache(): Promise<void> {
  await load();
}

// Set (or, for a blank name, clear) the label for a session. Returns the
// stored label ('' when cleared) so the route can echo it back.
export async function setLabel(sid: string, name: string): Promise<string> {
  const map = await load();
  const trimmed = name.trim();
  if (trimmed) map[sid] = trimmed;
  else delete map[sid];
  await persist();
  return trimmed;
}

export async function deleteLabel(sid: string): Promise<void> {
  const map = await load();
  if (sid in map) {
    delete map[sid];
    await persist();
  }
}
