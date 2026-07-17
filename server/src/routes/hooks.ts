import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { CLAUDE_PROJECTS } from '../config.js';
import { readSessionSummary } from '../lib/session-store.js';
import { readHooks } from '../lib/hooks-store.js';

type Query = { project?: string };

// Resolve a workspace's real cwd from an existing session's recorded cwd.
// Returns '' when no session records one, so the caller falls back to
// user-scope-only hooks. We deliberately do NOT decode `project` into a path:
// decodeClaudeProjectName is lossy and `project` is client-supplied, so
// trusting it would let a forged value read an arbitrary <dir>/.claude/settings.json.
async function resolveCwd(project: string): Promise<string> {
  try {
    const projDir = path.join(CLAUDE_PROJECTS, project);
    const files = await fs.readdir(projDir);
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const meta = await readSessionSummary(path.join(projDir, f));
      if (meta?.cwd) return meta.cwd;
    }
  } catch {
    /* no such project dir / no sessions — user-scope only */
  }
  return '';
}

export async function registerHooksRoutes(app: FastifyInstance): Promise<void> {
  // Read-only view of configured hooks. With ?project=<encoded> it also
  // includes that workspace's project + local settings.json; without it,
  // only user-scope (~/.claude/settings.json) hooks are returned.
  app.get<{ Querystring: Query }>('/api/hooks', async ({ query }) => {
    const project = String(query?.project || '');
    const cwd = project ? await resolveCwd(project) : undefined;
    return await readHooks(cwd);
  });
}
