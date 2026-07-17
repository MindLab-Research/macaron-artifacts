import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import type { SessionDetail } from '@macaron/shared';
import type { RunnerEvent } from '../src/lib/claude-runner.js';
import type { KimiRunOptions } from '../src/lib/kimi-runner.js';
import { endRun } from '../src/lib/active-runs.js';
import { registerKimiRoutes } from '../src/routes/kimi.js';

function sessionDetail(sid: string, cwd: string): SessionDetail {
  return {
    kind: 'kimi',
    sessionId: sid,
    project: 'test-project',
    cwd,
    messages: [],
  };
}

test('Kimi resume keeps a replacement claim safe from stale cleanup', { timeout: 10_000 }, async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mcc-kimi-owner-'));
  const sid = 'kimi-stale-owner-session';
  let allowFirstDone!: () => void;
  let releaseStaleFinalizer!: () => void;
  let finishReplacement!: () => void;
  let firstStarted!: () => void;
  let staleFinalizing!: () => void;
  let replacementStarted!: () => void;
  const firstDoneGate = new Promise<void>((resolve) => { allowFirstDone = resolve; });
  const staleFinalizerGate = new Promise<void>((resolve) => { releaseStaleFinalizer = resolve; });
  const replacementGate = new Promise<void>((resolve) => { finishReplacement = resolve; });
  const firstStartedGate = new Promise<void>((resolve) => { firstStarted = resolve; });
  const staleFinalizingGate = new Promise<void>((resolve) => { staleFinalizing = resolve; });
  const replacementStartedGate = new Promise<void>((resolve) => { replacementStarted = resolve; });
  let runnerCalls = 0;

  async function* fakeRunKimi(): AsyncGenerator<RunnerEvent> {
    runnerCalls += 1;
    if (runnerCalls === 1) {
      yield { kind: 'delta', text: 'first running' };
      firstStarted();
      await firstDoneGate;
      try {
        yield { kind: 'done', exitCode: 0 };
      } finally {
        staleFinalizing();
        await staleFinalizerGate;
        throw new Error('stale finalizer failed');
      }
      return;
    }
    if (runnerCalls === 2) {
      yield { kind: 'delta', text: 'replacement running' };
      replacementStarted();
      await replacementGate;
    }
    yield { kind: 'done', exitCode: 0 };
  }

  const app = Fastify({ logger: false });
  await registerKimiRoutes(app, {
    runKimi: fakeRunKimi,
    readKimiSessionMessages: async () => sessionDetail(sid, cwd),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    allowFirstDone();
    releaseStaleFinalizer();
    finishReplacement();
    endRun(sid);
    app.server.closeAllConnections();
    await app.close();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const sessionPath = `http://127.0.0.1:${address.port}/api/kimi/threads/${sid}`;
  const postMessage = (text: string) => fetch(`${sessionPath}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  const first = await postMessage('first');
  assert.equal(first.status, 200);
  const firstText = first.text();
  await firstStartedGate;

  const duplicate = await postMessage('duplicate');
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: 'a turn is already in flight for this thread' });

  allowFirstDone();
  await staleFinalizingGate;
  const replacement = await postMessage('replacement');
  assert.equal(replacement.status, 200);
  const replacementText = replacement.text();
  await replacementStartedGate;

  releaseStaleFinalizer();
  assert.match(await firstText, /"type":"done","exitCode":0/);

  const afterStaleCleanup = await postMessage('must stay blocked');
  assert.equal(afterStaleCleanup.status, 409);

  finishReplacement();
  assert.match(await replacementText, /"type":"done","exitCode":0/);
  assert.equal(runnerCalls, 2);
});

test('Kimi abort keeps ownership until a runner without done settles', { timeout: 10_000 }, async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mcc-kimi-abort-'));
  const sid = 'kimi-abort-owner-session';
  let finishAbort!: () => void;
  let firstStarted!: () => void;
  const abortGate = new Promise<void>((resolve) => { finishAbort = resolve; });
  const firstStartedGate = new Promise<void>((resolve) => { firstStarted = resolve; });
  let runnerCalls = 0;
  let firstOptions: KimiRunOptions | undefined;

  async function* fakeRunKimi(opts: KimiRunOptions): AsyncGenerator<RunnerEvent> {
    runnerCalls += 1;
    if (runnerCalls > 1) {
      yield { kind: 'done', exitCode: 0 };
      return;
    }
    firstOptions = opts;
    yield { kind: 'delta', text: 'still running' };
    firstStarted();
    await new Promise<void>((resolve) => opts.abortController?.signal.addEventListener('abort', () => resolve(), { once: true }));
    await abortGate;
    // Deliberately settle without the RunnerEvent contract's terminal `done`.
  }

  const app = Fastify({ logger: false });
  await registerKimiRoutes(app, {
    runKimi: fakeRunKimi,
    readKimiSessionMessages: async () => sessionDetail(sid, cwd),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    finishAbort();
    endRun(sid);
    app.server.closeAllConnections();
    await app.close();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const sessionPath = `http://127.0.0.1:${address.port}/api/kimi/threads/${sid}`;
  const postMessage = (text: string) => fetch(`${sessionPath}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  const original = await postMessage('long turn');
  assert.equal(original.status, 200);
  const originalText = original.text();
  await firstStartedGate;

  const stopped = await fetch(`${sessionPath}/stop`, { method: 'POST' });
  assert.deepEqual(await stopped.json(), { ok: true, running: true });
  assert.equal(firstOptions?.abortController?.signal.aborted, true);

  const competing = await postMessage('too early');
  assert.equal(competing.status, 409);

  finishAbort();
  const terminalText = await originalText;
  assert.match(terminalText, /runner ended without a terminal event/);
  assert.match(terminalText, /"type":"done","exitCode":-1/);

  const retry = await postMessage('after cleanup');
  assert.equal(retry.status, 200);
  assert.match(await retry.text(), /"type":"done","exitCode":0/);
  assert.equal(runnerCalls, 2);
});
