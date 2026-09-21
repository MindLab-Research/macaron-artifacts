import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifactsServer } from './index.js';
import { ArtifactObserver, readUi4aFile, ui4aPath, writeUi4aFile } from './artifacts.js';
import { MetadataTasks, parseRecap } from './enrichment.js';
import type { HarnessAdapter, HarnessTurn } from './harnesses/types.js';
import type { ChatChunk, Session } from '../shared/types.js';
import { SessionStore } from './store.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function workspace() { const path = await mkdtemp(join(tmpdir(), 'artifacts-test-')); cleanups.push(() => rm(path, { recursive: true, force: true })); return path; }
const info = { id: 'claude-code', name: 'Test harness', available: true, capabilities: { textDeltas: true, reasoningDeltas: true, toolInputDeltas: true, commandOutputDeltas: true, approvals: true, fork: true } } as const;
async function setup(run: (turn: HarnessTurn) => AsyncIterable<ChatChunk>) {
  const cwd = await workspace(), adapter: HarnessAdapter = { id: 'claude-code', info: async () => info, run };
  const app = await createArtifactsServer({ directory: join(cwd, 'sessions'), instructions: 'stable bootstrap', harnesses: { 'claude-code': adapter, codex: { ...adapter, id: 'codex' } } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const session = await (await post('/api/sessions', { cwd, harness: 'claude-code' })).json() as Session;
  return { app, base, post, session, cwd };
}
test('forwards every native delta and replays a long detached turn without losing its prefix', async () => {
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { reached = resolve; });
  const { app, base, post, session } = await setup(async function* () {
    yield { type: 'text-start', id: 'native-text' };
    for (let i = 0; i < 4105; i++) yield { type: 'text-delta', id: 'native-text', delta: i === 0 ? 'PREFIX:' : 'x' };
    reached(); await gate;
    yield { type: 'text-end', id: 'native-text' };
  });
  const first = await post('/api/chat', { id: session.id, messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'test' }] }] });
  await ready; await first.body?.cancel();
  const replay = await fetch(`${base}/api/chat/${session.id}/stream`);
  release();
  const text = await replay.text();
  expect((text.match(/"type":"text-delta"/g) ?? []).length).toBe(4105);
  expect(text).toContain('PREFIX:');
  expect(text).toContain('[DONE]');
  const saved = await (await fetch(`${base}/api/sessions/${session.id}`)).json() as Session;
  expect(saved.status).toBe('idle');
  expect(saved.messages[1].parts.find(part => part.type === 'text')?.text).toBe('PREFIX:' + 'x'.repeat(4104));
  expect(app.active.size).toBe(0);
});
test('enrichment keeps bootstrap and native session but does not overwrite its identity', async () => {
  const turns: HarnessTurn[] = [];
  const { post, base, session } = await setup(async function* (turn) {
    turns.push(turn);
    turn.onNativeSession(turn.enrichment ? 'fork' : 'native-main');
    yield { type: 'text-start', id: 'text' };
    yield { type: 'text-delta', id: 'text', delta: turn.enrichment ? '{"suggestions":["Next?"],"title":"Title"}' : 'Answer' };
    yield { type: 'text-end', id: 'text' };
  });
  await (await post('/api/chat', { id: session.id, messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }] })).text();
  const saved = await (await fetch(`${base}/api/sessions/${session.id}`)).json() as Session;
  expect(turns).toHaveLength(2);
  expect(turns[1].instructions).toBe(turns[0].instructions);
  expect(turns[1].nativeId).toBe('native-main');
  expect(saved.nativeId).toBe('native-main');
  expect(saved.title).toBe('Title');
  expect(saved.suggestions).toEqual(['Next?']);
  expect(saved.messages).toHaveLength(2);
  expect(saved.messages[1].parts.find(part => part.type === 'text')?.text).toBe('Answer');
});

