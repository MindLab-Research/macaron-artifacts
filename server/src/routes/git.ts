import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { CreatePrRequest } from '@macaron/shared';
import { CLAUDE_PROJECTS } from '../config.js';
import {
  decodeClaudeProjectName,
  readSessionSummary,
  resolveProjectCwd,
} from '../lib/session-store.js';
import * as g from '../lib/git.js';

type ProjectParams = { project: string };
type SessionParams = { project: string; sid: string };

async function resolveSessionCwd(project: string, sid: string): Promise<string> {
  let cwd = decodeClaudeProjectName(project) || process.env.HOME || '/tmp';
  try {
    const head = await readSessionSummary(path.join(CLAUDE_PROJECTS, project, `${sid}.jsonl`));
    if (head?.cwd) cwd = head.cwd;
  } catch {
    /* fall back to decoded project name */
  }
  return cwd;
}

export async function registerGitRoutes(app: FastifyInstance): Promise<void> {
  // null = unregistered project (no session dir under CLAUDE_PROJECTS): fall
  // back to the decoded name so git runs (and reports isRepo:false) rather than
  // throwing on a null cwd.
  const cwdOf = async (project: string) =>
    (await resolveProjectCwd(project)) ?? decodeClaudeProjectName(project);

  const fail = (reply: import('fastify').FastifyReply, e: unknown) => {
    const code = e instanceof g.GitError ? 400 : 500;
    return reply.status(code).send({ error: (e as Error).message });
  };

  app.get<{ Params: ProjectParams }>('/api/git/:project/status', async ({ params }, reply) => {
    try {
      return await g.status(await cwdOf(params.project));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{
    Params: ProjectParams;
    Querystring: { file?: string; staged?: string; untracked?: string };
  }>(
    '/api/git/:project/diff',
    async ({ params, query }, reply) => {
      const file = String(query.file || '');
      if (!file) return reply.status(400).send({ error: 'file required' });
      try {
        const diff = await g.diff(await cwdOf(params.project), file, {
          staged: query.staged === '1' || query.staged === 'true',
          untracked: query.untracked === '1' || query.untracked === 'true',
        });
        return { diff };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.post<{ Params: ProjectParams; Body: { files?: string[] } }>(
    '/api/git/:project/stage',
    async ({ params, body }, reply) => {
      const files = Array.isArray(body?.files)
        ? body.files.filter((file) => typeof file === 'string')
        : [];
      if (files.length === 0) return reply.status(400).send({ error: 'files required' });
      try {
        await g.stage(await cwdOf(params.project), files);
        return { ok: true };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.post<{ Params: ProjectParams; Body: { files?: string[] } }>(
    '/api/git/:project/unstage',
    async ({ params, body }, reply) => {
      const files = Array.isArray(body?.files)
        ? body.files.filter((file) => typeof file === 'string')
        : [];
      if (files.length === 0) return reply.status(400).send({ error: 'files required' });
      try {
        await g.unstage(await cwdOf(params.project), files);
        return { ok: true };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.post<{ Params: ProjectParams; Body: { message?: string; all?: boolean } }>(
    '/api/git/:project/commit',
    async ({ params, body }, reply) => {
      const message = String(body?.message || '').trim();
      if (!message) return reply.status(400).send({ error: 'message required' });
      try {
        const output = await g.commit(await cwdOf(params.project), message, Boolean(body?.all));
        return { ok: true, output };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.get<{ Params: ProjectParams }>('/api/git/:project/branches', async ({ params }, reply) => {
    try {
      return await g.branches(await cwdOf(params.project));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Params: ProjectParams; Body: { branch?: string; create?: boolean } }>(
    '/api/git/:project/checkout',
    async ({ params, body }, reply) => {
      const branch = String(body?.branch || '').trim();
      if (!branch) return reply.status(400).send({ error: 'branch required' });
      try {
        const output = await g.checkout(await cwdOf(params.project), branch, Boolean(body?.create));
        return { ok: true, output };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.get<{ Params: SessionParams }>(
    '/api/sessions/claude/:project/:sid/pr-context',
    async ({ params }, reply) => {
      try {
        return await g.getPrContext(await resolveSessionCwd(params.project, params.sid));
      } catch (e) {
        return reply.status(400).send({ error: (e as Error).message });
      }
    },
  );

  app.post<{ Params: SessionParams; Body: CreatePrRequest }>(
    '/api/sessions/claude/:project/:sid/pr',
    async ({ params, body }, reply) => {
      const title = String(body?.title || '').trim();
      if (!title) return reply.status(400).send({ error: 'title required' });
      try {
        return await g.createPr(
          await resolveSessionCwd(params.project, params.sid),
          {
            title,
            body: String(body?.body || ''),
            draft: Boolean(body?.draft),
          },
        );
      } catch (e) {
        return reply.status(400).send({ error: (e as Error).message });
      }
    },
  );
}
