import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ScheduleInput, SessionKind } from '@macaron/shared';
import {
  readSchedules,
  getSchedule,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  setScheduleStatus,
} from '../lib/schedule-store.js';
import { fireSchedule } from '../lib/scheduler.js';

type IdParams = { id: string };
type Body = Partial<ScheduleInput>;

async function assertRunnableCwd(cwd: string): Promise<void> {
  if (!path.isAbsolute(cwd)) throw new Error('cwd must be an absolute path');
  const st = await fs.stat(cwd).catch(() => null);
  if (!st?.isDirectory()) throw new Error('cwd must be an existing directory');
}

function normalizeInput(b: Body): ScheduleInput | null {
  const name = String(b.name || '').trim();
  const prompt = String(b.prompt || '').trim();
  const cwd = String(b.cwd || '').trim();
  const pattern = String(b.pattern || '').trim();
  const engine: SessionKind = b.engine === 'codex' || b.engine === 'kimi' ? b.engine : 'claude';
  if (!name || !prompt || !cwd || !pattern) return null;
  return { name, prompt, cwd, pattern, engine, oneShot: Boolean(b.oneShot) };
}

export async function registerScheduleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/schedules', async () => ({ schedules: await readSchedules() }));

  app.get<{ Params: IdParams }>('/api/schedules/:id', async ({ params }, reply) => {
    const s = getSchedule(params.id);
    if (!s) return reply.status(404).send({ error: 'schedule not found' });
    return s;
  });

  app.post<{ Body: Body }>('/api/schedules', async (req, reply) => {
    const input = normalizeInput(req.body || {});
    if (!input) return reply.status(400).send({ error: 'name, prompt, cwd and pattern are required' });
    try {
      await assertRunnableCwd(input.cwd);
      return await createSchedule(input);
    } catch (e) {
      return reply.status(400).send({ error: (e as Error).message });
    }
  });

  app.put<{ Params: IdParams; Body: Body }>('/api/schedules/:id', async (req, reply) => {
    const b = req.body || {};
    const patch: Body = {};
    if (typeof b.name === 'string') {
      patch.name = b.name.trim();
      if (!patch.name) return reply.status(400).send({ error: 'name required' });
    }
    if (typeof b.prompt === 'string') {
      patch.prompt = b.prompt.trim();
      if (!patch.prompt) return reply.status(400).send({ error: 'prompt required' });
    }
    if (typeof b.cwd === 'string') {
      patch.cwd = b.cwd.trim();
      if (!patch.cwd) return reply.status(400).send({ error: 'cwd required' });
    }
    if (typeof b.pattern === 'string') {
      patch.pattern = b.pattern.trim();
      if (!patch.pattern) return reply.status(400).send({ error: 'pattern required' });
    }
    if (b.engine === 'claude' || b.engine === 'codex' || b.engine === 'kimi') patch.engine = b.engine;
    if (typeof b.oneShot === 'boolean') patch.oneShot = b.oneShot;
    try {
      if (patch.cwd !== undefined) await assertRunnableCwd(patch.cwd);
      const updated = await updateSchedule(req.params.id, patch);
      if (!updated) return reply.status(404).send({ error: 'schedule not found' });
      return updated;
    } catch (e) {
      return reply.status(400).send({ error: (e as Error).message });
    }
  });

  app.delete<{ Params: IdParams }>('/api/schedules/:id', async ({ params }, reply) => {
    const ok = await deleteSchedule(params.id);
    if (!ok) return reply.status(404).send({ error: 'schedule not found' });
    return { ok: true };
  });

  app.post<{ Params: IdParams }>('/api/schedules/:id/pause', async ({ params }, reply) => {
    const s = await setScheduleStatus(params.id, 'paused');
    if (!s) return reply.status(404).send({ error: 'schedule not found' });
    return s;
  });

  app.post<{ Params: IdParams }>('/api/schedules/:id/resume', async ({ params }, reply) => {
    const s = await setScheduleStatus(params.id, 'active');
    if (!s) return reply.status(404).send({ error: 'schedule not found' });
    return s;
  });

  // Fire immediately without touching nextRunAt — a manual test/kick that
  // leaves the schedule on its normal cadence.
  app.post<{ Params: IdParams }>('/api/schedules/:id/run-now', async ({ params }, reply) => {
    const s = getSchedule(params.id);
    if (!s) return reply.status(404).send({ error: 'schedule not found' });
    const result = await fireSchedule(s, false);
    if (!result.ok) return reply.status(result.error === 'schedule already running' ? 409 : 500).send({ error: result.error || 'schedule run failed' });
    return { ok: true, sessionId: result.sessionId };
  });
}
