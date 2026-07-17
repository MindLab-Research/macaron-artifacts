import type { FastifyInstance } from 'fastify';
import type { TunnelProvider } from '@macaron/shared';
import { getTunnelState, startTunnel, stopTunnel } from '../lib/tunnel-manager.js';

type StartBody = { provider?: string };

const VALID: TunnelProvider[] = ['cloudflared', 'ngrok'];

export async function registerTunnelRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/tunnel/status', async () => getTunnelState());

  app.post<{ Body: StartBody }>('/api/tunnel/start', async (req, reply) => {
    const provider = String(req.body?.provider || '') as TunnelProvider;
    if (!VALID.includes(provider)) return reply.status(400).send({ error: 'provider must be cloudflared or ngrok' });
    const cur = getTunnelState();
    if (cur.status === 'starting' || cur.status === 'running') {
      return reply.status(409).send({ error: 'a tunnel is already active', state: cur });
    }
    try {
      return await startTunnel(provider);
    } catch (e) {
      return reply.status(500).send({ error: (e as Error).message, state: getTunnelState() });
    }
  });

  app.post('/api/tunnel/stop', async () => stopTunnel());
}
