import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import {
  basename,
  groupWorkspaces,
  listAllSessions,
  resolveProjectCwd,
  searchProjectFiles,
} from '../lib/session-store.js';
import { startSSE, sseSend, sseDone } from '../lib/sse.js';
import { liveStart, livePush, liveEnd } from '../lib/live-registry.js';
import { runClaude, runFollowup, type AttachedImage } from '../lib/claude-runner.js';
import { registerRun, endRun } from '../lib/active-runs.js';
import { getActiveProviderEnv, getFollowupSuggestionsEnabled } from '../lib/settings-store.js';
import { lookupProjectCwd } from '../lib/project-registry.js';
import { pushPermissionRequest, pushSessionDone } from '../lib/push-notify.js';
import { createWorktree, bindWorktree, cleanupPendingWorktree, type PendingWorktree } from '../lib/worktree-store.js';

type Params = { project: string };
type NewSessionBody = {
  text?: string;
  model?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  images?: AttachedImage[];
  // When true, run this session in a dedicated git worktree + branch off the
  // repo's current HEAD, so it doesn't share the working tree with siblings.
  // Silently no-ops if the derived cwd isn't a git work tree.
  isolate?: boolean;
  // Absolute directory to start the session in. Set by the directory picker
  // for brand-new workspaces; when present it wins over deriving cwd from the
  // (lossy) project name, so a session can begin in any folder on disk.
  cwd?: string;
};

function firstQuery(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return typeof v === 'string' ? v : undefined;
}

// grep result shape sent to the client.
type GrepHit = { path: string; matches: { line: number; text: string }[] };

// Full-text search inside a repo. Prefers `git grep` when the cwd is a
// working tree (fast + honours .gitignore); otherwise falls back to
// `grep -rIn` with common vendor excludes. Times out at 5s and caps
// output so a huge repo can't OOM the response.
async function grepInRepo(cwd: string, needle: string, limit: number): Promise<GrepHit[]> {
  const isGit = await fs
    .stat(cwd + '/.git')
    .then(() => true)
    .catch(() => false);
  const args = isGit
    ? ['grep', '-Iin', '--max-count=3', '-e', needle]
    : [
        'grep', '-rIn', '--max-count=3',
        '--exclude-dir=node_modules', '--exclude-dir=.git',
        '--exclude-dir=dist', '--exclude-dir=build',
        '--exclude-dir=.next', '--exclude-dir=.turbo', '--exclude-dir=.cache',
        '--exclude-dir=.venv', '--exclude-dir=__pycache__',
        '--exclude=*.min.js', '--exclude=*.lock',
        '-e', needle, '.',
      ];
  const bin = isGit ? 'git' : args.shift()!;
  const stdout = await new Promise<string>((resolve) => {
    const proc = spawn(bin, args, { cwd, shell: false });
    let out = '';
    let bytes = 0;
    const cap = 1024 * 1024; // 1MB output cap
    const timeout = setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* nop */ } }, 5000);
    proc.stdout.on('data', (b) => {
      if (bytes >= cap) return;
      bytes += b.length;
      out += b.toString('utf8', 0, Math.min(b.length, cap - (bytes - b.length)));
    });
    proc.on('close', () => { clearTimeout(timeout); resolve(out); });
    proc.on('error', () => { clearTimeout(timeout); resolve(''); });
  });

  const byPath = new Map<string, { line: number; text: string }[]>();
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    // `git grep -n` / `grep -rn` format: `path:lineno:text` (path may contain
    // colons on Windows, but Macaron runs on macOS/Linux where paths don't).
    const m = /^([^:]+):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    const [, p, lineNoStr, text] = m;
    const rel = p!.replace(/^\.\//, '');
    const arr = byPath.get(rel) ?? [];
    if (arr.length < 3) {
      arr.push({ line: Number(lineNoStr), text: text!.slice(0, 240) });
      byPath.set(rel, arr);
    }
    if (byPath.size >= limit) break;
  }
  return Array.from(byPath, ([path, matches]) => ({ path, matches }));
}

