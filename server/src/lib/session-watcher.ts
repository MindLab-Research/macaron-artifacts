import { watch } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import type { FastifyReply } from 'fastify';
import type { SystemEvent } from '@macaron/shared';
import { CLAUDE_PROJECTS, CODEX_SESSIONS, KIMI_SESSIONS } from '../config.js';
import { sseSend } from './sse.js';

// Recursive fs.watch over the three transcript trees macaron already reads.
// A terminal `claude`/`codex`/`kimi` run appends to a transcript here; we
// debounce the burst of change events and push one `sessions-changed` nudge
// to every connected client so external sessions surface live instead of
// waiting for the next poll. We deliberately don't parse the file — the
// nudge just tells the client to refetch its (already cheap, mtime-cached)
// workspace list.

const subs = new Set<FastifyReply>();
const DEBOUNCE_MS = 400;
const debounce = new Map<SystemEvent['engine'], ReturnType<typeof setTimeout>>();

export function subscribeSystemEvents(reply: FastifyReply): void {
  subs.add(reply);
  reply.raw.on('close', () => subs.delete(reply));
}

function broadcast(engine: SystemEvent['engine']): void {
  if (subs.size === 0) return;
  const prev = debounce.get(engine);
  if (prev) clearTimeout(prev);
  debounce.set(
    engine,
    setTimeout(() => {
      debounce.delete(engine);
      const payload: SystemEvent = { type: 'sessions-changed', engine };
      for (const reply of subs) {
        try {
          sseSend(reply, payload);
        } catch {
          subs.delete(reply);
        }
      }
    }, DEBOUNCE_MS),
  );
}

async function watchTree(dir: string, engine: SystemEvent['engine']): Promise<void> {
  // The tree may not exist yet on a fresh machine (no sessions ever run).
  // Create it so the recursive watch has something to attach to — claude/
  // codex will populate it later and our watcher already covers it.
  await mkdir(dir, { recursive: true }).catch(() => {});
  try {
    const w = watch(dir, { recursive: true }, (_event, filename) => {
      // Only jsonl transcript writes matter. Backups (.bak) and our own
      // duplicate/rewind churn end in .jsonl too, but a refetch is cheap and
      // idempotent, so we don't try to filter them out precisely.
      if (filename && !filename.endsWith('.jsonl')) return;
      broadcast(engine);
    });
    w.on('error', () => {});
  } catch {
    // Recursive watch is unsupported on some platforms/filesystems. Degrade
    // silently — clients still have their interval poll as a fallback.
  }
}

let started = false;
export async function startSessionWatcher(): Promise<void> {
  if (started) return;
  started = true;
  await Promise.all([
    watchTree(CLAUDE_PROJECTS, 'claude'),
    watchTree(CODEX_SESSIONS, 'codex'),
    watchTree(KIMI_SESSIONS, 'kimi'),
  ]);
}
