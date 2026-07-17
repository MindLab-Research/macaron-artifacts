// The Connect page's state transitions, factored out of the React component so
// they can be unit-tested directly (reject, success-navigation, BFCache restore,
// and the no-navigation guarantee on any rejection). The component is a thin
// shell that renders this state and performs the one side effect — navigation.
import { buildTarget } from './connect-target';
import { hostedTarget, type Engine, type Handoff } from './hosted-target';
import { stripToken } from './strip-token';

export type ConnectState = { url: string; token: string; error: string };

// The result of pressing "Open WebUI": the next input state, plus a `navigate`
// route and its `handoff` that are set ONLY on success. On any rejection both
// are undefined (no navigation) and the token is scrubbed from both fields.
// The token rides in `handoff` (stashed same-tab), never on the `navigate` URL,
// so it can't leak into the document GET / access logs / referrers.
export type SubmitResult = { state: ConnectState; navigate?: string; handoff?: Handoff };

// `engine` picks which hosted SPA route to open (Claude Code vs Codex). The
// validated server target becomes a same-origin `/app[/codex]` route plus a
// one-time handoff: we host the WebUI here and point it at the server, rather
// than redirect the browser to the server's own origin.
export function submit(url: string, token: string, selfOrigin: string, engine: Engine): SubmitResult {
  const r = buildTarget(url, token, selfOrigin);
  if ('error' in r) {
    // Rejected: never navigate, and never leave the secret in a visible input.
    return { state: { url: stripToken(url), token: '', error: r.error } };
  }
  const { route, handoff } = hostedTarget(r.href, engine);
  return { state: { url: stripToken(url), token: '', error: '' }, navigate: route, handoff };
}

// What the inputs become when the page is restored from the BFCache after a Back.
export function onRestore(state: ConnectState): ConnectState {
  return { url: stripToken(state.url), token: '', error: state.error };
}
