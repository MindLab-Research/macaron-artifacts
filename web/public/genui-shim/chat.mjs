// $macaron/chat shim — lets a sandboxed render_ui widget post a message back into
// the chat, as if the user typed it (driving the next assistant turn). Mirrors
// macaron-genui-demo's $macaron/chat / sendUserMessage. The host registers a
// dispatcher on globalThis['$app/chat'] (see Session.tsx); the preview
// renders inline (not an iframe) so it shares globalThis with the host. No active
// bridge = no-op + warn, matching display-only widget semantics.
// Sibling shim, not bare 'react': the import map only rewrites specifiers in the
// widget's own compiled module, so a bare import in here would depend on the
// page-level map existing. Same file URL either way = the host's single React.
import { useEffect, useState } from './react.mjs';

const dispatch = (text) => {
  const bridge = globalThis['$app/chat'];
  if (!bridge) { console.warn('[genui-shim/chat] no active chat bridge; message dropped'); return; }
  bridge(text);
};

export function sendUserMessage(prompt) {
  if (typeof prompt !== 'string') throw new TypeError('sendUserMessage expects a string prompt');
  dispatch(prompt);
}

// Countdown auto-send for a confirm widget with a default option ("commit
// unless you say otherwise"). Returns the seconds left, or null when nothing is
// counting — so the whole widget-side contract is `const left = useAutoSend(...)`
// and rendering `left`. Everything that makes an auto-fire wrong is handled by
// the host (lib/autoSend.ts): it refuses to arm on a re-opened transcript (left
// stays null, so the label silently drops the timer), holds while a turn streams,
// stops on any keystroke, and cancels itself inside send() — which means a button
// calling sendUserMessage needs no cancel bookkeeping at all.
export function useAutoSend(prompt, seconds = 30) {
  if (typeof prompt !== 'string') throw new TypeError('useAutoSend expects a string prompt');
  const [remaining, setRemaining] = useState(null);
  // Deps are the two primitives, NOT setRemaining's closure: re-arming on every
  // render would restart the countdown forever and it could never reach zero.
  useEffect(() => globalThis['$app/chat/schedule']?.(prompt, seconds, setRemaining), [prompt, seconds]);
  return remaining;
}

// Side-effect: also expose sendUserMessage on globalThis so widgets that
// forget the `import` still work — the preview shares globalThis with the
// host, so any onClick handler can just call sendUserMessage(...) directly.
// Models empirically forget the import ~30% of the time; the ReferenceError
// this saved isn't recoverable at runtime otherwise.
if (typeof globalThis !== 'undefined' && !globalThis.sendUserMessage) {
  globalThis.sendUserMessage = sendUserMessage;
}
