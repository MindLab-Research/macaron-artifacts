import type { FastifyInstance } from 'fastify';
import {
  deleteSession,
  duplicateSession,
  listSubagents,
  forkSession,
  readSessionMessages,
  resolveProjectCwd,
  readSubagentMessages,
  renameSession,
  resolveSessionCwd,
  rewindSession,
  searchMessages,
  writeCompactedSession,
} from '../lib/session-store.js';
import { startSSE, sseSend, sseDone } from '../lib/sse.js';
import { deleteLabel } from '../lib/label-store.js';
import { liveGet, liveStart, livePush, liveEnd } from '../lib/live-registry.js';
import { runClaude, runFollowup, type AttachedImage, type RunOptions, type RunnerEvent } from '../lib/claude-runner.js';
import { getActiveProviderEnv, getActiveProviderRaw, getFollowupSuggestionsEnabled } from '../lib/settings-store.js';
import { claimRun, abortRun, endRun } from '../lib/active-runs.js';
import { resolvePending } from '../lib/permission-registry.js';
import { pushPermissionRequest, pushSessionDone } from '../lib/push-notify.js';
import { listSlashCommands } from '../lib/slash-commands.js';
import type { SessionStreamEvent } from '@macaron/shared';

type Params = { project: string; sid: string };
type MessageBody = {
  text?: string;
  model?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  images?: AttachedImage[];
};

type SessionRouteOptions = {
  runClaude?: (opts: RunOptions) => AsyncGenerator<RunnerEvent>;
  getActiveProviderEnv?: typeof getActiveProviderEnv;
};