test('retries a failed native turn in place without adding a continuation message', async () => {
  const turns: HarnessTurn[] = []; let attempts = 0;
  const { post, session, base } = await setup(async function* (turn) {
    turns.push(turn);
    yield { type: 'text-start', id: 'answer' };
    yield { type: 'text-delta', id: 'answer', delta: attempts === 0 ? 'partial' : 'resumed' };
    if (attempts++ === 0) throw new Error('temporary failure');
    yield { type: 'text-end', id: 'answer' };
  });
  const original = message('retry-user', 'Keep this request');
  const first = await post('/api/chat', { id: session.id, messages: [original] });
  expect(first.ok).toBe(true);
  // Headers and the error snapshot can precede journal persistence and active-turn cleanup.
  // Consume each stream as the real Chat client does before asserting its completed state.
  await first.text();
  const failed = await (await fetch(`${base}/api/sessions/${session.id}`)).json() as Session;
  expect(failed.status).toBe('error');
  expect(failed.messages.filter(message => message.role === 'user')).toHaveLength(1);
  const retry = await post('/api/chat', { id: session.id, messages: failed.messages });
  expect(retry.ok).toBe(true);
  await retry.text();
  const recovered = await (await fetch(`${base}/api/sessions/${session.id}`)).json() as Session;
  expect(turns.map(turn => turn.retry)).toEqual([false, true]);
  expect(turns[1]?.messageId).toBe('retry-user');
  expect(recovered.messages.filter(message => message.role === 'user')).toHaveLength(1);
  expect(recovered.messages.filter(message => message.role === 'assistant')).toHaveLength(1);
});

test('a missing adapter rejects a restored session before changing its durable history', async () => {
  const { app, post, session } = await setup(async function* () { throw new Error('Unavailable adapter must not run'); });
  session.harness = 'pi'; await app.store.save(session);
  const before = await readFile(app.store.path(session.id), 'utf8');
  const response = await post('/api/chat', { id: session.id, messages: [message('missing-adapter', 'Run')] });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'This harness is unavailable.' });
  expect(await readFile(app.store.path(session.id), 'utf8')).toBe(before);
  expect(app.active.size).toBe(0);
});

test('command output stays as raw deltas through detached replay and durable recovery', async () => {
  const reached = deferred(), release = deferred();
  const deltas = ['first\n', 'second\n', 'third\n'];
  const { app, post, base, session, cwd } = await setup(async function* () {
    for (const output of deltas) yield { type: 'data-command', data: { toolCallId: 'command', output } };
    reached.resolve(); await release.promise;
  });
  const original = await post('/api/chat', { id: session.id, messages: [message('command-user', 'Run')] });
  await reached.promise; await original.body?.cancel();
  const run = app.active.get(session.id)!;
  const replay = await fetch(`${base}/api/chat/${session.id}/stream`);
  release.resolve();
  const chunks = (await replay.text()).split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)) as ChatChunk);
  const commands = chunks.filter(chunk => chunk.type === 'data-command');
  expect(commands.map(chunk => chunk.data.output)).toEqual(deltas);
  expect(commands.every(chunk => chunk.id === undefined)).toBe(true);
  await run.done;
  const restored = new SessionStore(join(cwd, 'sessions')); await restored.load();
  const outputs = restored.sessions.get(session.id)!.messages[1].parts.flatMap(part => part.type === 'data-command' ? [part.data.output] : []);
  expect(outputs).toEqual(deltas);
});

