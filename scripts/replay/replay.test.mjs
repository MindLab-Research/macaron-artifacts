import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { expandReplayFixture, loadReplayFixture, RENDER_UI_TOOL } from './fixture.mjs';
import { createReplayServer } from './server.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixturePath = path.join(repoRoot, 'replays/checkout-latency.json');

test('expands render_ui descriptors into monotonic production SSE events', () => {
  const { fixture, schedule } = loadReplayFixture(fixturePath);
  assert.equal(fixture.duration, 24);
  assert.ok(schedule.length > fixture.events.length);
  for (let index = 1; index < schedule.length; index += 1) {
    assert.ok(schedule[index].at >= schedule[index - 1].at);
  }
  const chunks = schedule.filter((item) => item.event.type === 'tool_input_delta');
  assert.ok(chunks.length > 20);
  assert.ok(chunks.every((item) => item.event.name === RENDER_UI_TOOL));
  assert.ok(chunks.every((item) => {
    const code = JSON.parse(item.event.accumulated).code;
    return code.endsWith('\n') || code.endsWith('}');
  }));
  for (const id of ['ui-baseline', 'ui-verified']) {
    const lengths = chunks
      .filter((item) => item.event.id === id)
      .map((item) => JSON.parse(item.event.accumulated).code.length);
    assert.ok(lengths.length >= 2);
    for (let index = 1; index < lengths.length; index += 1) assert.ok(lengths[index] > lengths[index - 1]);
  }
});

test('rejects fixtures whose render stream exceeds the video duration', () => {
  assert.throws(() => expandReplayFixture({
    version: 1,
    id: 'bad',
    duration: 8,
    workspace: { project: 'p', cwd: '/p', name: 'p', sessionId: 's', title: 't' },
    events: [{ at: 7, renderUi: { id: 'ui', duration: 2, chunks: 2, code: 'export default function App(){return <div>hello</div>}' } }],
  }), /exceeds replay duration/);
});

test('serves the production app API shape and replays buffered SSE events', async () => {
  const expanded = loadReplayFixture(fixturePath);
  const replay = createReplayServer({ expanded, webRoot: null });
  const origin = await replay.listen();
  const controller = new AbortController();
  try {
    const auth = await fetch(`${origin}/api/auth/status`).then((response) => response.json());
    assert.deepEqual(auth, { required: false });
    const usage = await fetch(`${origin}/api/usage`).then((response) => response.json());
    assert.deepEqual(usage, { available: false, fiveHour: null, sevenDay: null });
    const settings = await fetch(`${origin}/api/settings`).then((response) => response.json());
    assert.equal(settings.activeProviderId, 'system');
    assert.equal(settings.builtins[0].id, 'system');
    const workspaces = await fetch(`${origin}/api/workspaces`).then((response) => response.json());
    assert.equal(workspaces.workspaces[0].project, expanded.fixture.workspace.project);

    const project = encodeURIComponent(expanded.fixture.workspace.project);
    const sid = encodeURIComponent(expanded.fixture.workspace.sessionId);
    const response = await fetch(`${origin}/api/sessions/claude/${project}/${sid}/live`, { signal: controller.signal });
    assert.equal(response.status, 200);
    replay.advance(0.5);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = '';
    while (!body.includes('"type":"user-text"')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      body += decoder.decode(chunk.value, { stream: true });
    }
    assert.match(body, /"type":"meta"/);
    assert.match(body, /"type":"user-text"/);
    await reader.cancel();
  } finally {
    controller.abort();
    await replay.close();
  }
});
