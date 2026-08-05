import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkGenUI } from './genui-check.js';

// The commit-gate widget shape from the ask-via-ui skill. `useAutoSend` only
// exists as an ambient declaration (the runtime side is a .mjs shim with no .tsx
// to map through compilerOptions.paths), so without it the exact code we tell the
// model to write comes back as a TS2307 and the model "fixes" a non-problem. Both
// facts are checked here: the import resolves, and the signature is real enough
// to reject a wrong call.
const commitGate = (call: string) => `import { Button } from '$macaron/ui';
import { sendUserMessage, useAutoSend } from '$macaron/chat';

const COMMIT = 'Commit it.';

export default function App() {
  const left = ${call};
  return <Button onClick={() => sendUserMessage(COMMIT)}>Commit{left !== null ? \` (\${left}s)\` : ''}</Button>;
}
`;

test('accepts the countdown commit gate we document', async () => {
  assert.deepEqual(await checkGenUI(commitGate('useAutoSend(COMMIT, 30)')), { ok: true });
});

test('seconds is optional', async () => {
  assert.deepEqual(await checkGenUI(commitGate('useAutoSend(COMMIT)')), { ok: true });
});

test('the ambient useAutoSend signature is typed, not any', async () => {
  const result = await checkGenUI(commitGate('useAutoSend(30, COMMIT)'));

  assert.equal(result.ok, false);
  assert.match(result.diagnostics ?? '', /not assignable to parameter of type 'string'/);
});
