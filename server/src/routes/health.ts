import type { FastifyInstance } from 'fastify';
import { getActiveProviderEnv } from '../lib/settings-store.js';
import { isSearchEnabled, indexStats } from '../lib/search-index.js';
import { startSSE, sseSend } from '../lib/sse.js';
import { subscribeSystemEvents } from '../lib/session-watcher.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => {
    const { model } = getActiveProviderEnv();
    return {
      ok: true,
      model: model || null,
      search: isSearchEnabled() ? indexStats() : null,
    };
  });

  // Engine banner — which SPA the server is booting (MACARON_ENGINE). One
  // handler for all engines; unset means claude.
  app.get('/api/engine', async () => ({
    engine: process.env.MACARON_ENGINE === 'kimi' ? 'kimi' : process.env.MACARON_ENGINE === 'codex' ? 'codex' : 'claude',
  }));

  // System event stream: the server watches the claude/codex/kimi transcript trees and
  // pushes a `sessions-changed` nudge here whenever a transcript changes on
  // disk — including sessions started outside the WebUI. Long-lived SSE; a
  // heartbeat comment keeps proxies from closing the idle connection.
  app.get('/api/events', async (_req, reply) => {
    startSSE(reply);
    sseSend(reply, { type: 'connected' });
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 30_000);
    reply.raw.on('close', () => clearInterval(heartbeat));
    subscribeSystemEvents(reply);
  });
}