test('visible partial metadata survives cancellation and a server restart', async () => {
  const reached = deferred();
  const { post, base, session, cwd } = await setup(async function* (turn) {
    if (turn.enrichment) {
      yield { type: 'text-delta', id: 'metadata', delta: '{"title":"Persisted title","suggestions":["First suggestion",' };
      reached.resolve(); await aborted(turn.signal); return;
    }
    turn.onNativeSession('native'); yield { type: 'text-start', id: 'text' }; yield { type: 'text-delta', id: 'text', delta: 'Answer' }; yield { type: 'text-end', id: 'text' };
  });
  await (await post('/api/chat', { id: session.id, messages: [message('u1', 'Run')] })).text();
  await reached.promise;
  const response = await fetch(`${base}/api/sessions/${session.id}/metadata`);
  await post(`/api/sessions/${session.id}/stop`, {});
  expect(await response.text()).toContain('First suggestion');
  const persisted = JSON.parse(await readFile(join(cwd, 'sessions', `${session.id}.json`), 'utf8')) as Session;
  expect(persisted.title).toBe('Persisted title'); expect(persisted.suggestions).toEqual(['First suggestion']); expect(persisted.status).toBe('idle');
});
test('approval round trip and explicit stop release a waiting harness', async () => {
  let waiting!: () => void;
  const ready = new Promise<void>(resolve => { waiting = resolve; });
  const { app, post, session } = await setup(async function* (turn) {
    const approval = turn.approve({ id: 'approval-1', tool: 'write', input: { path: '.artifacts/test.tsx' } });
    waiting();
    const accepted = await approval;
    yield { type: 'text-start', id: 'result' }; yield { type: 'text-delta', id: 'result', delta: String(accepted) }; yield { type: 'text-end', id: 'result' };
  });
  const response = await post('/api/chat', { id: session.id, messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'Run' }] }] });
  await ready;
  expect(app.active.get(session.id)?.approvals.size).toBe(1);
  expect((await post(`/api/sessions/${session.id}/approvals/approval-1`, { approved: true })).ok).toBe(true);
  expect(await response.text()).toContain('"delta":"true"');
});
test('blocks foreign origins and file traversal including outward symlinks', async () => {
  const { base, cwd } = await setup(async function* () {});
  expect((await fetch(base + '/api/sessions', { headers: { origin: 'https://example.com' } })).status).toBe(403);
  expect(() => ui4aPath(cwd, '../secrets')).toThrow();
  await mkdir(join(cwd, '.artifacts'));
  await symlink(tmpdir(), join(cwd, '.artifacts/outside'));
  await expect(writeUi4aFile(cwd, '.artifacts/outside/should-not-exist', 'x')).rejects.toThrow('Symlinks');
  await writeUi4aFile(cwd, '.artifacts/canvases/a.ui4a.tsx', 'export default () => null');
  expect(await readUi4aFile(cwd, '.artifacts/canvases/a.ui4a.tsx')).toBe('export default () => null');
});
test('rejects an artifact root symlink for reads and writes inside the workspace', async () => {
  const cwd = await workspace(), outside = join(cwd, 'private-config');
  await mkdir(outside); await writeFile(join(outside, 'settings.json'), 'unchanged');
  await symlink(outside, join(cwd, '.artifacts'));
  await expect(readUi4aFile(cwd, '.artifacts/settings.json')).rejects.toThrow('Symlinks');
  await expect(writeUi4aFile(cwd, '.artifacts/settings.json', 'changed')).rejects.toThrow('Symlinks');
  await expect(writeUi4aFile(cwd, '.artifacts/new.json', 'created')).rejects.toThrow('Symlinks');
  expect(await readFile(join(outside, 'settings.json'), 'utf8')).toBe('unchanged');
  await expect(readFile(join(outside, 'new.json'))).rejects.toHaveProperty('code', 'ENOENT');
});
test('rejects inner directory and dangling file symlinks leaving the artifact tree', async () => {
  const cwd = await workspace(), outside = join(cwd, 'private-config');
  await mkdir(join(cwd, '.artifacts')); await mkdir(outside); await writeFile(join(outside, 'settings.json'), 'unchanged');
  await symlink('../private-config', join(cwd, '.artifacts/link'));
  await symlink('../private-config/new.json', join(cwd, '.artifacts/dangling.json'));
  await expect(readUi4aFile(cwd, '.artifacts/link/settings.json')).rejects.toThrow('Symlinks');
  await expect(writeUi4aFile(cwd, '.artifacts/link/settings.json', 'changed')).rejects.toThrow('Symlinks');
  await expect(writeUi4aFile(cwd, '.artifacts/link/nested/new.json', 'created')).rejects.toThrow('Symlinks');
  await expect(writeUi4aFile(cwd, '.artifacts/dangling.json', 'created')).rejects.toThrow('Symlinks');
  expect(await readFile(join(outside, 'settings.json'), 'utf8')).toBe('unchanged');
  await expect(readFile(join(outside, 'new.json'))).rejects.toHaveProperty('code', 'ENOENT');
});
test('allows the first artifact write and symlinks resolving within the artifact tree', async () => {
  const cwd = await workspace();
  await writeUi4aFile(cwd, '.artifacts/data/settings.json', 'first');
  await symlink('data', join(cwd, '.artifacts/link'));
  expect(await readUi4aFile(cwd, '.artifacts/link/settings.json')).toBe('first');
  await writeUi4aFile(cwd, '.artifacts/link/settings.json', 'updated');
  await writeUi4aFile(cwd, '.artifacts/link/nested/new.json', 'created');
  expect(await readFile(join(cwd, '.artifacts/data/settings.json'), 'utf8')).toBe('updated');
  expect(await readFile(join(cwd, '.artifacts/data/nested/new.json'), 'utf8')).toBe('created');
});
test('recovers an interrupted disk journal and marks the partial message', async () => {
  const cwd = await workspace(), store = new SessionStore(cwd); await store.load();
  const session: Session = { id: 'recover', harness: 'codex', cwd, title: 'Recover', messages: [], suggestions: [], createdAt: 0, updatedAt: 0, status: 'running' };
  await store.save(session);
  await writeFile(store.journalPath(session.id), [{ type: 'start', messageId: 'partial' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'preserved' }].map(chunk => JSON.stringify(chunk)).join('\n') + '\n{"truncated');
  const restarted = new SessionStore(cwd); await restarted.load();
  expect(restarted.sessions.get('recover')?.messages[0].metadata?.interrupted).toBe(true);
  expect(restarted.sessions.get('recover')?.messages[0].parts[0]).toMatchObject({ type: 'text', text: 'preserved' });
});
test('partial metadata exposes only complete strings', () => {
  expect(parseRecap('{"suggestions":["Ready", "par')).toEqual({ title: undefined, suggestions: ['Ready'] });
  expect(parseRecap('{"suggestions":["Ready"],"title":"incom')).toEqual({ title: undefined, suggestions: ['Ready'] });
});

