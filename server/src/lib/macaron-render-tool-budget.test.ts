import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MCP_TEXT_LIMIT,
  RENDER_UI_INSTRUCTIONS,
  RENDER_UI_TOOL_DESCRIPTION,
} from './macaron-render-tool.js';

// The Claude CLI hard-truncates MCP server instructions and tool descriptions at
// MCP_TEXT_LIMIT chars, replacing the tail with "… [truncated]". This is silent:
// nothing errors, the model simply never sees the end. A previous revision put
// the (COMMIT) trigger at char 2510 and the whole $macaron/ui + useAutoSend
// authoring section at char 9417, so both were dead text — the model asked
// "want me to commit?" in prose and wrote raw inline-style divs. These
// assertions fail the build instead of silently losing guidance.
for (const [name, text] of [
  ['server instructions', RENDER_UI_INSTRUCTIONS],
  ['tool description', RENDER_UI_TOOL_DESCRIPTION],
] as const) {
  test(`${name} survives MCP truncation intact`, () => {
    assert.ok(
      text.length <= MCP_TEXT_LIMIT,
      `${name} is ${text.length} chars; everything past ${MCP_TEXT_LIMIT} is invisible to the model. Cut ${text.length - MCP_TEXT_LIMIT} chars.`,
    );
  });
}

// Ordering guard: being under the cap is not enough, the load-bearing parts have
// to survive even if someone later prepends a paragraph. These are the triggers
// and rules whose loss we actually observed changing model behavior.
test('the most-fired triggers sit early in the instructions', () => {
  const commit = RENDER_UI_INSTRUCTIONS.indexOf('(COMMIT)');
  const ask = RENDER_UI_INSTRUCTIONS.indexOf('(ASK)');

  assert.ok(commit > 0 && commit < 600, `(COMMIT) at ${commit} — the question the model asks most must come first`);
  assert.ok(ask > 0 && ask < 900, `(ASK) at ${ask}`);
});

test('the authoring rules that shape the TSX survive in the description', () => {
  for (const needle of ['$macaron/ui', '$macaron/chat', 'useAutoSend', 'export default function App()']) {
    const at = RENDER_UI_TOOL_DESCRIPTION.indexOf(needle);
    assert.ok(at > 0 && at < MCP_TEXT_LIMIT, `${needle} at ${at} — past the cut the model writes raw divs`);
  }
});

// The two slots must not duplicate each other: with only ~2k chars each, a
// trigger list repeated in the description is what crowded out the imports and
// useAutoSend docs in the first place.
test('the description does not re-list the trigger table', () => {
  assert.equal(RENDER_UI_TOOL_DESCRIPTION.includes('(COMPARE)'), false);
  assert.equal(RENDER_UI_TOOL_DESCRIPTION.includes('MUST call render_ui'), false);
});
