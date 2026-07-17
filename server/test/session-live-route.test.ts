import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import type { RunOptions, RunnerEvent } from '../src/lib/claude-runner.js';

const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcc-live-route-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const [{ CLAUDE_PROJECTS }, { registerSessionRoutes }] = await Promise.all([
  import('../src/config.js'),
  import('../src/routes/sessions.js'),
]);

after(() => fs.rm(tmpHome, { recursive: true, force: true }));

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
  initial = '',
): Promise<string> {
  const decoder = new TextDecoder();
  let text = initial;
  while (!text.includes(marker)) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

test('resumed bypass turn survives original SSE disconnect and replays through /live', { timeout: 10_000 }, async (t) => {
  const project = 'existing-project';
  const sid = 'existing-session';
  const cwd = path.join(tmpHome, 'repo');
  await fs.mkdir(path.join(CLAUDE_PROJECTS, project), { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(
    path.join(CLAUDE_PROJECTS, project, `${sid}.jsonl`),
    `${JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'earlier turn' } })}\n`,
    'utf8',
  );

  let continueRun!: () => void;
  let finishRun!: () => void;
  const continueGate = new Promise<void>((resolve) => { continueRun = resolve; });
  const finishGate = new Promise<void>((resolve) => { finishRun = resolve; });
  const attachedImages = [{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,YQ==' }];
  let observedOptions: RunOptions | undefined;

  async function* fakeRunClaude(opts: RunOptions): AsyncGenerator<RunnerEvent> {
    observedOptions = opts;
    yield { kind: 'delta', text: 'before refresh' };
    await continueGate;
    yield { kind: 'delta', text: ' after refresh' };
    await finishGate;
    yield { kind: 'done', exitCode: 0 };
  }

  const app = Fastify({ logger: false });
  await registerSessionRoutes(app, { runClaude: fakeRunClaude });
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await app.close();
  });

  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const sessionPath = `/api/sessions/claude/${project}/${sid}`;

  const original = await fetch(`${base}${sessionPath}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'keep working', permissionMode: 'bypassPermissions', images: attachedImages }),
  });
  assert.equal(original.status, 200);
  assert.ok(original.body);
  const originalReader = original.body.getReader();
  const originalText = await readUntil(originalReader, 'before refresh');
  assert.match(originalText, /"type":"meta"/);
  assert.match(originalText, /"startedAt":\d+/);
  assert.match(originalText, /before refresh/);
  await originalReader.cancel();

  assert.equal(observedOptions?.resume, sid);
  assert.equal(observedOptions?.permissionMode, 'bypassPermissions');
  assert.deepEqual(observedOptions?.images, attachedImages);
  assert.equal(observedOptions?.abortController?.signal.aborted, false);

  const duplicate = await fetch(`${base}${sessionPath}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'competing turn', permissionMode: 'default' }),
  });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: 'session already running' });

  const reattached = await fetch(`${base}${sessionPath}/live`, {
    headers: { Accept: 'text/event-stream' },
  });
  assert.equal(reattached.status, 200);
  assert.ok(reattached.body);
  const liveReader = reattached.body.getReader();
  let liveText = await readUntil(liveReader, 'before refresh');
  assert.match(liveText, /"type":"meta"/);
  assert.match(liveText, /"startedAt":\d+/);
  assert.ok(liveText.includes(JSON.stringify({ type: 'user-text', text: 'keep working', images: attachedImages })));

  continueRun();
  liveText = await readUntil(liveReader, 'after refresh', liveText);
  assert.match(liveText, /after refresh/);

  finishRun();
  liveText = await readUntil(liveReader, '"type":"done"', liveText);
  assert.match(liveText, /"type":"done","exitCode":0/);
  await liveReader.cancel().catch(() => {});
});

