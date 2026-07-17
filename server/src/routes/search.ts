import type { FastifyInstance } from 'fastify';
import type { SearchResponse } from '@macaron/shared';
import { isSearchEnabled, search, syncAll, indexStats } from '../lib/search-index.js';

export async function registerSearchRoutes(app: FastifyInstance): Promise<void> {
  // Full-text search across every indexed session. `q` is the raw user query;
  // an empty/whitespace query returns no hits rather than erroring.
  app.get<{ Querystring: { q?: string; limit?: string } }>('/api/search', async (req) => {
    const query = String(req.query?.q || '').trim();
    if (!isSearchEnabled()) {
      return { enabled: false, query, hits: [] } satisfies SearchResponse;
    }
    if (!query) return { enabled: true, query, hits: [] } satisfies SearchResponse;
    const limit = Number(req.query?.limit) || 40;
    const hits = await search(query, limit);
    return { enabled: true, query, hits } satisfies SearchResponse;
  });

  // Force a full re-sync of the index from disk. Handy after bulk session
  // changes; normal searches already self-refresh on a throttle.
  app.post('/api/search/reindex', async (_req, reply) => {
    if (!isSearchEnabled()) {
      return reply.status(400).send({ error: 'search is disabled (MACARON_SEARCH=0)' });
    }
    const r = await syncAll();
    return { ok: true, ...r, ...indexStats() };
  });
}