function numberQuery(v: unknown, fallback: number): number {
  const raw = firstQuery(v);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export async function registerWorkspaceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/workspaces', async () => {
    const sessions = await listAllSessions();
    return { workspaces: groupWorkspaces(sessions) };
  });

  app.get<{ Params: Params }>('/api/workspaces/:project', async ({ params }) => {
    const sessions = await listAllSessions();
    const mine = sessions.filter((s) => s.project === params.project);
    // A just-created project has no sessions yet — fall back to the cwd the
    // wizard registered so the canvas header shows the real path + name
    // instead of the lossy-encoded project slug.
    const freshCwd = (await lookupProjectCwd(params.project)) || '';
    const meta =
      groupWorkspaces(mine)[0] || {
        project: params.project,
        cwd: freshCwd,
        name: basename(freshCwd) || params.project,
        sessionCount: 0,
        lastActivity: 0,
        lastSessionId: '',
        lastPreview: '',
      };
    return { workspace: meta, sessions: mine };
  });

  // Fuzzy-ish file search under the project's cwd for the composer's @-mention
  // autocomplete. Substring match on repo-relative paths; capped + skip-listed.
  app.get<{ Params: Params; Querystring: { q?: string; limit?: string } }>(
    '/api/workspaces/:project/files',
    async (req, reply) => {
      try {
        const limit = numberQuery(req.query?.limit, 50);
        return await searchProjectFiles(req.params.project, firstQuery(req.query?.q) ?? '', limit);
      } catch (e) {
        return reply.status(400).send({ error: (e as Error).message });
      }
    },
  );

  // Full-text search across the project's tracked source files. Shells out
  // to `git grep` when the cwd is a git repo (fast, honours .gitignore),
  // falls back to plain `grep -r` with common vendor / build excludes.
  // Returns `{ cwd, results: [{ path, matches: [{ line, text }] }] }`,
  // capped at ~200 files with up to 3 hit lines each so the response
  // stays small enough to render inline.
  app.get<{ Params: Params; Querystring: { q?: string; limit?: string } }>(
    '/api/workspaces/:project/files/content',
    async (req, reply) => {
      const q = (firstQuery(req.query?.q) ?? '').trim();
      const limit = Math.min(Math.max(numberQuery(req.query?.limit, 100), 1), 200);
      if (!q || q.length < 2) return { cwd: '', results: [] };
      const cwd = await resolveProjectCwd(req.params.project);
      if (!cwd) return reply.status(404).send({ error: 'project not found' });
      try {
        const results = await grepInRepo(cwd, q, limit);
        return { cwd, results };
      } catch (e) {
        return reply.status(500).send({ error: (e as Error).message });
      }
    },
  );

  app.post<{ Params: Params; Body: NewSessionBody }>(
    '/api/workspaces/:project/sessions',
    async (req, reply) => {
      const project = req.params.project;
      const text = String(req.body?.text || '').trim();
      const images = Array.isArray(req.body?.images) ? req.body!.images! : [];
      const permissionMode = req.body?.permissionMode || 'default';
      if (!text && images.length === 0) {
        return reply.status(400).send({ error: 'text or images required' });
      }
      // Active provider (from Settings) picks the SDK's backing endpoint.
      // The `model` body field is currently ignored — provider is global.
      const { model, env: providerEnv } = getActiveProviderEnv();

      // The directory picker supplies an explicit cwd for brand-new projects.
      // Otherwise prefer a live session, then the trusted New-Project registry;
      // an arbitrary route param must never decode into a filesystem root.
      const explicitCwd = String(req.body?.cwd || '').trim();
      let cwd: string;
      if (explicitCwd) {
        cwd = explicitCwd;
      } else {
        const registeredCwd = await lookupProjectCwd(project);
        const resolvedCwd =
          (await resolveProjectCwd(project, registeredCwd)) || registeredCwd;
        if (!resolvedCwd) {
          return reply.status(404).send({ error: 'unknown project' });
        }
        cwd = resolvedCwd;
      }

      try {
        const st = await fs.stat(cwd);
        if (!st.isDirectory()) throw new Error('cwd not a directory');
      } catch (e) {
        return reply.status(400).send({ error: `cwd unusable: ${cwd} (${(e as Error).message})` });
      }

      // Optional worktree isolation: create a dedicated branch+worktree off the
      // repo's HEAD and run the agent there. Created BEFORE the run so cwd
      // exists; the record is bound to the sessionId once the SDK emits it.
      let pendingWt: PendingWorktree | null = null;
      if (req.body?.isolate) {
        try {
          pendingWt = await createWorktree(cwd);
          if (pendingWt) cwd = pendingWt.worktreePath;
        } catch (e) {
          return reply.status(400).send({ error: `worktree create failed: ${(e as Error).message}` });
        }
      }

      startSSE(reply);
      sseSend(reply, { type: 'starting', cwd });

      // Pass an abortController so a later `/stop` (from the Session view
      // once it has a sid) can interrupt this stream. Navigating away does
      // NOT abort — only an explicit /stop does.
      const abortController = new AbortController();
      const startedAt = Date.now();
      const stream = runClaude({ prompt: text, cwd, model, permissionMode, images, envOverrides: providerEnv, abortController });

      let clientGone = false;
      reply.raw.on('close', () => {
        clientGone = true;
      });
      const safeSend = (payload: Parameters<typeof sseSend>[1]) => {
        if (clientGone) return;
        try {
          sseSend(reply, payload);
        } catch {
          clientGone = true;
        }
      };

      let capturedSid = '';
      // Run the iterator in the background so this handler returns immediately
      // (Fastify supports hijacked replies as long as we don't await forever).
      (async () => {
        for await (const ev of stream) {
          if (ev.kind === 'session' && !capturedSid) {
            capturedSid = ev.sessionId;
            liveStart(capturedSid, { cwd, startedAt });
            registerRun(capturedSid, abortController);
            if (pendingWt) bindWorktree(capturedSid, pendingWt).catch(() => {});
            livePush(capturedSid, { type: 'user-text', text, images });
            safeSend({ type: 'meta', cwd, sessionId: capturedSid, startedAt });
          } else if (ev.kind === 'delta') {
            safeSend({ type: 'delta', text: ev.text });
            if (capturedSid) livePush(capturedSid, { type: 'delta', text: ev.text });
          } else if (ev.kind === 'tool_use') {
            const payload = { type: 'tool_use' as const, id: ev.id, name: ev.name, input: ev.input };
            safeSend(payload);
            if (capturedSid) livePush(capturedSid, payload);
          } else if (ev.kind === 'tool_input_delta') {
            const payload = { type: 'tool_input_delta' as const, id: ev.id, name: ev.name, partial_json: ev.partial_json, accumulated: ev.accumulated };
            safeSend(payload);
            if (capturedSid) livePush(capturedSid, payload);
          } else if (ev.kind === 'tool_input_done') {
            const payload = { type: 'tool_input_done' as const, id: ev.id, name: ev.name, final_json: ev.final_json };
            safeSend(payload);
            if (capturedSid) livePush(capturedSid, payload);
          } else if (ev.kind === 'tool_result') {
            const payload = { type: 'tool_result' as const, tool_use_id: ev.tool_use_id, text: ev.text, isError: ev.isError };
            safeSend(payload);
            if (capturedSid) livePush(capturedSid, payload);
          } else if (ev.kind === 'permission_request') {
            const payload = { type: 'permission_request' as const, id: ev.id, toolName: ev.toolName, input: ev.input, suggestion: ev.suggestion };
            safeSend(payload);
            if (capturedSid) {
              livePush(capturedSid, payload);
              pushPermissionRequest(project, capturedSid, ev.toolName);
            }
          } else if (ev.kind === 'permission_resolved') {
            const payload = { type: 'permission_resolved' as const, id: ev.id, decision: ev.decision };
            safeSend(payload);
            if (capturedSid) livePush(capturedSid, payload);
          } else if (ev.kind === 'usage') {
            const payload = { type: 'usage' as const, outputTokens: ev.outputTokens, thinkingTokens: ev.thinkingTokens };
            safeSend(payload);
            if (capturedSid) livePush(capturedSid, payload);
          } else if (ev.kind === 'message') {
            safeSend({ type: 'event', event: 'system', subtype: ev.subtype });
            if (capturedSid) livePush(capturedSid, { type: 'event', event: 'system', subtype: ev.subtype });
          } else if (ev.kind === 'error') {
            safeSend({ type: 'error', error: ev.error });
            if (capturedSid) livePush(capturedSid, { type: 'error', error: ev.error });
          } else if (ev.kind === 'done') {
            safeSend({ type: 'done', exitCode: ev.exitCode });
            if (capturedSid) {
              liveEnd(capturedSid, { type: 'done', exitCode: ev.exitCode });
              endRun(capturedSid);
              pushSessionDone(project, capturedSid);
            }
            // Same post-turn follow-up as the resume path: stream a throwaway,
            // persistSession:false query resuming this fresh session (shared
            // prefix → cache hit). Best-effort; never blocks the turn close.
            // Gated on exitCode 0 so an abort/error stays identical to before.
            if (!clientGone && capturedSid && ev.exitCode === 0 && getFollowupSuggestionsEnabled()) {
              try {
                for await (const delta of runFollowup({ resume: capturedSid, cwd, model, envOverrides: providerEnv })) {
                  if (clientGone) break;
                  safeSend({ type: 'followup_delta', text: delta });
                }
              } catch {
                /* swallow: follow-up is enrichment, never fatal */
              }
            }
            if (!clientGone) sseDone(reply);
          }
        }
        // Stream ended without ever emitting a session (startup failure: bad
        // provider/auth/model). Tear down the pre-created worktree so it doesn't
        // leak untracked — bindWorktree only runs when capturedSid is set.
        if (pendingWt && !capturedSid) await cleanupPendingWorktree(pendingWt);
      })().catch((e: unknown) => {
        const msg = (e as Error).message;
        safeSend({ type: 'error', error: msg });
        if (pendingWt && !capturedSid) cleanupPendingWorktree(pendingWt).catch(() => {});
        if (capturedSid) {
          liveEnd(capturedSid, { type: 'done', exitCode: -1, error: msg });
          endRun(capturedSid);
        }
        if (!clientGone) sseDone(reply);
      });
    },
  );
}
