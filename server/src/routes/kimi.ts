// Kimi-only API surface. Mounted under /api/kimi/*. The claude and codex API
// namespaces stay pure — the engines don't cross-index each other.
//
// Shape:
//   GET  /api/kimi/threads                     — flat list of threads (sorted mtime desc)
//   GET  /api/kimi/threads/:sid                — full transcript
//   DELETE /api/kimi/threads/:sid              — delete session dir
//   POST /api/kimi/threads                     — start a new thread (SSE)
//   POST /api/kimi/threads/:sid/message        — resume + send (SSE)
//   POST /api/kimi/threads/:sid/stop           — abort in-flight run
//   GET/PUT /api/kimi/config                   — provider config CRUD

import { promises as fs } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  deleteKimiSession,
  listKimiSessions,
  readKimiSessionMessages,
} from '../lib/kimi-store.js';
import { groupWorkspaces } from '../lib/session-store.js';
import { runKimi } from '../lib/kimi-runner.js';
import {
  KIMI_SYSTEM_PROVIDER_ID,
  createKimiProvider,
  deleteKimiProvider,
  readPublicKimiSettings,
  setActiveKimiProvider,
  updateKimiProvider,
  type KimiCustomProvider,
} from '../lib/kimi-config.js';
import { startSSE, sseSend, sseDone } from '../lib/sse.js';
import { liveStart, livePush, liveEnd, liveGet } from '../lib/live-registry.js';
import { registerRun, claimRun, abortRun, endRun } from '../lib/active-runs.js';
import type { AttachedImage } from '../lib/claude-runner.js';
import type { SessionStreamEvent } from '@macaron/shared';

type SidParams = { sid: string };
type NewThreadBody = { text?: string; cwd?: string; images?: AttachedImage[] };
type MessageBody = { text?: string; images?: AttachedImage[] };

type KimiRouteOptions = {
  runKimi?: typeof runKimi;
  readKimiSessionMessages?: typeof readKimiSessionMessages;
};

