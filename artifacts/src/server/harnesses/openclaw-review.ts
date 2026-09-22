import type { ProviderReview } from '../../shared/types.js';
import { record } from './common.js';

type Identity = { key: string; id?: string };

// Official Control UI literal-key route. ~key avoids slug/UUID-prefix discovery.
// Grammar: openclaw/packages/session-url-contract/src/parse.ts, not legacy ?session=.
export function openClawReviewUrl(base: string | undefined, key: string): string | undefined {
  if (!base) return;
  try {
    const url = new URL(base), parts = key.split(':');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return;
    if (parts[0] !== 'agent' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(parts[1] ?? '') || parts.length < 3 || parts.some(part => !part || /[\x00-\x1f\x7f]/.test(part))) return;
    const encode = (part: string) => part === '.' ? '~dot' : part === '..' ? '~dotdot' : encodeURIComponent(part).replaceAll('.', '%2E').replace(/^~/, '~~');
    return `${url.origin}${url.pathname.replace(/\/$/, '')}/chat/${encode(parts[1]!)}/~key/${parts.slice(2).map(encode).join('/')}`;
  } catch { return; }
}

export function readProviderReview(value: unknown, session: Identity, controlBase?: string): ProviderReview | undefined {
  if (value == null) return;
  const review = record(value);
  if (typeof review.id !== 'string' || !review.id || typeof review.runId !== 'string' || !review.runId || typeof review.canContinue !== 'boolean' || !session.id) throw new Error('OpenClaw returned an invalid provider review; the session remains blocked.');
  if (review.explanation !== undefined && typeof review.explanation !== 'string' || review.continuationMessage !== undefined && typeof review.continuationMessage !== 'string') throw new Error('OpenClaw returned invalid provider review text.');
  return { id: review.id, runId: review.runId, sessionId: session.id, canContinue: review.canContinue, explanation: review.explanation as string | undefined, continuationMessage: review.canContinue ? review.continuationMessage as string | undefined : undefined, controlUrl: openClawReviewUrl(controlBase, session.key) };
}

export async function describeProviderReview(client: { request<T>(method: string, params: unknown, options?: { timeoutMs: number }): Promise<T> }, session: Identity, agentId?: string, controlBase?: string) {
  // expectedSessionId is NOT a sessions.describe parameter. Verify the returned generation.
  const response = record(await client.request('sessions.describe', { key: session.key, ...(agentId ? { agentId } : {}) }, { timeoutMs: 5000 }));
  const row = record(response.session);
  if (response.key !== session.key || row.key !== session.key || typeof row.sessionId !== 'string' || !row.sessionId || session.id && row.sessionId !== session.id) throw new Error('OpenClaw session identity could not be verified; review status was not cleared.');
  return { sessionId: row.sessionId, review: readProviderReview(row.providerReview, { key: session.key, id: row.sessionId }, controlBase) };
}
