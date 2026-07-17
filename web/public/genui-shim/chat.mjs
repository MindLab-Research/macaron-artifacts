// $macaron/chat shim — lets a sandboxed render_ui widget post a message back into
// the chat, as if the user typed it (driving the next assistant turn). Mirrors
// macaron-genui-demo's $macaron/chat / sendUserMessage. The host registers a
// dispatcher on globalThis['$app/chat'] (see Session.tsx); the preview
// renders inline (not an iframe) so it shares globalThis with the host. No active
// bridge = no-op + warn, matching display-only widget semantics.
const dispatch = (text) => {
  const bridge = globalThis['$app/chat'];
  if (!bridge) { console.warn('[genui-shim/chat] no active chat bridge; message dropped'); return; }
  bridge(text);
};

export function sendUserMessage(prompt) {
  if (typeof prompt !== 'string') throw new TypeError('sendUserMessage expects a string prompt');
  dispatch(prompt);
}

// Side-effect: also expose sendUserMessage on globalThis so widgets that
// forget the `import` still work — the preview shares globalThis with the
// host, so any onClick handler can just call sendUserMessage(...) directly.
// Models empirically forget the import ~30% of the time; the ReferenceError
// this saved isn't recoverable at runtime otherwise.
if (typeof globalThis !== 'undefined' && !globalThis.sendUserMessage) {
  globalThis.sendUserMessage = sendUserMessage;
}
