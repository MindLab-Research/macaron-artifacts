import type { FastifyInstance } from 'fastify';
import {
  listSkills,
  readSkillDetail,
  setSkillEnabled,
  createSkill,
} from '../lib/skills-store.js';

type ToggleBody = { enabled?: boolean };
type CreateBody = { name?: string; description?: string; body?: string };

export async function registerSkillRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/skills', async () => ({ skills: await listSkills() }));

  app.get<{ Params: { dir: string } }>('/api/skills/:dir', async (req, reply) => {
    const detail = await readSkillDetail(req.params.dir);
    if (!detail) return reply.status(404).send({ error: 'skill not found' });
    return detail;
  });

  app.put<{ Params: { dir: string }; Body: ToggleBody }>(
    '/api/skills/:dir/enabled',
    async (req, reply) => {
      if (typeof req.body?.enabled !== 'boolean') {
        return reply.status(400).send({ error: 'enabled (boolean) required' });
      }
      try {
        const ok = await setSkillEnabled(req.params.dir, req.body.enabled);
        if (!ok) return reply.status(404).send({ error: 'skill not found' });
        return { skills: await listSkills() };
      } catch (e) {
        return reply.status(500).send({ error: (e as Error).message });
      }
    },
  );

  app.post<{ Body: CreateBody }>('/api/skills', async (req, reply) => {
    const name = String(req.body?.name || '');
    const description = String(req.body?.description || '');
    const body = typeof req.body?.body === 'string' ? req.body.body : undefined;
    try {
      const r = await createSkill({ name, description, body });
      if ('error' in r) return reply.status(400).send({ error: r.error });
      return { dir: r.dir, skills: await listSkills() };
    } catch (e) {
      return reply.status(500).send({ error: (e as Error).message });
    }
  });
}
