import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  listWorktrees,
  getWorktree,
  mergeWorktree,
  discardWorktree,
  WorktreeError,
} from '../lib/worktree-store.js';

type Params = { sid: string };
type DiscardQuery = { force?: string };

// Run a worktree mutation; on failure map WorktreeError.conflict → 409 (so the
// client can prompt force/commit-first), everything else → 400.
async function runWorktreeOp(reply: FastifyReply, op: () => Promise<unknown>, ok: unknown) {
  try {
    await op();
    return ok;
  } catch (e) {
    const status = e instanceof WorktreeError && e.conflict ? 409 : 400;
    return reply.status(status).send({ error: (e as Error).message });
  }
}

export async function registerWorktreeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/worktrees', async () => {
    return { worktrees: await listWorktrees() };
  });

  app.get<{ Params: Params }>('/api/worktrees/:sid', async ({ params }, reply) => {
    const wt = await getWorktree(params.sid);
    if (!wt) return reply.status(404).send({ error: 'no worktree for this session' });
    return wt;
  });

  app.post<{ Params: Params }>('/api/worktrees/:sid/merge', async ({ params }, reply) =>
    runWorktreeOp(reply, () => mergeWorktree(params.sid), { ok: true, merged: true }),
  );

  app.post<{ Params: Params; Querystring: DiscardQuery }>(
    '/api/worktrees/:sid/discard',
    async ({ params, query }, reply) =>
      runWorktreeOp(reply, () => discardWorktree(params.sid, query.force === '1' || query.force === 'true'), { ok: true }),
  );
}