const deferred = () => { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; };
const aborted = (signal: AbortSignal) => signal.aborted ? Promise.resolve() : new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
const message = (id: string, text: string) => ({ id, role: 'user', parts: [{ type: 'text', text }] });

test('stop waits for native cancellation before accepting an immediate next turn', async () => {
  const running = deferred(), cancelling = deferred(), release = deferred(); let turns = 0;
  const { app, post, session } = await setup(async function* (turn) {
    turns++;
    yield { type: 'text-start', id: 'text' };
    if (turns === 1) { running.resolve(); await aborted(turn.signal); cancelling.resolve(); await release.promise; }
    else yield { type: 'text-delta', id: 'text', delta: 'Next turn' };
    yield { type: 'text-end', id: 'text' };
  });
  const first = await post('/api/chat', { id: session.id, messages: [message('u1', 'First')] }); await running.promise;
  let stopReturned = false;
  const stopped = post(`/api/sessions/${session.id}/stop`, {}).then(response => { stopReturned = true; return response; });
  await cancelling.promise;
  expect(stopReturned).toBe(false); expect(app.active.has(session.id)).toBe(true);
  release.resolve(); expect((await stopped).status).toBe(200);
  const next = await post('/api/chat', { id: session.id, messages: [message('u2', 'Next')] });
  expect(next.status).toBe(200); expect(await next.text()).toContain('Next turn');
  await first.text(); expect(turns).toBe(2);
});

