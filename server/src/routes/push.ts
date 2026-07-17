import type { FastifyInstance } from 'fastify';
import type { PushSubscriptionPayload } from '@macaron/shared';
import { getVapidPublicKey, saveSubscription, removeSubscription } from '../lib/push-store.js';

type SubscribeBody = Partial<PushSubscriptionPayload>;
type UnsubscribeBody = { endpoint?: string };

export async function registerPushRoutes(app: FastifyInstance): Promise<void> {
  // The client fetches this before PushManager.subscribe() and passes it as
  // applicationServerKey. Generated + persisted lazily by the store.
  app.get('/api/push/vapid-public-key', async () => ({ publicKey: await getVapidPublicKey() }));

  app.post<{ Body: SubscribeBody }>('/api/push/subscribe', async (req, reply) => {
    const b = req.body || {};
    if (!b.endpoint || !b.keys?.p256dh || !b.keys?.auth) {
      return reply.status(400).send({ error: 'endpoint + keys.p256dh + keys.auth required' });
    }
    await saveSubscription({ endpoint: b.endpoint, keys: { p256dh: b.keys.p256dh, auth: b.keys.auth } });
    return { ok: true };
  });

  app.post<{ Body: UnsubscribeBody }>('/api/push/unsubscribe', async (req, reply) => {
    const endpoint = String(req.body?.endpoint || '');
    if (!endpoint) return reply.status(400).send({ error: 'endpoint required' });
    await removeSubscription(endpoint);
    return { ok: true };
  });
}
