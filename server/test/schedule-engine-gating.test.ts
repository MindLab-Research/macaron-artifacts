import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';

// Isolate HOME before importing anything that captures a config path at module
// load. schedule-store's CONFIG_PATH is ~/.claude/macaron-schedules.json, and
// ENGINE is read from MACARON_ENGINE — both frozen at import. The default test
// env leaves MACARON_ENGINE unset, so this suite runs as a `claude` launcher and
// treats `codex`/`kimi` schedules as foreign.
const HOME = mkdtempSync(path.join(os.tmpdir(), 'macaron-sched-'));
process.env.HOME = HOME;
delete process.env.MACARON_ENGINE;

const SCHED_FILE = path.join(HOME, '.claude', 'macaron-schedules.json');
const store = await import('../src/lib/schedule-store.js');
const scheduler = await import('../src/lib/scheduler.js');
const { registerScheduleRoutes } = await import('../src/routes/schedules.js');
const { ENGINE } = await import('../src/config.js');

// A real, existing cwd every schedule can point at (create asserts it exists).
const CWD = mkdtempSync(path.join(os.tmpdir(), 'macaron-sched-cwd-'));

// Seed the persisted store directly, bypassing the route, to simulate schedules
// created before the dependency split or synced from another launcher. Then warm
// the in-memory cache the tick/run-now read from.
async function seed(schedules: Record<string, unknown>[]): Promise<void> {
  await fs.mkdir(path.dirname(SCHED_FILE), { recursive: true });
  writeFileSync(SCHED_FILE, JSON.stringify(schedules, null, 2), 'utf8');
  store.__resetCacheForTests(); // drop cache so the seeded file is reloaded
  await store.warmSchedulesCache();
}

function foreignSchedule(engine: string, id: string, overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id, name: `foreign-${engine}`, prompt: 'do a thing', engine, cwd: CWD,
    pattern: '* * * * *', oneShot: false, status: 'active',
    nextRunAt: now - 1000, // already due
    lastRunAt: null, lastStatus: null, lastSessionId: null,
    createdAt: now, updatedAt: now, ...overrides,
  };
}

let app: FastifyInstance;
before(async () => {
  app = Fastify();
  await registerScheduleRoutes(app);
  await app.ready();
});
after(async () => { await app.close(); });

// ── create gating ──────────────────────────────────────────────────────────

test('POST /api/schedules defaults an omitted engine to ENGINE', async () => {
  await seed([]);
  const res = await app.inject({ method: 'POST', url: '/api/schedules', payload: { name: 'n', prompt: 'p', cwd: CWD, pattern: '* * * * *' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().engine, ENGINE);
});

test('POST /api/schedules accepts an explicit same-engine value', async () => {
  await seed([]);
  const res = await app.inject({ method: 'POST', url: '/api/schedules', payload: { name: 'n', prompt: 'p', cwd: CWD, pattern: '* * * * *', engine: ENGINE } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().engine, ENGINE);
});

test('POST /api/schedules rejects an explicit foreign engine with 400 and creates nothing', async () => {
  await seed([]);
  const foreign = ENGINE === 'claude' ? 'codex' : 'claude';
  const res = await app.inject({ method: 'POST', url: '/api/schedules', payload: { name: 'n', prompt: 'p', cwd: CWD, pattern: '* * * * *', engine: foreign } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, new RegExp(ENGINE));
  assert.equal((await store.readSchedules()).length, 0, 'no schedule should be persisted');
});

// ── update gating ──────────────────────────────────────────────────────────

test('PUT /api/schedules/:id rejects a foreign engine patch without mutating', async () => {
  await seed([foreignSchedule(ENGINE, 'own-1', { status: 'paused', nextRunAt: null })]);
  const foreign = ENGINE === 'claude' ? 'kimi' : 'claude';
  const res = await app.inject({ method: 'PUT', url: '/api/schedules/own-1', payload: { engine: foreign, name: 'changed' } });
  assert.equal(res.statusCode, 400);
  const after = store.getSchedule('own-1');
  assert.equal(after?.name, 'foreign-' + ENGINE, 'name must be unchanged after a rejected patch');
});

// ── run-now gating ─────────────────────────────────────────────────────────

test('run-now on a persisted foreign schedule returns 400 without dispatch or mutation', async () => {
  await seed([foreignSchedule('codex', 'foreign-run', { engine: ENGINE === 'codex' ? 'kimi' : 'codex' })]);
  const before = store.getSchedule('foreign-run');
  const res = await app.inject({ method: 'POST', url: '/api/schedules/foreign-run/run-now' });
  assert.equal(res.statusCode, 400);
  const after = store.getSchedule('foreign-run');
  assert.equal(after?.lastStatus, before?.lastStatus ?? null);
  assert.equal(after?.lastRunAt, before?.lastRunAt ?? null);
  assert.equal(after?.nextRunAt, before?.nextRunAt);
});

// ── tick gating ────────────────────────────────────────────────────────────

test('tick() skips a due persisted foreign schedule — no dispatch, no mutation', async () => {
  const foreign = ENGINE === 'kimi' ? 'codex' : 'kimi';
  await seed([foreignSchedule(foreign, 'foreign-tick')]);
  const before = store.getSchedule('foreign-tick');
  scheduler.tick();
  // fireSchedule is async fire-and-forget; give any (erroneous) dispatch a beat.
  await new Promise((r) => setTimeout(r, 50));
  const after = store.getSchedule('foreign-tick');
  assert.equal(after?.lastStatus, null, 'foreign schedule must never record a run');
  assert.equal(after?.lastRunAt, null);
  assert.equal(after?.nextRunAt, before?.nextRunAt, 'nextRunAt must not advance for a foreign schedule');
});
