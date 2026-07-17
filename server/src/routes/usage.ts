import type { FastifyInstance } from 'fastify';
import type { UsageResponse } from '@macaron/shared';
import { fetchOAuthUsage } from '../lib/oauth-usage.js';
import { getActiveProviderRaw } from '../lib/settings-store.js';

export async function registerUsageRoutes(app: FastifyInstance): Promise<void> {
  // Rate-limit meters for the sidebar. Read-only, silently degrades: a null
  // result (no ambient login / unreachable endpoint) becomes available:false
  // and the client hides the widget. Never surfaces the OAuth token.
  app.get('/api/usage', async (): Promise<UsageResponse> => {
    if (getActiveProviderRaw() !== null) return { available: false, fiveHour: null, sevenDay: null };
    const usage = await fetchOAuthUsage();
    if (!usage) return { available: false, fiveHour: null, sevenDay: null };
    return { available: true, fiveHour: usage.fiveHour, sevenDay: usage.sevenDay };
  });
}
