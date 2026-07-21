// Persisted cron/one-time schedules, held in ~/.claude/macaron-schedules.json.
// Same JSON-file + warmed-cache shape as settings-store.ts: warmSchedulesCache()
// at startup so the tick loop reads from memory, disk writes on every mutation.

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Cron } from 'croner';
import type { Schedule, ScheduleInput } from '@macaron/shared';
import { HOME } from '../config.js';

const CONFIG_PATH = path.join(HOME, '.claude', 'macaron-schedules.json');

let cache: Schedule[] | null = null;

// Validate a pattern (cron string or ISO datetime) and compute the next fire
// time from `from`. Returns null for a one-shot whose time has passed (croner
// yields null) — the caller treats that as "unschedulable / done". Throws on a
// syntactically invalid pattern so create/update can 400.
export function computeNextRun(pattern: string, from: Date = new Date()): number | null {
  const next = new Cron(pattern).nextRun(from);
  return next ? next.getTime() : null;
}

async function loadFromDisk(): Promise<Schedule[]> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function persist(): Promise<void> {
  if (!cache) return;
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

export async function readSchedules(): Promise<Schedule[]> {
  if (!cache) cache = await loadFromDisk();
  return cache;
}

export async function warmSchedulesCache(): Promise<void> {
  await readSchedules();
}

// Test-only: drop the in-memory cache so the next read reloads from disk. Lets a
// test seed the JSON file directly (simulating a foreign/pre-split schedule) and
// have the store pick it up.
export function __resetCacheForTests(): void {
  cache = null;
}

// Sync getter for the tick loop — cache is warmed at startup.
export function listSchedules(): Schedule[] {
  return cache ?? [];
}

export function getSchedule(id: string): Schedule | undefined {
  return (cache ?? []).find((s) => s.id === id);
}

export async function createSchedule(input: ScheduleInput): Promise<Schedule> {
  const list = await readSchedules();
  const now = Date.now();
  const nextRunAt = computeNextRun(input.pattern);
  if (input.oneShot && nextRunAt === null) throw new Error('one-time schedule is in the past');
  const sched: Schedule = {
    id: randomUUID(),
    name: input.name,
    prompt: input.prompt,
    engine: input.engine,
    cwd: input.cwd,
    pattern: input.pattern,
    oneShot: input.oneShot,
    status: nextRunAt === null ? 'done' : 'active',
    nextRunAt, // throws on bad pattern → 400
    lastRunAt: null,
    lastStatus: null,
    lastSessionId: null,
    createdAt: now,
    updatedAt: now,
  };
  list.push(sched);
  await persist();
  return sched;
}

export async function updateSchedule(id: string, patch: Partial<ScheduleInput>): Promise<Schedule | null> {
  const list = await readSchedules();
  const s = list.find((x) => x.id === id);
  if (!s) return null;
  const nextPattern = patch.pattern ?? s.pattern;
  const nextOneShot = patch.oneShot ?? s.oneShot;
  const needsRearm = patch.pattern !== undefined || patch.oneShot !== undefined;
  // Validate a changed pattern regardless of status — croner throws on a
  // syntactically invalid pattern so the route can 400. Gating this on
  // status === 'active' let a paused/done schedule persist a bad pattern with a
  // 200, which then threw a 500 the instant it was resumed and wedged the
  // schedule. A valid-but-past one-shot yields null (not a throw); we only
  // reject that as "in the past" for an active schedule, so a paused past
  // one-shot still resolves to 'done' on resume.
  const recomputed = needsRearm ? computeNextRun(nextPattern) : s.nextRunAt;
  if (needsRearm && s.status === 'active' && nextOneShot && recomputed === null) throw new Error('one-time schedule is in the past');
  if (patch.name !== undefined) s.name = patch.name;
  if (patch.prompt !== undefined) s.prompt = patch.prompt;
  if (patch.engine !== undefined) s.engine = patch.engine;
  if (patch.cwd !== undefined) s.cwd = patch.cwd;
  if (needsRearm) {
    s.pattern = nextPattern;
    s.oneShot = nextOneShot;
    // Only a still-active schedule re-arms; paused/done keep nextRunAt = null
    // and recompute on resume.
    s.nextRunAt = s.status === 'active' ? recomputed : null;
  }
  s.updatedAt = Date.now();
  await persist();
  return s;
}

export async function deleteSchedule(id: string): Promise<boolean> {
  const list = await readSchedules();
  const before = list.length;
  cache = list.filter((s) => s.id !== id);
  if (cache.length === before) return false;
  await persist();
  return true;
}

export async function setScheduleStatus(id: string, status: Schedule['status']): Promise<Schedule | null> {
  const s = (await readSchedules()).find((x) => x.id === id);
  if (!s) return null;
  const nextRunAt = status === 'active' ? computeNextRun(s.pattern) : null;
  s.status = status === 'active' && s.oneShot && nextRunAt === null ? 'done' : status;
  s.nextRunAt = s.status === 'active' ? nextRunAt : null;
  s.updatedAt = Date.now();
  await persist();
  return s;
}

// Called by the scheduler after a fire. Advances nextRunAt from the pattern;
// null (one-shot done / recurrence exhausted) flips the schedule to 'done'.
export async function recordRun(id: string, result: { sessionId: string | null; ok: boolean }, advanceNext = true): Promise<void> {
  const s = (await readSchedules()).find((x) => x.id === id);
  if (!s) return;
  const now = Date.now();
  s.lastRunAt = now;
  s.lastStatus = result.ok ? 'ok' : 'error';
  if (result.sessionId) s.lastSessionId = result.sessionId;
  if (!advanceNext) {
    s.updatedAt = now;
    await persist();
    return;
  }
  // +1s so a recurring cron doesn't recompute the slot we just fired and
  // re-fire it on the next tick. A run slower than ~55s on a per-minute cron
  // could skip a slot; acceptable for v1.
  const next = computeNextRun(s.pattern, new Date(now + 1000));
  s.nextRunAt = next;
  if (next === null) s.status = 'done';
  s.updatedAt = now;
  await persist();
}
