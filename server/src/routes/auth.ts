import type { FastifyInstance } from 'fastify';
import type { AuthStatusResponse } from '@macaron/shared';
import { extractToken, getArmedToken, isLocalRequest, tokensMatch } from '../lib/auth.js';

// These two paths are exempt from the auth hook so the login screen can always
// reach them. Both read the armed token live (getArmedToken) rather than a
// boot-time value, so a tunnel that arms a token after startup gates correctly.
export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // Whether THIS caller must authenticate: a token is armed, they aren't a
  // genuine local peer (a tunnel-forwarded request is not), and they aren't
  // already carrying a valid token (matching the auth hook so a stored token
  // survives a page reload instead of re-prompting).
  app.get('/api/auth/status', async (req): Promise<AuthStatusResponse> => {
    const token = getArmedToken();
    if (!token || isLocalRequest(req)) return { required: false };
    return { required: !tokensMatch(extractToken(req), token) };
  });

  app.post<{ Body: { token?: string } }>('/api/auth/login', async (req, reply) => {
    const token = getArmedToken();
    const provided = typeof req.body?.token === 'string' ? req.body.token : '';
    if (!token || tokensMatch(provided, token)) return { ok: true };
    return reply.code(401).send({ error: 'invalid token' });
  });
}
