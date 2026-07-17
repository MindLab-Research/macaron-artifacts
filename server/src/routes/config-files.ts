import type { FastifyInstance } from 'fastify';
import {
  isConfigFileId,
  listConfigFiles,
  readConfigFile,
  writeConfigFile,
} from '../lib/config-files.js';

type WriteBody = { content?: string };

export async function registerConfigFileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/config-files', async () => ({ files: await listConfigFiles() }));

  app.get<{ Params: { id: string } }>('/api/config-files/:id', async (req, reply) => {
    if (!isConfigFileId(req.params.id)) return reply.status(404).send({ error: 'unknown config file' });
    return await readConfigFile(req.params.id);
  });

  app.put<{ Params: { id: string }; Body: WriteBody }>(
    '/api/config-files/:id',
    async (req, reply) => {
      if (!isConfigFileId(req.params.id)) return reply.status(404).send({ error: 'unknown config file' });
      if (typeof req.body?.content !== 'string') {
        return reply.status(400).send({ error: 'content (string) required' });
      }
      try {
        return await writeConfigFile(req.params.id, req.body.content);
      } catch (e) {
        // Validation failure (bad JSON / schema) — surface as 400 so the
        // editor can show the reason inline instead of a generic 500.
        return reply.status(400).send({ error: (e as Error).message });
      }
    },
  );
}
