import type { FastifyInstance } from 'fastify';
import { probeProvider } from '../lib/provider-probe.js';
import {
  readSettings,
  readPublicSettings,
  addProvider,
  updateProvider,
  deleteProvider,
  setActiveProvider,
  setDefaultPermissionMode,
  setFollowupSuggestionsEnabled,
  type DefaultPermissionMode,
} from '../lib/settings-store.js';

type AddBody = { name?: string; endpoint?: string; model?: string; apiKey?: string };
type UpdateBody = { name?: string; endpoint?: string; model?: string; apiKey?: string };
type ActiveBody = { providerId?: string };
type TestBody = { id?: string; endpoint?: string; model?: string; apiKey?: string };
type PermissionModeBody = { mode?: DefaultPermissionMode };
type FollowupsBody = { enabled?: boolean };

const PERMISSION_MODES: readonly DefaultPermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
] as const;

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async () => await readPublicSettings());

  app.post<{ Body: AddBody }>('/api/settings/providers', async (req, reply) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const endpoint = String(b.endpoint || '').trim();
    const model = String(b.model || '').trim();
    const apiKey = String(b.apiKey || '');
    if (!name) return reply.status(400).send({ error: 'name required' });
    if (!endpoint) return reply.status(400).send({ error: 'endpoint required' });
    if (!model) return reply.status(400).send({ error: 'model required' });
    try {
      const created = await addProvider({ name, endpoint, model, apiKey });
      return { id: created.id, settings: await readPublicSettings() };
    } catch (e) {
      return reply.status(500).send({ error: (e as Error).message });
    }
  });

  app.put<{ Params: { id: string }; Body: UpdateBody }>(
    '/api/settings/providers/:id',
    async (req, reply) => {
      const b = req.body || {};
      const patch: UpdateBody = {};
      if (typeof b.name === 'string') patch.name = b.name;
      if (typeof b.endpoint === 'string') patch.endpoint = b.endpoint;
      if (typeof b.model === 'string') patch.model = b.model;
      if (typeof b.apiKey === 'string') patch.apiKey = b.apiKey;
      try {
        const updated = await updateProvider(req.params.id, patch);
        if (!updated) return reply.status(404).send({ error: 'provider not found' });
        return await readPublicSettings();
      } catch (e) {
        return reply.status(500).send({ error: (e as Error).message });
      }
    },
  );

  // Smoke test a provider draft before it's saved. `id` lets the form probe an
  // existing row whose key the client never sees ("leave blank to keep").
  app.post<{ Body: TestBody }>('/api/settings/providers/test', async (req, reply) => {
    const b = req.body || {};
    const endpoint = String(b.endpoint || '').trim();
    const model = String(b.model || '').trim();
    let apiKey = String(b.apiKey || '');
    if (!endpoint) return reply.status(400).send({ error: 'endpoint required' });
    if (!model) return reply.status(400).send({ error: 'model required' });
    if (!apiKey && b.id) {
      const s = await readSettings();
      apiKey = s.customProviders.find((p) => p.id === b.id)?.apiKey || '';
    }
    if (!apiKey) return reply.status(400).send({ error: 'API key required' });
    return await probeProvider({ endpoint, model, apiKey });
  });

  app.delete<{ Params: { id: string } }>(
    '/api/settings/providers/:id',
    async (req, reply) => {
      try {
        const ok = await deleteProvider(req.params.id);
        if (!ok) return reply.status(404).send({ error: 'provider not found' });
        return await readPublicSettings();
      } catch (e) {
        return reply.status(500).send({ error: (e as Error).message });
      }
    },
  );

  app.put<{ Body: ActiveBody }>('/api/settings/active', async (req, reply) => {
    const id = String(req.body?.providerId || '');
    if (!id) return reply.status(400).send({ error: 'providerId required' });
    try {
      const ok = await setActiveProvider(id);
      if (!ok) return reply.status(404).send({ error: 'provider not found' });
      return await readPublicSettings();
    } catch (e) {
      return reply.status(500).send({ error: (e as Error).message });
    }
  });

  // Set the global default permission mode. New sessions initialise their
  // per-session picker to this value; sessions may still override themselves.
  app.put<{ Body: PermissionModeBody }>('/api/settings/permission-mode', async (req, reply) => {
    const mode = req.body?.mode;
    if (!mode || !(PERMISSION_MODES as readonly string[]).includes(mode)) {
      return reply.status(400).send({ error: 'mode required — one of default|acceptEdits|plan|bypassPermissions' });
    }
    try {
      await setDefaultPermissionMode(mode);
      return await readPublicSettings();
    } catch (e) {
      return reply.status(500).send({ error: (e as Error).message });
    }
  });

  app.put<{ Body: FollowupsBody }>('/api/settings/followups', async (req, reply) => {
    if (typeof req.body?.enabled !== 'boolean') {
      return reply.status(400).send({ error: 'enabled (boolean) required' });
    }
    try {
      await setFollowupSuggestionsEnabled(req.body.enabled);
      return await readPublicSettings();
    } catch (e) {
      return reply.status(500).send({ error: (e as Error).message });
    }
  });
}