test('a slow metadata fork cannot block the next user turn or write late metadata', async () => {
  const started = deferred(), forkSignals: AbortSignal[] = [];
  let mainRuns = 0;
  const { app, post, session, base } = await setup(async function* (turn) {
    if (turn.enrichment) {
      forkSignals.push(turn.signal); started.resolve(); await aborted(turn.signal);
      // A queued native frame may still arrive while cancellation unwinds.
      yield { type: 'text-delta', id: 'metadata', delta: '{"title":"STALE","suggestions":["STALE"]}' }; return;
    }
    mainRuns++; turn.onNativeSession('native');
    yield { type: 'text-start', id: 'text' }; yield { type: 'text-delta', id: 'text', delta: `answer ${mainRuns}` }; yield { type: 'text-end', id: 'text' };
  });
  const first = await post('/api/chat', { id: session.id, messages: [message('u1', 'First')] });
  await first.text(); await started.promise;
  expect(app.active.has(session.id)).toBe(false);
  expect(app.store.sessions.get(session.id)?.status).toBe('idle');
  const second = await post('/api/chat', { id: session.id, messages: [message('u2', 'Second')] });
  expect(second.status).toBe(200); await second.text();
  expect(mainRuns).toBe(2); expect(forkSignals[0].aborted).toBe(true);
  const saved = await (await fetch(`${base}/api/sessions/${session.id}`)).json() as Session;
  expect(saved.messages).toHaveLength(4); expect(saved.title).not.toBe('STALE'); expect(saved.suggestions).toEqual([]);
});

test('a new turn waits for Hermes metadata cancellation to release its native session', async () => {
  const started = deferred(), cleanup = deferred(); let mainRuns = 0, secondFinished = false;
  const { post, session } = await setup(async function* (turn) {
    if (turn.enrichment) { started.resolve(); await aborted(turn.signal); await cleanup.promise; return; }
    mainRuns++; turn.onNativeSession('native'); yield { type: 'text-start', id: 'text' }; yield { type: 'text-delta', id: 'text', delta: `answer ${mainRuns}` }; yield { type: 'text-end', id: 'text' };
  });
  await (await post('/api/chat', { id: session.id, messages: [message('u1', 'First')] })).text(); await started.promise;
  const second = post('/api/chat', { id: session.id, messages: [message('u2', 'Second')] }).then(async response => { await response.text(); secondFinished = true; return response; });
  await new Promise(resolve => setTimeout(resolve, 10)); expect(secondFinished).toBe(false); cleanup.resolve(); expect((await second).status).toBe(200); expect(mainRuns).toBe(2);
});

test('stop during metadata preserves the successful main turn and closes metadata SSE', async () => {
  const started = deferred(); let metadataSignal: AbortSignal | undefined;
  const { post, session, base, app } = await setup(async function* (turn) {
    if (turn.enrichment) { metadataSignal = turn.signal; started.resolve(); await aborted(turn.signal); return; }
    turn.onNativeSession('native');
    yield { type: 'text-start', id: 't' }; yield { type: 'text-delta', id: 't', delta: 'Completed' }; yield { type: 'text-end', id: 't' };
  });
  await (await post('/api/chat', { id: session.id, messages: [message('u1', 'Run')] })).text();
  await started.promise;
  const metadata = await fetch(`${base}/api/sessions/${session.id}/metadata`);
  expect((await post(`/api/sessions/${session.id}/stop`, {})).status).toBe(200);
  expect(await metadata.text()).toContain('"suggestions":[]');
  expect(metadataSignal?.aborted).toBe(true);
  const saved = app.store.sessions.get(session.id)!;
  expect(saved.status).toBe('idle'); expect(saved.error).toBeUndefined(); expect(saved.messages[1].metadata?.interrupted).not.toBe(true);
});

