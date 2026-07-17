import type { FastifyInstance } from 'fastify';
import {
  listCommands,
  getCommand,
  createCommand,
  updateCommand,
  deleteCommand,
  isValidName,
  type CommandInput,
} from '../lib/commands-store.js';

type SaveBody = { name?: string; description?: string; argumentHint?: string; body?: string };

function readInput(b: SaveBody): CommandInput {
  return {
    description: typeof b.description === 'string' ? b.description : '',
    argumentHint: typeof b.argumentHint === 'string' ? b.argumentHint : '',
    body: String(b.body || ''),
  };
}

function metadataError(input: CommandInput): string | null {
  if (/[\r\n]/.test(input.description || '') || /[\r\n]/.test(input.argumentHint || '')) return 'description and argument hint must be single-line';
  return null;
}

export async function registerCommandRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/commands', async () => ({ commands: await listCommands() }));

  app.get<{ Params: { name: string } }>('/api/commands/:name', async (req, reply) => {
    const cmd = await getCommand(req.params.name);
    if (!cmd) return reply.status(404).send({ error: 'command not found' });
    return cmd;
  });

  app.post<{ Body: SaveBody }>('/api/commands', async (req, reply) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().toLowerCase();
    if (!isValidName(name)) {
      return reply.status(400).send({ error: 'name must be lowercase letters, digits, dash or underscore' });
    }
    const input = readInput(b);
    const metaErr = metadataError(input);
    if (metaErr) return reply.status(400).send({ error: metaErr });
    if (!input.body.trim()) return reply.status(400).send({ error: 'body required' });
    try {
      return await createCommand(name, input);
    } catch (e) {
      const msg = (e as Error).message;
      return reply.status(msg === 'command already exists' ? 409 : 500).send({ error: msg });
    }
  });

  app.put<{ Params: { name: string }; Body: SaveBody }>('/api/commands/:name', async (req, reply) => {
    const input = readInput(req.body || {});
    const metaErr = metadataError(input);
    if (metaErr) return reply.status(400).send({ error: metaErr });
    if (!input.body.trim()) return reply.status(400).send({ error: 'body required' });
    try {
      const updated = await updateCommand(req.params.name, input);
      if (!updated) return reply.status(404).send({ error: 'command not found' });
      return updated;
    } catch (e) {
      return reply.status(500).send({ error: (e as Error).message });
    }
  });

  app.delete<{ Params: { name: string } }>('/api/commands/:name', async (req, reply) => {
    const ok = await deleteCommand(req.params.name);
    if (!ok) return reply.status(404).send({ error: 'command not found' });
    return { ok: true };
  });
}
