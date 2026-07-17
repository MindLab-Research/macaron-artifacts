// Anthropic-compatible reverse-proxy so Claude Code CLI can talk to a
// third-party provider (Macaron etc.) that only implements /v1/messages.
//
// The CLI probes several /v1/ endpoints during startup (models, org, etc.)
// to validate the auth session and the selected model. If those return
// 404 the CLI aborts with a misleading "issue with the selected model"
// error — even if /v1/messages would have worked fine.
//
// We sit in front of the provider:
//   GET /v1/models             → synthesize list from active provider config
//   GET /v1/models/<name>      → synthesize a Model object for <name>
//   POST /v1/messages          → forward to provider.endpoint verbatim,
//                                streaming the response back byte-by-byte
//   * everything else          → return an empty {ok:true} 200 so probes
//                                don't fail (best-effort — most CLI probes
//                                just need any 2xx to satisfy startup)
//
// URL: /relay/anthropic/:providerId/v1/...
// The plugin server sets ANTHROPIC_BASE_URL to this path when the active
// provider is a custom one.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readSettings } from '../lib/settings-store.js';

async function findProvider(id: string) {
  const s = await readSettings();
  return s.customProviders.find((p) => p.id === id) || null;
}

function synthModelObject(id: string, ownerName: string) {
  return {
    id,
    type: 'model',
    display_name: id,
    created_at: '2024-01-01T00:00:00Z',
    owned_by: ownerName,
  };
}

export async function registerRelayRoutes(app: FastifyInstance): Promise<void> {
  // -------- GET /v1/models --------------------------------------------------
  app.get<{ Params: { providerId: string } }>(
    '/relay/anthropic/:providerId/v1/models',
    async (req, reply) => {
      const p = await findProvider(req.params.providerId);
      if (!p) return reply.status(404).send({ error: 'provider not found' });
      return reply.send({
        data: [synthModelObject(p.model, p.name)],
        has_more: false,
        first_id: p.model,
        last_id: p.model,
      });
    },
  );

  // -------- GET /v1/models/<name> ------------------------------------------
  app.get<{ Params: { providerId: string; model: string } }>(
    '/relay/anthropic/:providerId/v1/models/:model',
    async (req, reply) => {
      const p = await findProvider(req.params.providerId);
      if (!p) return reply.status(404).send({ error: 'provider not found' });
      // Whatever model the CLI asks about, we say "yes, that exists" and
      // return a synthesised object. Actual routing to Macaron is via
      // /v1/messages where we can rewrite the model field anyway.
      return reply.send(synthModelObject(req.params.model || p.model, p.name));
    },
  );

  // -------- POST /v1/messages ---------------------------------------------
  app.post<{ Params: { providerId: string } }>(
    '/relay/anthropic/:providerId/v1/messages',
    async (req, reply) => {
      const p = await findProvider(req.params.providerId);
      if (!p) return reply.status(404).send({ error: 'provider not found' });

      // Massage the body before forwarding:
      //   - model  →  provider's canonical name
      //   - Any `messages[i].role === 'system'` entries get lifted into
      //     the top-level `system` field. Real Anthropic accepts either
      //     shape, but some Anthropic-compatible backends reject `system` inside
      //     `messages` with a 400 literal_error.
      let body: Record<string, unknown> = {};
      if (req.body && typeof req.body === 'object') {
        const src = req.body as Record<string, unknown>;
        const messagesIn = Array.isArray(src.messages) ? [...src.messages] : [];
        const messages: unknown[] = [];
        const systemBlocks: unknown[] = [];
        for (const m of messagesIn) {
          const mm = m as { role?: string; content?: unknown };
          if (mm && mm.role === 'system') {
            // Content may be string OR array-of-blocks. Preserve both shapes
            // by appending each block; strings get wrapped as a text block.
            if (typeof mm.content === 'string') {
              systemBlocks.push({ type: 'text', text: mm.content });
            } else if (Array.isArray(mm.content)) {
              for (const c of mm.content) systemBlocks.push(c);
            }
          } else {
            messages.push(m);
          }
        }
        body = { ...src, model: p.model, messages };
        // Merge with any pre-existing top-level system (rare but possible).
        if (systemBlocks.length > 0) {
          const existing = src.system;
          if (typeof existing === 'string') {
            body.system = [
              { type: 'text', text: existing },
              ...systemBlocks,
            ];
          } else if (Array.isArray(existing)) {
            body.system = [...existing, ...systemBlocks];
          } else {
            body.system = systemBlocks;
          }
        }
      }

      const upstreamUrl = `${p.endpoint.replace(/\/$/, '')}/messages`;
      // Forward select client headers (streaming, anthropic-beta, etc.).
      const fwdHeaders: Record<string, string> = {
        'content-type': 'application/json',
        authorization: `Bearer ${p.apiKey}`,
        'anthropic-version':
          (req.headers['anthropic-version'] as string | undefined) || '2023-06-01',
      };
      const abeta = req.headers['anthropic-beta'] as string | undefined;
      if (abeta) fwdHeaders['anthropic-beta'] = abeta;

      let upstream: Response;
      try {
        upstream = await fetch(upstreamUrl, {
          method: 'POST',
          headers: fwdHeaders,
          body: JSON.stringify(body),
        });
      } catch (e) {
        return reply.status(502).send({
          type: 'error',
          error: { type: 'api_error', message: `upstream fetch failed: ${(e as Error).message}` },
        });
      }

      // Mirror status + relevant response headers. `reply.hijack()` lets us
      // pipe the streaming body raw (important for SSE).
      reply.hijack();
      const rawHeaders: Record<string, string> = {};
      upstream.headers.forEach((v, k) => {
        const lk = k.toLowerCase();
        if (lk === 'content-length' || lk === 'transfer-encoding' || lk === 'connection') return;
        rawHeaders[k] = v;
      });
      reply.raw.writeHead(upstream.status, rawHeaders);

      if (!upstream.body) {
        reply.raw.end();
        return;
      }
      const reader = upstream.body.getReader();
      let clientGone = false;
      reply.raw.on('close', () => {
        clientGone = true;
        try { reader.cancel(); } catch { /* ignore */ }
      });
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (clientGone) break;
        if (value) reply.raw.write(Buffer.from(value));
      }
      reply.raw.end();
    },
  );

  // -------- Catch-all for other endpoints CLI might probe ------------------
  // The CLI has many /v1/ endpoints it may hit during init (org info,
  // permissions, telemetry). Return a bland 200 so probes don't kill the
  // session. Provider-specific POSTs that need real behavior will still
  // fail visibly if they matter; startup checks won't.
  const stub = async (req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({});
  };
  app.get('/relay/anthropic/:providerId/v1/*', stub);
  app.post('/relay/anthropic/:providerId/v1/*', stub);
}