test('synchronous setup failure ends live replay and releases the run claim', { timeout: 10_000 }, async (t) => {
  const project = 'setup-failure-project';
  const sid = 'setup-failure-session';
  const cwd = path.join(tmpHome, 'setup-failure-repo');
  await fs.mkdir(path.join(CLAUDE_PROJECTS, project), { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(
    path.join(CLAUDE_PROJECTS, project, `${sid}.jsonl`),
    `${JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'earlier turn' } })}\n`,
    'utf8',
  );

  let providerCalls = 0;
  let runnerCalls = 0;
  async function* fakeRunClaude(): AsyncGenerator<RunnerEvent> {
    runnerCalls += 1;
    yield { kind: 'done', exitCode: 0 };
  }

  const app = Fastify({ logger: false });
  await registerSessionRoutes(app, {
    runClaude: fakeRunClaude,
    getActiveProviderEnv: () => {
      providerCalls += 1;
      if (providerCalls === 1) throw new Error('provider setup failed');
      return { model: 'test-model', env: null };
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await app.close();
  });

  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const sessionPath = `http://127.0.0.1:${address.port}/api/sessions/claude/${project}/${sid}`;

  const failed = await fetch(`${sessionPath}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'first attempt' }),
  });
  assert.equal(failed.status, 200);
  const failedText = await failed.text();
  assert.match(failedText, /"type":"error","error":"provider setup failed"/);
  assert.match(failedText, /"type":"done","exitCode":-1,"error":"provider setup failed"/);
  assert.equal(runnerCalls, 0);

  const replay = await fetch(`${sessionPath}/live`, { headers: { Accept: 'text/event-stream' } });
  assert.equal(replay.status, 200);
  const replayText = await replay.text();
  assert.match(replayText, /"type":"error","error":"provider setup failed"/);
  assert.match(replayText, /"type":"done","exitCode":-1,"error":"provider setup failed"/);

  const retry = await fetch(`${sessionPath}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'second attempt' }),
  });
  assert.equal(retry.status, 200);
  assert.match(await retry.text(), /"type":"done","exitCode":0/);
  assert.equal(runnerCalls, 1);
});

test('abort retains ownership until a runner without done settles', { timeout: 10_000 }, async (t) => {
  const project = 'abort-owner-project';
  const sid = 'abort-owner-session';
  const cwd = path.join(tmpHome, 'abort-owner-repo');
  await fs.mkdir(path.join(CLAUDE_PROJECTS, project), { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(
    path.join(CLAUDE_PROJECTS, project, `${sid}.jsonl`),
    `${JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'earlier turn' } })}\n`,
    'utf8',
  );

  let finishAbort!: () => void;
  const abortGate = new Promise<void>((resolve) => { finishAbort = resolve; });
  let firstRunStarted!: () => void;
  const firstRunGate = new Promise<void>((resolve) => { firstRunStarted = resolve; });
  let runnerCalls = 0;
  let firstOptions: RunOptions | undefined;
  async function* fakeRunClaude(opts: RunOptions): AsyncGenerator<RunnerEvent> {
    runnerCalls += 1;
    if (runnerCalls > 1) {
      yield { kind: 'done', exitCode: 0 };
      return;
    }
    firstOptions = opts;
    yield { kind: 'delta', text: 'still running' };
    firstRunStarted();
    await new Promise<void>((resolve) => opts.abortController?.signal.addEventListener('abort', () => resolve(), { once: true }));
    await abortGate;
    // Deliberately settle without the RunnerEvent contract's terminal `done`.
  }

  const app = Fastify({ logger: false });
  await registerSessionRoutes(app, { runClaude: fakeRunClaude });
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    finishAbort();
    app.server.closeAllConnections();
    await app.close();
  });

  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const sessionPath = `http://127.0.0.1:${address.port}/api/sessions/claude/${project}/${sid}`;
  const original = await fetch(`${sessionPath}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'long turn' }),
  });
  assert.equal(original.status, 200);
  const originalText = original.text();
  await firstRunGate;

  const stopped = await fetch(`${sessionPath}/stop`, { method: 'POST' });
  assert.deepEqual(await stopped.json(), { ok: true, running: true });
  assert.equal(firstOptions?.abortController?.signal.aborted, true);

  const competing = await fetch(`${sessionPath}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'too early' }),
  });
  assert.equal(competing.status, 409);

  finishAbort();
  const terminalText = await originalText;
  assert.match(terminalText, /runner ended without a terminal event/);
  assert.match(terminalText, /"type":"done","exitCode":-1/);

  const retry = await fetch(`${sessionPath}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'after cleanup' }),
  });
  assert.equal(retry.status, 200);
  assert.match(await retry.text(), /"type":"done","exitCode":0/);
  assert.equal(runnerCalls, 2);
});
