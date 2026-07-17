import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';
import { isCrossOriginRequest } from './auth.js';

// Cross-origin support for the hosted-WebUI mode. Normally the UI is served by
// this same server, so requests are same-origin and this is a no-op. When a
// hosted UI on another origin (the docs site) drives the server, we echo the
// caller's origin (if allowlisted) and answer the CORS preflight — including
// Chrome's Local Network Access (LNA) / legacy Private Network Access (PNA)
// header so a public https page is permitted to reach this loopback server.
//
// A cross-origin request whose Origin is NOT allowlisted is rejected 403 here,
// before auth/routing runs — omitting the ACAO header only stops the browser
// from reading the response, it does NOT stop a simple/no-cors write (e.g. a
// text/plain POST) from executing server-side. So the allowlist is enforced as
// a real gate, not just a response-visibility hint. Same-origin requests (Origin
// host == this host) and no-Origin native/CLI calls are never touched.
//
// Auth is unchanged: the bearer token / `?token=` still gates every /api call
// (see auth.ts). CORS decides whether a browser may talk to us cross-origin;
// the token remains the credential.

function originAllowed(origin: string, allowed: string[]): boolean {
  return allowed.includes('*') || allowed.includes(origin);
}

// Returns the value to echo in Access-Control-Allow-Origin, or null to skip.
// With credentials we must echo the exact origin (never literal `*`).
function resolveAllowOrigin(origin: string | undefined, allowed: string[]): string | null {
  if (!origin || allowed.length === 0) return null;
  return originAllowed(origin, allowed) ? origin : null;
}

export function makeCorsHook(allowed: string[]) {
  return function corsHook(req: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void {
    const origin = req.headers.origin;
    const allow = resolveAllowOrigin(origin, allowed);
    // A cross-origin browser request with a non-allowlisted Origin is refused
    // outright — both preflight and the real (possibly simple/no-cors) request —
    // so an unauthorized site can't drive this server at all.
    if (!allow && isCrossOriginRequest(req)) {
      reply.code(403).send({ error: 'origin not allowed' });
      return; // don't call done() — request is fully handled
    }
    if (allow) {
      // Set on reply.raw, not reply.header: the SSE/relay handlers hijack the
      // reply and writeHead() straight on the Node res, which bypasses fastify's
      // header pipeline. setHeader here survives that hijack (writeHead merges
      // with already-set headers); normal responses just re-set the same value.
      reply.raw.setHeader('Access-Control-Allow-Origin', allow);
      reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
      reply.raw.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      // Preflight: answer here and stop, before the auth hook 401s an OPTIONS
      // that carries no token. Only respond as a real preflight when allowed.
      if (allow) {
        reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        const reqHeaders = req.headers['access-control-request-headers'];
        reply.header('Access-Control-Allow-Headers', reqHeaders || 'authorization,content-type');
        reply.header('Access-Control-Max-Age', '600');
        // Chrome LNA/PNA: grant the public→local network preflight.
        if (req.headers['access-control-request-private-network'] === 'true') {
          reply.header('Access-Control-Allow-Private-Network', 'true');
        }
      }
      reply.code(204).send();
      return; // don't call done() — request is fully handled
    }
    done();
  };
}
