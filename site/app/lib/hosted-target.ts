// Turn a validated server target (from buildTarget: `<origin>/?token=<t>`) into
// the same-origin hosted route that opens the WebUI we host under /app, plus a
// one-time handoff carrying the server origin and token.
//
// Claude Code → /app (index.html), Codex → /app/codex (codex.html), Kimi →
// /app/kimi (kimi.html). The server
// and token are deliberately NOT put on the URL: the connect page stashes the
// handoff in sessionStorage and navigates to the clean route, so the credential
// never lands in the document GET, the docs/CDN access logs, or referrers. The
// hosted SPA reads the handoff on first load (see web apiBase.consumeHandoff),
// binds the token to that server origin, and clears it. A crafted `/app?server=…`
// URL is inert — only the same-tab handoff is trusted — so buildTarget's
// scheme / self-origin / public-HTTP validation cannot be bypassed.
export type Engine = 'claude' | 'codex' | 'kimi';

const ROUTE: Record<Engine, string> = { claude: '/app', codex: '/app/codex', kimi: '/app/kimi' };

// sessionStorage key the docs connect page WRITES and the hosted SPA READS.
// Must stay identical to HANDOFF_KEY in web/src/lib/apiBase.ts.
export const HANDOFF_KEY = 'macaron_connect_handoff';

export type Handoff = { server: string; token: string };
export type HostedTarget = { route: string; handoff: Handoff };

// `serverHref` is buildTarget's output, already normalized to `<origin>/` with
// an optional `?token=`. Split it into origin + token for the handoff.
export function hostedTarget(serverHref: string, engine: Engine): HostedTarget {
  const u = new URL(serverHref);
  return { route: ROUTE[engine], handoff: { server: u.origin, token: u.searchParams.get('token') || '' } };
}