export async function registerKimiRoutes(app: FastifyInstance, options: KimiRouteOptions = {}): Promise<void> {
  const runKimiForRoute = options.runKimi ?? runKimi;
  const readKimiSessionMessagesForRoute = options.readKimiSessionMessages ?? readKimiSessionMessages;
  // --- Threads -----------------------------------------------------------

  app.get('/api/kimi/threads', async () => {
    const threads = await listKimiSessions();
    return { threads };
  });

  // Workspaces = kimi threads grouped by cwd (same shape as the claude
  // /api/workspaces endpoint so the sidebar layout can mirror claude's).
  app.get('/api/kimi/workspaces', async () => {
    const sessions = await listKimiSessions();
    return { workspaces: groupWorkspaces(sessions) };
  });

  app.get<{ Params: { project: string } }>(
    '/api/kimi/workspaces/:project',
    async ({ params }) => {
      const sessions = await listKimiSessions();
      const mine = sessions.filter((s) => s.project === params.project);
      const meta =
        groupWorkspaces(mine)[0] || {
          project: params.project,
          cwd: '',
          name: params.project,
          sessionCount: 0,
          lastActivity: 0,
          lastSessionId: '',
          lastPreview: '',
        };
      return { workspace: meta, sessions: mine };
    },
  );

  app.get<{ Params: SidParams }>('/api/kimi/threads/:sid', async ({ params }, reply) => {
    try {
      return await readKimiSessionMessagesForRoute(params.sid);
    } catch (e) {
      return reply.status(404).send({ error: (e as Error).message });
    }
  });

  app.delete<{ Params: SidParams }>('/api/kimi/threads/:sid', async ({ params }, reply) => {
    try {
      await deleteKimiSession(params.sid);
      return { ok: true };
    } catch (e) {
      return reply.status(404).send({ error: (e as Error).message });
    }
  });

  // --- Send / resume -----------------------------------------------------

  const pipeKimiToSSE = (
    reply: Parameters<typeof startSSE>[0],
    stream: ReturnType<typeof runKimi>,
    sid: string | null,
    owner: AbortController,
    live: { cwd: string; text: string; hasImages: boolean },
  ) => {
    let clientGone = false;
    reply.raw.on('close', () => { clientGone = true; });
    const safeSend = (payload: Parameters<typeof sseSend>[1]) => {
      if (clientGone) return;
      try { sseSend(reply, payload); } catch { clientGone = true; }
    };
    let capturedSid = sid;
    // Mirror the Claude route: the primary client is written directly, while a
    // parallel copy of every event lands in the live registry so a browser
    // refresh mid-turn can reattach via the snapshot-then-live /live endpoint.
    let liveStarted = false;
    const ensureLive = () => {
      if (liveStarted || !capturedSid) return;
      liveStarted = true;
      liveStart(capturedSid, { cwd: live.cwd });
      // Seed the user bubble for the reattach snapshot whenever the turn had
      // any input — an image-only turn still needs its bubble.
      if (live.text || live.hasImages) livePush(capturedSid, { type: 'user-text', text: live.text });
    };
    ensureLive(); // resume already knows the sid; a new thread waits for `session`
    const relay = (payload: SessionStreamEvent) => {
      safeSend(payload);
      if (capturedSid) livePush(capturedSid, payload);
    };
    let terminalSent = false;
    const finishRun = (exitCode: number, error?: string) => {
      if (terminalSent) return;
      terminalSent = true;
      if (error) safeSend({ type: 'error', error });
      const done = { type: 'done' as const, exitCode, ...(error ? { error } : {}) };
      safeSend(done);
      if (capturedSid) {
        liveEnd(capturedSid, done);
        endRun(capturedSid, owner);
      }
    };
    void (async () => {
      try {
        for await (const ev of stream) {
          if (ev.kind === 'session' && !capturedSid) {
            capturedSid = ev.sessionId;
            ensureLive();
            safeSend({ type: 'meta', cwd: live.cwd, sessionId: capturedSid });
          } else if (ev.kind === 'delta') relay({ type: 'delta', text: ev.text });
          else if (ev.kind === 'tool_use') relay({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
          else if (ev.kind === 'tool_result') relay({ type: 'tool_result', tool_use_id: ev.tool_use_id, text: ev.text, isError: ev.isError });
          else if (ev.kind === 'usage') relay({ type: 'usage', outputTokens: ev.outputTokens, thinkingTokens: ev.thinkingTokens });
          else if (ev.kind === 'message') relay({ type: 'event', event: 'system', subtype: ev.subtype });
          else if (ev.kind === 'error') relay({ type: 'error', error: ev.error });
          else if (ev.kind === 'done') {
            finishRun(ev.exitCode);
            return;
          }
        }
        finishRun(-1, 'runner ended without a terminal event');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        finishRun(-1, msg);
      } finally {
        // Owner-guarded and idempotent: a stale iterator cannot release a newer
        // controller, while every settled iterator gives up its own claim.
        if (capturedSid) endRun(capturedSid, owner);
        if (!clientGone) sseDone(reply);
      }
    })();
  };

  app.post<{ Body: NewThreadBody }>('/api/kimi/threads', async (req, reply) => {
    const text = String(req.body?.text || '').trim();
    const images = Array.isArray(req.body?.images) ? req.body!.images! : [];
    const cwd = String(req.body?.cwd || process.env.HOME || '/tmp');
    if (!text && images.length === 0) {
      return reply.status(400).send({ error: 'text or images required' });
    }
    try {
      const st = await fs.stat(cwd);
      if (!st.isDirectory()) throw new Error('cwd not a directory');
    } catch (e) {
      return reply.status(400).send({ error: `cwd unusable: ${cwd} (${(e as Error).message})` });
    }
    startSSE(reply);
    sseSend(reply, { type: 'starting', cwd });
    const abortController = new AbortController();
    const stream = runKimiForRoute({ prompt: text, cwd, images, abortController });
    // pipeKimiToSSE owns the iteration, so wrap the runner to install the abort
    // under the sid once the first `session` event reveals it.
    const wrapped = (async function* () {
      for await (const ev of stream) {
        if (ev.kind === 'session') registerRun(ev.sessionId, abortController);
        yield ev;
      }
    })();
    pipeKimiToSSE(reply, wrapped as ReturnType<typeof runKimi>, null, abortController, { cwd, text, hasImages: images.length > 0 });
  });

  app.post<{ Params: SidParams; Body: MessageBody }>(
    '/api/kimi/threads/:sid/message',
    async (req, reply) => {
      const sid = req.params.sid;
      const text = String(req.body?.text || '').trim();
      const images = Array.isArray(req.body?.images) ? req.body!.images! : [];
      if (!text && images.length === 0) {
        return reply.status(400).send({ error: 'text or images required' });
      }
      let cwd = process.env.HOME || '/tmp';
      try {
        const detail = await readKimiSessionMessagesForRoute(sid);
        if (detail.cwd) cwd = detail.cwd;
      } catch (e) {
        return reply.status(404).send({ error: (e as Error).message });
      }
      const abortController = new AbortController();
      if (!claimRun(sid, abortController)) {
        return reply.status(409).send({ error: 'a turn is already in flight for this thread' });
      }
      startSSE(reply);
      sseSend(reply, { type: 'meta', sessionId: sid, cwd });
      pipeKimiToSSE(reply, runKimiForRoute({ prompt: text, cwd, resume: sid, images, abortController }), sid, abortController, { cwd, text, hasImages: images.length > 0 });
    },
  );

  app.post<{ Params: SidParams }>('/api/kimi/threads/:sid/stop', async ({ params }, reply) => {
    const ok = abortRun(params.sid);
    return reply.send({ ok, running: ok });
  });

  // SSE: reattach to a Kimi turn. Replays the current snapshot (liveGet), then
  // forwards live events until the turn ends — so a browser refresh mid-turn
  // picks the stream back up instead of waiting for the wire.jsonl to land on
  // disk. Mirrors the codex route's /live handler.
  app.get<{ Params: SidParams }>('/api/kimi/threads/:sid/live', async ({ params }, reply) => {
    startSSE(reply);
    const ls = liveGet(params.sid);
    if (!ls) {
      sseSend(reply, { type: 'live-end', reason: 'not-live' });
      sseDone(reply);
      return;
    }
    // Replay the fully-buffered transcript even when the turn already ended:
    // the wire.jsonl is written asynchronously after `done`, so the disk
    // history can 404 or be partial right after a turn while the complete
    // buffer sits here for KEEP_AROUND_MS. The client reconciles any overlap.
    for (const ev of ls.events) {
      try { sseSend(reply, ev); } catch { return; }
    }
    if (ls.ended) {
      sseDone(reply);
      return;
    }
    ls.subs.add(reply);
    reply.raw.on('close', () => ls.subs.delete(reply));
  });

  // --- Config ------------------------------------------------------------

  app.get('/api/kimi/config', async () => readPublicKimiSettings());

  // Switch the active provider (system or a customProviders[].id).
  app.put<{ Body: { providerId?: string } }>('/api/kimi/config/active', async (req, reply) => {
    const id = String(req.body?.providerId || '').trim();
    if (!id) return reply.status(400).send({ error: 'providerId required' });
    try {
      await setActiveKimiProvider(id);
    } catch (e) {
      return reply.status(404).send({ error: (e as Error).message });
    }
    return reply.send(await readPublicKimiSettings());
  });

  // Create a new custom provider.
  app.post<{ Body: Partial<KimiCustomProvider> }>('/api/kimi/config/providers', async (req, reply) => {
    const created = await createKimiProvider(pickCustomProviderPatch(req.body || {}));
    return reply.send({ id: created.id, settings: await readPublicKimiSettings() });
  });

  // Update an existing custom provider (partial patch — omitted fields keep
  // their current value; apiKey is only overwritten if non-empty).
  app.put<{ Params: { id: string }; Body: Partial<KimiCustomProvider> }>(
    '/api/kimi/config/providers/:id',
    async (req, reply) => {
      const id = req.params.id;
      if (id === KIMI_SYSTEM_PROVIDER_ID) {
        return reply.status(400).send({ error: 'system provider is not editable' });
      }
      try {
        await updateKimiProvider(id, pickCustomProviderPatch(req.body || {}));
      } catch (e) {
        return reply.status(404).send({ error: (e as Error).message });
      }
      return reply.send(await readPublicKimiSettings());
    },
  );

  app.delete<{ Params: { id: string } }>('/api/kimi/config/providers/:id', async (req, reply) => {
    if (req.params.id === KIMI_SYSTEM_PROVIDER_ID) {
      return reply.status(400).send({ error: 'system provider cannot be deleted' });
    }
    await deleteKimiProvider(req.params.id);
    return reply.send(await readPublicKimiSettings());
  });

  function pickCustomProviderPatch(b: Partial<KimiCustomProvider>): Partial<KimiCustomProvider> {
    const patch: Partial<KimiCustomProvider> = {};
    if (typeof b.name === 'string') patch.name = b.name;
    if (typeof b.model === 'string') patch.model = b.model;
    if (typeof b.baseUrl === 'string') patch.baseUrl = b.baseUrl;
    if (typeof b.apiKey === 'string' && b.apiKey.length > 0) patch.apiKey = b.apiKey;
    if (b.providerType === 'kimi' || b.providerType === 'anthropic' || b.providerType === 'openai') patch.providerType = b.providerType;
    return patch;
  }
}
