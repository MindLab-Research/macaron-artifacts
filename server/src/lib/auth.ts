import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';

// Loopback peers (the local CLI, start.sh's health curl, a browser on the same
// box) are never challenged — auth only guards access from the network.
export function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.') || ip === '::ffff:127.0.0.1' || ip.startsWith('::ffff:127.');
}

export function isLoopbackHost(host: string): boolean {
  // Match the whole IPv4 loopback block 127.0.0.0/8, mirroring isLoopback — a
  // 127.x bind (e.g. 127.0.0.2) is still fully local and must not trip the
  // "exposed to the network" auto-generate path.
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.');
}

// A tunnel CLI (cloudflared/ngrok) runs ON this box and forwards public traffic
// to http://localhost:PORT, so its requests hit the server from 127.0.0.1 and
// req.ip alone can't tell a real local peer from a visitor relayed in. Both CLIs
// unconditionally stamp a forwarding header on every proxied request, so the
// presence of one means "came in through a tunnel" — i.e. NOT actually local.
const FORWARD_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'cf-connecting-ip'];
export function isForwarded(req: FastifyRequest): boolean {
  return FORWARD_HEADERS.some((h) => req.headers[h] !== undefined);
}

// True when the request carries a *cross-origin* browser Origin — one present
// and pointing at a different host than the one addressed. Such a request is a
// fetch from another site: even though its socket may be loopback, it must not
// inherit the frictionless-localhost bypass, so a hosted/other-origin page is
// always token-checked. A same-origin Origin (browsers send one on same-origin
// POST/PUT/DELETE) and a no-Origin native/CLI call are NOT cross-origin.
export function isCrossOriginRequest(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host !== req.headers.host; } catch { return true; }
}

// The addressed host is a loopback literal (localhost / 127.x / ::1). A browser
// only sends a loopback Host header when the page it fetched was itself served
// from a loopback origin — i.e. the real server. A page at
// `http://attacker.localhost:<port>` (which also resolves to 127.0.0.1) sends
// `Host: attacker.localhost`, and a classic DNS-rebinding page sends its own
// non-loopback name — neither is a loopback literal. So this is a trusted,
// non-forgeable signal that the request genuinely addressed the local server as
// localhost, not the attacker-chosen Host we must never grant a bypass on.
function isLoopbackHostHeader(req: FastifyRequest): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return isLoopbackHost(hostname);
}

// The auth-exemption test: a loopback socket that wasn't relayed in through a
// tunnel, genuinely addressed the server as a loopback host, and isn't a
// cross-origin browser request. Requiring a loopback Host (not the request's
// attacker-controllable Host matching its Origin) is what stops a Host-spoofing
// / DNS-rebinding page on 127.0.0.1 from inheriting the frictionless-localhost
// bypass. On ambiguity it fails safe (challenge for the token), never open.
export function isLocalRequest(req: FastifyRequest): boolean {
  return isLoopback(req.ip) && !isForwarded(req) && isLoopbackHostHeader(req) && !isCrossOriginRequest(req);
}

// The armed shared secret ('' = auth off). Held in a module slot rather than
// just the hook/route closures because a tunnel started AFTER boot must be able
// to arm a token that the already-registered hook and auth routes see live.
let armedToken = '';
export function getArmedToken(): string { return armedToken; }
export function setArmedToken(token: string): void { armedToken = token; }
// Arm a token if none is set yet, returning the live one. Called when the server
// is about to be exposed (tunnel start) so an auth-off server is never put on the
// public internet with nothing to check requests against.
export function ensureArmedToken(): string {
  if (!armedToken) armedToken = randomBytes(24).toString('base64url');
  return armedToken;
}

// Constant-time string compare that also resists length leaks.
export function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// The configured token wins. Otherwise auto-generate one so the API is never
// left wide open when it's actually reachable by something other than a genuine
// local peer: a non-loopback bind (exposed to the network) OR cross-origin mode
// enabled (a hosted WebUI on another origin will drive this loopback server, and
// isLocalRequest already denies those the frictionless-localhost bypass — so
// without a token they'd hit a fully unauthenticated API). Loopback-only with no
// cross-origin stays auth-off (the frictionless local default).
export function resolveToken(host: string, configured: string, crossOriginEnabled = false): { token: string; generated: boolean } {
  if (configured) return { token: configured, generated: false };
  if (!isLoopbackHost(host) || crossOriginEnabled) return { token: randomBytes(24).toString('base64url'), generated: true };
  return { token: '', generated: false };
}

// Only the API and provider relay are sensitive; static assets + SPA HTML stay
// open so a remote browser can load the app shell and its login screen.
function isProtectedPath(url: string): boolean {
  return url.startsWith('/api/') || url.startsWith('/relay/');
}

// Endpoints that must answer without a token: health (probes), the auth
// handshake, and anything under /api/public/ (capability-token reads like share
// links, where the URL token IS the credential — a login token would defeat the
// point). Privileged share create/revoke stay on /api/share and are NOT exempt.
function isExemptPath(url: string): boolean {
  return url === '/api/health' || url.startsWith('/api/auth/') || url.startsWith('/api/public/');
}

// The path to match the guard against: the resolved route pattern, which
// Fastify has already percent-decoded (e.g. /api/workspaces/:project). Matching
// the raw req.url instead lets an encoded request like /%61pi/... (== /api/...)
// slip past the prefix check while the router still dispatches it to the real
// handler. No matched route (static assets, SPA fallback) → req.url, which
// stays open by intent.
function routePath(req: FastifyRequest): string {
  return req.routeOptions?.url ?? req.url;
}

export function extractToken(req: FastifyRequest): string {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  const q = (req.query as Record<string, unknown> | undefined)?.token;
  return typeof q === 'string' ? q : '';
}

// The `token` query param doubles as a share-link credential, so it must never
// reach the logs. Fastify/pino's default req serializer logs `req.url` verbatim
// (query and all) on every request — strip any token value before it lands in
// structured output. Fastify percent-decodes the query before authenticating,
// so `?%74oken=<secret>` is a live credential too; decode the key names (not the
// whole URL, which would mangle an already-encoded value) before matching.
export function redactTokenInUrl(url: string): string {
  return url.replace(/([?&])([^=&#]+)=([^&#]*)/g, (m, sep, key, val) => {
    let decoded = key;
    try { decoded = decodeURIComponent(key); } catch { /* keep raw key */ }
    return decoded.toLowerCase() === 'token' ? `${sep}${key}=[redacted]` : m;
  });
}

// Fastify onRequest hook. No-op when auth is off; otherwise 401s any protected
// request that isn't a genuine local peer and doesn't carry a valid token. Reads
// the armed token live (not a boot-time snapshot) so a tunnel that arms one after
// startup is enforced immediately.
export function makeAuthHook() {
  return function authHook(req: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void {
    const token = getArmedToken();
    const path = routePath(req);
    if (!token || isLocalRequest(req) || !isProtectedPath(path) || isExemptPath(path)) return done();
    if (tokensMatch(extractToken(req), token)) return done();
    reply.code(401).send({ error: 'authentication required', authRequired: true });
  };
}