test('metadata SSE replays the current snapshot and streams only complete suggestions', async () => {
  const reached = deferred(), release = deferred();
  const { post, session, base } = await setup(async function* (turn) {
    if (turn.enrichment) {
      yield { type: 'text-delta', id: 'm', delta: '{"suggestions":["One",' }; reached.resolve(); await Promise.race([release.promise, aborted(turn.signal)]);
      yield { type: 'text-delta', id: 'm', delta: '"Two"],"title":"New title"}' }; return;
    }
    turn.onNativeSession('native'); yield { type: 'text-start', id: 't' }; yield { type: 'text-delta', id: 't', delta: 'Answer' }; yield { type: 'text-end', id: 't' };
  });
  await (await post('/api/chat', { id: session.id, messages: [message('u', 'Run')] })).text(); await reached.promise;
  const response = await fetch(`${base}/api/sessions/${session.id}/metadata`), reader = response.body!.getReader(), decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  expect(first).toContain('"suggestions":["One"]'); release.resolve();
  let tail = '';
  while (true) { const part = await reader.read(); if (part.done) break; tail += decoder.decode(part.value); }
  expect(tail).toContain('"suggestions":["One","Two"]'); expect(tail).toContain('New title'); expect(tail).not.toContain('[DONE]');
});

test('simultaneous POSTs cannot both cross the initial session save', async () => {
  const saving = deferred(), release = deferred(); let runs = 0;
  const { app, post, session } = await setup(async function* () { runs++; yield { type: 'text-start', id: 't' }; yield { type: 'text-delta', id: 't', delta: 'Answer' }; yield { type: 'text-end', id: 't' }; });
  const save = app.store.save.bind(app.store);
  app.store.save = async state => { if (state.status === 'running') { saving.resolve(); await release.promise; } await save(state); };
  const first = post('/api/chat', { id: session.id, messages: [message('u1', 'First')] }); await saving.promise;
  const second = await post('/api/chat', { id: session.id, messages: [message('u2', 'Second')] });
  expect(second.status).toBe(409); release.resolve(); await (await first).text();
  expect(runs).toBe(1); expect(app.store.sessions.get(session.id)?.messages.filter(item => item.role === 'user')).toHaveLength(1);
});

test('failed final persistence closes the client and preserves a recoverable completed journal', async () => {
  const { app, post, session, cwd } = await setup(async function* () { yield { type: 'text-start', id: 't' }; yield { type: 'text-delta', id: 't', delta: 'Durable answer' }; yield { type: 'text-end', id: 't' }; });
  const save = app.store.save.bind(app.store);
  app.store.save = async state => { if (state.status === 'idle' && state.messages.some(item => item.role === 'assistant')) throw new Error('Fixture save failure'); await save(state); };
  const response = await post('/api/chat', { id: session.id, messages: [message('u', 'Run')] });
  expect(await response.text()).toContain('Fixture save failure'); expect(app.active.has(session.id)).toBe(false);
  const recovered = new SessionStore(join(cwd, 'sessions')); await recovered.load();
  expect(recovered.sessions.get(session.id)?.status).toBe('idle');
  expect(recovered.sessions.get(session.id)?.messages[1].parts.find(part => part.type === 'text')?.text).toBe('Durable answer');
});

test('journal open errors abort the harness and cannot leave the client waiting forever', async () => {
  const { app, post, session, cwd } = await setup(async function* (turn) { await aborted(turn.signal); throw new Error('Harness aborted'); });
  app.store.journalPath = () => join(cwd, 'missing', 'journal.jsonl');
  const response = await post('/api/chat', { id: session.id, messages: [message('u', 'Run')] });
  expect(await response.text()).toContain('"type":"error"'); expect(app.active.has(session.id)).toBe(false);
  expect(app.store.sessions.get(session.id)?.status).toBe('error');
});