export async function registerSessionRoutes(app: FastifyInstance, options: SessionRouteOptions = {}): Promise<void> {
  const runClaudeForRoute = options.runClaude ?? runClaude;
  const getActiveProviderEnvForRoute = options.getActiveProviderEnv ?? getActiveProviderEnv;
  // Grep claude transcripts for a substring — backs the command palette's
  // message search. Newest-first, capped at `limit` hits (see searchMessages).
  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/api/search/messages',
    async ({ query }) => {
      const q = String(query?.q || '');
      const limit = Math.min(100, Math.max(1, parseInt(query?.limit || '30', 10) || 30));
      return { hits: await searchMessages(q, limit) };
    },
  );

  app.get<{ Params: Params }>('/api/sessions/claude/:project/:sid', async ({ params }, reply) => {
    try {
      return await readSessionMessages(params.project, params.sid);
    } catch (e) {
      return reply.status(404).send({ error: (e as Error).message });
    }
  });

  // List slash commands available for this session's cwd: curated built-ins
  // plus project (`<cwd>/.claude/commands`) and user (`~/.claude/commands`)
  // custom commands. Read-only, best-effort — never 500 on a missing dir.
  // The palette only *lists*; the SDK already expands `/name` prompts itself.
  app.get<{ Params: { project: string } }>(
    '/api/sessions/claude/:project/commands',
    async ({ params }) => {
      // Resolve the real cwd from a jsonl head — the decoded project name is
      // lossy and would send walkCommands to a non-existent dir, dropping
      // every project-scoped command (see resolveProjectCwd).
      const cwd = await resolveProjectCwd(params.project);
      return { commands: await listSlashCommands(cwd || '') };
    },
  );

  // List the subagents (child sessions) spawned from this transcript. Each is
  // linked to a parent `Agent` tool_use via `toolUseId` so the WebUI can turn
  // an inline Agent tool card into a drill-in link.
  app.get<{ Params: Params }>(
    '/api/sessions/claude/:project/:sid/subagents',
    async ({ params }) => ({ subagents: await listSubagents(params.project, params.sid) }),
  );

  // Read one subagent's full transcript, same shape as a normal session.
  app.get<{ Params: Params & { agentId: string } }>(
    '/api/sessions/claude/:project/:sid/subagents/:agentId',
    async ({ params }, reply) => {
      if (!/^[A-Za-z0-9_-]+$/.test(params.agentId)) return reply.status(400).send({ error: 'invalid subagent id' });
      try {
        return await readSubagentMessages(params.project, params.sid, params.agentId);
      } catch (e) {
        return reply.status(404).send({ error: (e as Error).message });
      }
    },
  );

  app.delete<{ Params: Params }>('/api/sessions/claude/:project/:sid', async ({ params }, reply) => {
    try {
      await deleteSession(params.project, params.sid);
      await deleteLabel(params.sid);
      return { ok: true };
    } catch (e) {
      return reply.status(404).send({ error: (e as Error).message });
    }
  });

  // Rename: append a native `custom-title` record to the Claude-owned jsonl,
  // the same way the CLI's `/rename` does — so the new name shows in both
  // macaron's sidebar and `claude --resume`, instead of diverging into a
  // separate label sidecar. A blank name clears the override.
  app.patch<{ Params: Params; Body: { name?: string } }>(
    '/api/sessions/claude/:project/:sid/label',
    async (req, reply) => {
      try {
        const label = await renameSession(req.params.project, req.params.sid, String(req.body?.name ?? ''));
        return reply.send({ ok: true, label });
      } catch (e) {
        return reply.status(404).send({ error: (e as Error).message });
      }
    },
  );

  // Duplicate: clone the jsonl to a fresh sid so both can be resumed
  // independently. Sidebar's context menu wires to this.
  app.post<{ Params: Params }>(
    '/api/sessions/claude/:project/:sid/duplicate',
    async ({ params }, reply) => {
      try {
        const r = await duplicateSession(params.project, params.sid);
        return { ok: true, ...r };
      } catch (e) {
        return reply.status(404).send({ error: (e as Error).message });
      }
    },
  );

  // Resolve a pending canUseTool call — { id, decision:'allow'|'deny', scope?, reason?, mode? }.
  // `mode` (allow only) exits plan mode into the chosen permission mode. Only the two
  // modes the plan-approval panel offers are honored — the Body type is advisory
  // (Fastify doesn't enforce it), so anything else (e.g. `bypassPermissions`) is
  // dropped here to keep a crafted POST from escalating the session's permissions.
  // `scope` (allow only): 'once' (default), 'session' (remember this server session),
  // or 'always' (persist for this project cwd).
  app.post<{ Body: { id?: string; decision?: 'allow' | 'deny'; reason?: string; scope?: 'once' | 'session' | 'always'; mode?: 'default' | 'acceptEdits' } }>(
    '/api/permission-decision',
    async (req, reply) => {
      const id = String(req.body?.id || '').trim();
      const dec = req.body?.decision;
      if (!id || (dec !== 'allow' && dec !== 'deny')) {
        return reply.status(400).send({ error: 'id + decision required' });
      }
      const mode = dec === 'allow' && (req.body?.mode === 'default' || req.body?.mode === 'acceptEdits') ? req.body.mode : undefined;
      const scope = req.body?.scope === 'session' || req.body?.scope === 'always' ? req.body.scope : 'once';
      const ok = resolvePending(
        id,
        dec === 'allow' ? { decision: 'allow', mode, scope } : { decision: 'deny', reason: req.body?.reason },
      );
      return reply.send({ ok });
    },
  );

  // Stop: abort the in-flight SDK stream for this session. No-op if no
  // stream is currently running under that sid.
  app.post<{ Params: Params }>(
    '/api/sessions/claude/:project/:sid/stop',
    async ({ params }, reply) => {
      const ok = abortRun(params.sid);
      return reply.send({ ok, running: ok });
    },
  );

  // Rewind: truncate the jsonl at the given message uuid — that message and
  // everything after it is dropped (with a .rewind-<ts>.jsonl.bak backup).
  app.post<{ Params: Params; Body: { uuid?: string } }>(
    '/api/sessions/claude/:project/:sid/rewind',
    async (req, reply) => {
      const uuid = String(req.body?.uuid || '').trim();
      if (!uuid) return reply.status(400).send({ error: 'uuid required' });
      try {
        const r = await rewindSession(req.params.project, req.params.sid, uuid);
        return { ok: true, ...r };
      } catch (e) {
        return reply.status(400).send({ error: (e as Error).message });
      }
    },
  );

  // Fork: copy the transcript up to (excluding) the given message uuid into a
  // fresh sid. Non-destructive twin of rewind — the original is untouched, so
  // the user branches off a new conversation from that point.
  app.post<{ Params: Params; Body: { uuid?: string } }>(
    '/api/sessions/claude/:project/:sid/fork',
    async (req, reply) => {
      const uuid = String(req.body?.uuid || '').trim();
      if (!uuid) return reply.status(400).send({ error: 'uuid required' });
      try {
        const r = await forkSession(req.params.project, req.params.sid, uuid);
        return { ok: true, ...r };
      } catch (e) {
        return reply.status(400).send({ error: (e as Error).message });
      }
    },
  );

  // Compact: replace transcript with a summary from the active provider.
  // Only works with a custom provider (system provider has no server-side
  // credentials to call an API directly).
  app.post<{ Params: Params }>(
    '/api/sessions/claude/:project/:sid/compact',
    async (req, reply) => {
      const provider = getActiveProviderRaw();
      if (!provider) {
        return reply.status(400).send({
          error: 'compact requires an active custom provider (system provider is unsupported)',
        });
      }
      let detail;
      try {
        detail = await readSessionMessages(req.params.project, req.params.sid);
      } catch (e) {
        return reply.status(404).send({ error: (e as Error).message });
      }
      // Build an Anthropic-shape message list from the current transcript.
      // Only text blocks matter for a recap — tool_use/tool_result would
      // exceed context and don't help summarise intent.
      type AMsg = { role: 'user' | 'assistant'; content: string };
      const msgs: AMsg[] = [];
      for (const m of detail.messages) {
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const text = m.blocks
          .map((b) => (b.kind === 'text' ? b.text : b.kind === 'thinking' ? '' : ''))
          .filter(Boolean)
          .join('\n')
          .trim();
        if (!text) continue;
        // Merge consecutive same-role turns so the request is a strict
        // alternating sequence (Anthropic's constraint).
        const prev = msgs[msgs.length - 1];
        if (prev && prev.role === m.role) prev.content += '\n\n' + text;
        else msgs.push({ role: m.role, content: text });
      }
      if (msgs.length === 0) {
        return reply.status(400).send({ error: 'nothing to compact — session has no text messages' });
      }
      // Cap each message at ~40k chars to stay within the summariser's
      // window even for very long sessions. Truncated tails are marked
      // explicitly so the model knows content was elided.
      const CAP = 40_000;
      for (const m of msgs) {
        if (m.content.length > CAP) {
          m.content = m.content.slice(0, CAP) + '\n\n[…truncated for summarization]';
        }
      }
      msgs.push({
        role: 'user',
        content:
          'Please write a concise recap of the entire conversation above. ' +
          'Focus on: goals, key decisions, remaining tasks, and the current in-progress work. ' +
          'One paragraph, no more than 250 words.',
      });

      const endpoint = provider.endpoint.replace(/\/+$/, '');
      const url = endpoint.endsWith('/v1') ? `${endpoint}/messages` : `${endpoint}/v1/messages`;
      let apiRes: Response;
      try {
        apiRes = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': provider.apiKey,
            authorization: `Bearer ${provider.apiKey}`,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: provider.model,
            max_tokens: 1024,
            system:
              'You are a conversation summarizer. Output ONLY the recap paragraph — no preamble, no headers, no bullet lists.',
            messages: msgs,
          }),
        });
      } catch (e) {
        return reply.status(502).send({ error: `provider fetch failed: ${(e as Error).message}` });
      }
      if (!apiRes.ok) {
        const body = await apiRes.text().catch(() => '');
        return reply.status(502).send({
          error: `provider returned ${apiRes.status}: ${body.slice(0, 500)}`,
        });
      }
      const json = (await apiRes.json().catch(() => null)) as
        | { content?: Array<{ type?: string; text?: string }> }
        | null;
      const summary =
        json?.content
          ?.filter((b) => b?.type === 'text')
          .map((b) => b?.text || '')
          .join('\n')
          .trim() || '';
      if (!summary) {
        return reply.status(502).send({ error: 'provider returned no summary text' });
      }
      try {
        const r = await writeCompactedSession(req.params.project, req.params.sid, summary);
        return { ok: true, summary, ...r };
      } catch (e) {
        return reply.status(500).send({ error: (e as Error).message });
      }
    },
  );

  // SSE: subscribe to a live spawn registered by /api/workspaces/.../sessions.
  // Replays buffered events, then forwards new ones until the spawn closes.
  app.get<{ Params: Params }>('/api/sessions/claude/:project/:sid/live', async (req, reply) => {
    startSSE(reply);
    const ls = liveGet(req.params.sid);
    if (!ls) {
      sseSend(reply, { type: 'live-end', reason: 'not-live' });
      sseDone(reply);
      return;
    }
    for (const ev of ls.events) {
      try {
        sseSend(reply, ev);
      } catch {
        return;
      }
    }
    if (ls.ended) {
      sseDone(reply);
      return;
    }
    ls.subs.add(reply);
    reply.raw.on('close', () => ls.subs.delete(reply));
  });

  // Proactive follow-ups for an already-idle session: resume + runFollowup
  // with NO main turn, so merely opening a finished conversation surfaces
  // suggestions too — not only the instant a turn ends. Same cache-hit prefix
  // as the post-turn path. Best-effort; gated on the global toggle.
  app.post<{ Params: Params }>(
    '/api/sessions/claude/:project/:sid/followups',
    async ({ params }, reply) => {
      const { project, sid } = params;
      startSSE(reply);
      if (!getFollowupSuggestionsEnabled()) { sseDone(reply); return; }

      const cwd = await resolveSessionCwd(project, sid);

      const { model: providerModel, env: providerEnv } = getActiveProviderEnvForRoute();
      let clientGone = false;
      reply.raw.on('close', () => { clientGone = true; });
      try {
        for await (const delta of runFollowup({ resume: sid, cwd, model: providerModel, envOverrides: providerEnv })) {
          if (clientGone) break;
          try { sseSend(reply, { type: 'followup_delta', text: delta }); } catch { clientGone = true; break; }
        }
      } catch { /* swallow: follow-up is enrichment, never fatal */ }
      if (!clientGone) sseDone(reply);
    },
  );

  // Send a message into an existing session (`claude -p --resume <sid>`).
  app.post<{ Params: Params; Body: MessageBody }>(
    '/api/sessions/claude/:project/:sid/message',
    async (req, reply) => {
      const { project, sid } = req.params;
      const text = String(req.body?.text || '').trim();
      const images = Array.isArray(req.body?.images) ? req.body!.images! : [];
      const model = req.body?.model || undefined;
      const permissionMode = req.body?.permissionMode || 'default';
      if (!text && images.length === 0) {
        return reply.status(400).send({ error: 'text or images required' });
      }

      // Prefer the cwd embedded in the jsonl's first line, else the decoded
      // project name (which claude-cli derives from the cwd).
      const cwd = await resolveSessionCwd(project, sid);

      // A session can only own one runner at a time. Keep the claim until that
      // runner's terminal cleanup so a refresh/duplicate tab cannot replace its
      // abort controller or live replay entry with a competing POST.
      const abortController = new AbortController();
      if (!claimRun(sid, abortController)) {
        return reply.status(409).send({ error: 'session already running' });
      }

      let clientGone = false;
      let sseStarted = false;
      let liveStarted = false;
      let terminalSent = false;
      reply.raw.on('close', () => { clientGone = true; });
      const safeSend = (payload: Parameters<typeof sseSend>[1]) => {
        if (!sseStarted || clientGone) return;
        try { sseSend(reply, payload); } catch { clientGone = true; }
      };

      const finishMainRun = (exitCode: number, error?: string) => {
        if (terminalSent) return;
        terminalSent = true;
        if (error) {
          safeSend({ type: 'error', error });
          if (liveStarted) livePush(sid, { type: 'error', error });
        }
        const done = { type: 'done' as const, exitCode, ...(error ? { error } : {}) };
        safeSend(done);
        if (liveStarted) liveEnd(sid, done);
        endRun(sid, abortController);
      };

      let provider: ReturnType<typeof getActiveProviderEnv>;
      try {
        // Mark setup as attempted before each call so a partial synchronous
        // failure still takes the corresponding terminal cleanup path.
        sseStarted = true;
        startSSE(reply);
        const startedAt = Date.now();
        safeSend({ type: 'meta', cwd, sessionId: sid, startedAt });

        // Keep a server-authoritative copy of this turn independent of the
        // original response. A browser refresh closes that response, but the SDK
        // keeps running; /live replays this ring and then follows new events.
        liveStarted = true;
        liveStart(sid, { cwd, startedAt });
        livePush(sid, { type: 'user-text', text, images });

        // The Settings-selected active provider determines which
        // Anthropic-compatible endpoint the SDK talks to (default = ambient
        // Claude login). Same tools, same jsonl, same everything.
        provider = getActiveProviderEnvForRoute();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        finishMainRun(-1, msg);
        if (!clientGone) sseDone(reply);
        return;
      }

      const relay = (payload: SessionStreamEvent) => {
        safeSend(payload);
        livePush(sid, payload);
      };

      const { model: providerModel, env: providerEnv } = provider;
      void model; // eslint: kept in body for future per-message override

      void (async () => {
        try {
          for await (const ev of runClaudeForRoute({ prompt: text, cwd, resume: sid, model: providerModel, permissionMode, images, envOverrides: providerEnv, abortController })) {
            if (ev.kind === 'delta') relay({ type: 'delta', text: ev.text });
            else if (ev.kind === 'tool_use') {
              relay({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
            }
            else if (ev.kind === 'tool_input_delta') {
              relay({ type: 'tool_input_delta', id: ev.id, name: ev.name, partial_json: ev.partial_json, accumulated: ev.accumulated });
            }
            else if (ev.kind === 'tool_input_done') {
              relay({ type: 'tool_input_done', id: ev.id, name: ev.name, final_json: ev.final_json });
            }
            else if (ev.kind === 'tool_result') relay({ type: 'tool_result', tool_use_id: ev.tool_use_id, text: ev.text, isError: ev.isError });
            else if (ev.kind === 'permission_request') { relay({ type: 'permission_request', id: ev.id, toolName: ev.toolName, input: ev.input, suggestion: ev.suggestion }); pushPermissionRequest(project, sid, ev.toolName); }
            else if (ev.kind === 'permission_resolved') relay({ type: 'permission_resolved', id: ev.id, decision: ev.decision });
            else if (ev.kind === 'usage') relay({ type: 'usage', outputTokens: ev.outputTokens, thinkingTokens: ev.thinkingTokens });
            else if (ev.kind === 'message') relay({ type: 'event', event: 'system', subtype: ev.subtype });
            else if (ev.kind === 'error') relay({ type: 'error', error: ev.error });
            else if (ev.kind === 'done') {
              // `done` is the main-turn ownership boundary. Follow-ups are
              // non-persisting enrichment, so release the live entry and claim
              // before generating them: queued/new user turns must be able to
              // start, while stale follow-up deltas are client-generation gated
              // and refreshes can regenerate them through /followups.
              finishMainRun(ev.exitCode);
              pushSessionDone(project, sid);
              // After the main turn: stream a throwaway follow-up-suggestions
              // query resuming the same session (shared prefix → provider cache
              // hit, near-free). persistSession:false keeps it off disk. Each
              // text delta is forwarded as a `followup_delta` event; the WebUI
              // accumulates + parses incrementally with partial-json. Best-effort
              // — any failure is swallowed, never blocks the turn's close.
              // Only on a clean finish (exitCode 0): a Stop (abort → -1) or a
              // mid-turn error must stay byte-identical to pre-feature behavior,
              // never spinning up a follow-up query on an aborted transcript.
              if (!clientGone && ev.exitCode === 0 && getFollowupSuggestionsEnabled()) {
                try {
                  for await (const delta of runFollowup({ resume: sid, cwd, model: providerModel, envOverrides: providerEnv })) {
                    if (clientGone) break;
                    safeSend({ type: 'followup_delta', text: delta });
                  }
                } catch {
                  /* swallow: follow-up is enrichment, never fatal */
                }
              }
              return;
            }
          }
          // Production runClaude emits `done` on every settled path, but keep
          // the route owner-safe if a future/custom iterator simply returns.
          finishMainRun(-1, 'runner ended without a terminal event');
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          finishMainRun(-1, msg);
        } finally {
          // Owner-guarded and idempotent: any settled iterator releases its
          // claim even if terminal event handling changes later.
          endRun(sid, abortController);
          if (!clientGone) sseDone(reply);
        }
      })();
    },
  );

}