test('native identity is checkpointed before exposing a recoverable partial answer', async () => {
  const ready = deferred();
  const { app, post, session, cwd } = await setup(async function* (turn) {
    turn.onNativeSession('native-checkpoint');
    yield { type: 'text-start', id: 't' }; yield { type: 'text-delta', id: 't', delta: 'Partial' }; ready.resolve(); await aborted(turn.signal);
  });
  const response = await post('/api/chat', { id: session.id, messages: [message('u', 'Run')] }); await ready.promise;
  const checkpoint = JSON.parse(await readFile(app.store.path(session.id), 'utf8')) as Session;
  expect(checkpoint.nativeId).toBe('native-checkpoint'); expect(checkpoint.status).toBe('running');
  const restartPath = join(cwd, 'restart'), restart = new SessionStore(restartPath); await restart.load(); await restart.save(checkpoint);
  await writeFile(restart.journalPath(session.id), [{ type: 'start', messageId: 'partial' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Partial' }].map(value => JSON.stringify(value)).join('\n'));
  await restart.load(); expect(restart.sessions.get(session.id)?.nativeId).toBe('native-checkpoint');
  await post(`/api/sessions/${session.id}/stop`, {}); await response.text();
});

test('the final artifact scan settles before close and emits nothing after closure', async () => {
  const cwd = await workspace(), chunks: ChatChunk[] = [], observer = new ArtifactObserver(cwd, chunk => chunks.push(chunk));
  await observer.start(); await writeUi4aFile(cwd, '.artifacts/example.tsx', 'export default () => <p>Complete</p>');
  await Promise.all([observer.refresh(), observer.finish()]);
  const artifacts = chunks.filter(chunk => chunk.type === 'data-artifact');
  expect(artifacts.at(-1)?.data).toMatchObject({ source: 'export default () => <p>Complete</p>', streaming: false });
  const count = chunks.length;
  await writeUi4aFile(cwd, '.artifacts/example.tsx', 'changed after finish'); await observer.refresh(); await observer.close();
  expect(chunks).toHaveLength(count);
});

test('closing an in-flight artifact scan suppresses its late frames', async () => {
  const cwd = await workspace(), chunks: ChatChunk[] = [], observer = new ArtifactObserver(cwd, chunk => chunks.push(chunk));
  await writeUi4aFile(cwd, '.artifacts/example.tsx', 'export default () => null');
  const scanning = observer.refresh(); await observer.close(); await scanning;
  expect(chunks).toEqual([]);
});

test('production root serves the app and missing workspace modules return 404', async () => {
  const cwd = await workspace(); await writeFile(join(cwd, 'index.html'), '<main>Artifacts production</main>');
  const app = await createArtifactsServer({ directory: join(cwd, 'sessions'), instructions: 'test', webRoot: cwd });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); cleanups.push(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const root = await fetch(base); expect(root.status).toBe(200); expect(await root.text()).toContain('Artifacts production');
  const session = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd, harness: 'claude-code' }) })).json() as Session;
  expect((await fetch(`${base}/api/sessions/${session.id}/files?path=.artifacts/missing`)).status).toBe(404);
  expect((await fetch(`${base}/api/health`, { headers: { origin: 'not a URL' } })).status).toBe(400);
});

test('metadata failures report redacted diagnostics without changing main success or logging content', async () => {
  const cwd = await workspace(), store = new SessionStore(cwd); await store.load();
  const session: Session = { id: 'metadata-diagnostic', harness: 'codex', nativeId: 'native', cwd, title: 'Main title', messages: [], suggestions: [], createdAt: 0, updatedAt: 0, status: 'idle' };
  await store.save(session);
  const tasks = new MetadataTasks(store), reported = deferred();
  const warn = spyOn(console, 'warn').mockImplementation(() => reported.resolve());
  try {
    tasks.start(session, { id: 'codex', info: async () => ({ ...info, id: 'codex' }), async *run() { throw new Error('Native fork refused Bearer fake-secret-value'); } }, 'private bootstrap text');
    await reported.promise;
    expect(warn).toHaveBeenCalledWith('[metadata]', expect.objectContaining({ sessionId: session.id, harness: 'codex', error: 'Native fork refused Bearer [redacted]' }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private bootstrap text');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('fake-secret-value');
    expect(session.status).toBe('idle'); expect(session.error).toBeUndefined(); expect(session.title).toBe('Main title');
  } finally { warn.mockRestore(); await tasks.close(); }
});
