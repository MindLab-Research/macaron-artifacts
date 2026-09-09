import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessProfile, ProfileInput } from '../shared/profiles.js';
import type { ChatChunk, HarnessId, Session } from '../shared/types.js';
import { createArtifactsServer } from './index.js';
import { ProfileStore } from './profiles.js';
import { createCodexProfiles } from './harnesses/codex-profiles.js';
import { safeProfileError } from './harnesses/common.js';
import type { CodexConnection } from './harnesses/codex-rpc.js';
import type { HarnessAdapter, HarnessTurn } from './harnesses/types.js';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
const releases: (() => void)[] = [];
afterEach(async () => { for (const release of releases.splice(0)) release(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); releases.push(resolve); return { promise, resolve }; }
const info = { id: 'claude-code', name: 'Profile fixture', available: true, capabilities: { textDeltas: true, reasoningDeltas: true, toolInputDeltas: true, commandOutputDeltas: true, approvals: true, fork: true } } as const;
async function* answer(turn: HarnessTurn): AsyncGenerator<ChatChunk> {
  yield { type: 'text-start', id: 'text' };
  yield { type: 'text-delta', id: 'text', delta: turn.enrichment ? '{"title":"Fixture","suggestions":["Next"]}' : 'Answer' };
  yield { type: 'text-end', id: 'text' };
}
async function setup(run: HarnessAdapter['run'] = answer) {
  const cwd = await mkdtemp(join(tmpdir(), 'artifacts-http-profiles-')); cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const connect = (): CodexConnection => ({ async request(method) { return method === 'config/read' ? { config: { model: 'native-default', model_reasoning_effort: 'medium' }, layers: [] } : method === 'model/list' ? { data: [{ model: 'native-default', isDefault: true, defaultReasoningEffort: 'medium' }] } : {}; }, notify() {}, async close() {} });
  const native = createCodexProfiles(join(cwd, 'native-codex'), connect);
  const profiles = new ProfileStore(join(cwd, 'profiles'), { list: native.list, save: native.save, remove: native.delete, resolve: native.resolve, defaults: native.defaults }, async (_cwd, profile) => profile);
  const observedOptions: Pick<HarnessTurn, 'cwd' | 'profile'>[] = [];
  const adapter: HarnessAdapter = { id: 'claude-code', async info() { return info; }, run, async profileOptions(cwd, profile) { observedOptions.push({ cwd, profile }); return { models: [{ id: profile?.config.model || 'default', name: 'Fixture model' }], efforts: ['high'] }; } };
  const harnesses = Object.fromEntries((['claude-code', 'codex', 'pi'] as HarnessId[]).map(id => [id, { ...adapter, id }])) as Partial<Record<HarnessId, HarnessAdapter>>;
  const app = await createArtifactsServer({ directory: join(cwd, 'sessions'), instructions: 'stable-bootstrap', harnesses, profiles });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); cleanups.push(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const request = (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const createProfile = async (input: Partial<ProfileInput> = {}) => {
    const response = await request('POST', '/api/profiles', { harness: 'claude-code', name: 'Work', config: { model: 'profile-model' }, ...input });
    expect(response.status).toBe(201); return await response.json() as HarnessProfile;
  };
  const createSession = async (profile?: HarnessProfile, model?: string) => {
    const response = await request('POST', '/api/sessions', { cwd, harness: profile?.harness || 'claude-code', profileId: profile?.id, model });
    expect(response.status).toBe(201); return await response.json() as Session;
  };
  const chat = (session: Session, id: string) => request('POST', '/api/chat', { id: session.id, messages: [{ id, role: 'user', parts: [{ type: 'text', text: id }] }] });
  return { app, profiles, native, cwd, request, createProfile, createSession, chat, observedOptions };
}

test('profile HTTP CRUD keeps keys out of DTOs and sessions and rejects stale revisions', async () => {
  const { app, cwd, request, createProfile, createSession } = await setup();
  for (const harness of ['claude-code', 'codex'] as const) {
    const profile = await createProfile({ harness, name: 'Work', config: { model: 'main', subagentModel: 'sub', effort: 'high', authMode: 'api-key' }, credentials: { apiKey: `private-${harness}-key` } });
    expect(profile.credentials).toEqual({ apiKey: true, authToken: false }); expect(JSON.stringify(profile)).not.toContain(`private-${harness}-key`);
    const input = { harness, name: profile.name, revision: profile.revision, config: { ...profile.config, model: 'updated' } };
    const results = await Promise.all([request('PUT', `/api/profiles/${profile.id}`, input), request('PUT', `/api/profiles/${profile.id}`, { ...input, config: { ...input.config, model: 'other' } })]);
    expect(results.map(response => response.status).sort()).toEqual([200, 409]);
    const updated = await results.find(response => response.status === 200)!.json() as HarnessProfile;
    expect(updated.credentials.apiKey).toBe(true);
    const session = await createSession(updated);
    const publicSession = await (await request('GET', `/api/sessions/${session.id}`)).text(), publicList = await (await request('GET', '/api/profiles')).text();
    expect(publicSession).not.toContain(`private-${harness}-key`); expect(publicList).not.toContain(`private-${harness}-key`);
    expect(await readFile(app.store.path(session.id), 'utf8')).not.toContain(`private-${harness}-key`);
    expect((await request('DELETE', `/api/profiles/${profile.id}`, { revision: updated.revision })).status).toBe(409);
    expect((await request('PATCH', `/api/sessions/${session.id}`, { profileId: null })).status).toBe(200);
    expect((await request('DELETE', `/api/profiles/${profile.id}`, { revision: profile.revision })).status).toBe(409);
    expect((await request('DELETE', `/api/profiles/${profile.id}`, { revision: updated.revision })).status).toBe(200);
  }
  expect(await (await request('GET', '/api/profiles')).json()).toEqual([]);
  expect(await readFile(join(cwd, 'profiles', 'profiles.json'), 'utf8')).not.toContain('private-');
});

test('session creation and option discovery reject missing and mismatched profiles without mutating sessions', async () => {
  const { app, cwd, request, createProfile, createSession, observedOptions } = await setup();
  const profile = await createProfile({ config: { model: 'chosen', authMode: 'api-key' }, credentials: { apiKey: 'options-secret' } });
  const session = await createSession();
  for (const id of ['missing-profile', 'codex:missing']) {
    const harness = id.startsWith('codex:') ? 'codex' : 'claude-code';
    expect((await request('POST', '/api/sessions', { cwd, harness, profileId: id })).status).toBe(404);
    expect((await request('GET', `/api/harnesses/${harness}/profile-options?cwd=${encodeURIComponent(cwd)}&profileId=${id}`)).status).toBe(404);
  }
  expect((await request('POST', '/api/sessions', { cwd, harness: 'codex', profileId: profile.id })).status).toBe(400);
  expect((await request('GET', `/api/harnesses/codex/profile-options?cwd=${encodeURIComponent(cwd)}&profileId=${profile.id}`)).status).toBe(400);
  expect((await request('PATCH', `/api/sessions/${session.id}`, { profileId: 'codex:missing' })).status).toBe(400);
  const response = await request('GET', `/api/harnesses/claude-code/profile-options?cwd=${encodeURIComponent(cwd)}&profileId=${profile.id}`);
  expect(response.status).toBe(200); const text = await response.text(); expect(text).toContain('chosen'); expect(text).not.toContain('options-secret');
  expect(observedOptions).toHaveLength(1); expect(observedOptions[0].profile?.apiKey).toBe('options-secret');
  expect(app.store.sessions.size).toBe(1); expect(app.store.sessions.get(session.id)?.profileId).toBeUndefined();
});

test('a reserved profile binding blocks deletion during both session creation and profile switching', async () => {
  const { profiles, request, createProfile, createSession, cwd } = await setup();
  for (const operation of ['create', 'patch'] as const) {
    const profile = await createProfile({ name: operation }), session = operation === 'patch' ? await createSession() : undefined;
    const started = deferred(), release = deferred(), resolve = profiles.resolve.bind(profiles);
    const mock = spyOn(profiles, 'resolve').mockImplementation(async (id, harness, cwd) => { if (id === profile.id) { started.resolve(); await release.promise; } return resolve(id, harness, cwd); });
    try {
      const binding = operation === 'create' ? request('POST', '/api/sessions', { cwd, harness: 'claude-code', profileId: profile.id }) : request('PATCH', `/api/sessions/${session!.id}`, { profileId: profile.id });
      await started.promise;
      expect((await request('DELETE', `/api/profiles/${profile.id}`, { revision: profile.revision })).status).toBe(409);
      release.resolve(); expect((await binding).status).toBe(operation === 'create' ? 201 : 200);
    } finally { release.resolve(); mock.mockRestore(); }
  }
});

test('an in-progress deletion blocks new and switched session bindings atomically', async () => {
  const { app, profiles, request, createProfile, createSession, cwd } = await setup(), profile = await createProfile(), session = await createSession();
  const started = deferred(), release = deferred(), remove = profiles.remove.bind(profiles);
  const mock = spyOn(profiles, 'remove').mockImplementation(async (id, expected) => { started.resolve(); await release.promise; return remove(id, expected); });
  try {
    const deleting = request('DELETE', `/api/profiles/${profile.id}`, { revision: profile.revision }); await started.promise;
    const attempts = await Promise.all([request('POST', '/api/sessions', { cwd, harness: 'claude-code', profileId: profile.id }), request('PATCH', `/api/sessions/${session.id}`, { profileId: profile.id })]);
    expect(attempts.map(response => response.status)).toEqual([409, 409]);
    release.resolve(); expect((await deleting).status).toBe(200);
    expect(app.store.sessions.size).toBe(1); expect(app.store.sessions.get(session.id)?.profileId).toBeUndefined();
  } finally { release.resolve(); mock.mockRestore(); }
});

test('profile edits affect the next turn while active main and metadata retain their profile and explicit model snapshots', async () => {
  const mainStarted = deferred(), releaseMain = deferred(), metadataStarted = deferred(), releaseMetadata = deferred(), nextMetadata = deferred();
  const turns: Pick<HarnessTurn, 'profile' | 'model' | 'nativeId' | 'enrichment'>[] = []; let mainCount = 0;
  const { app, request, createProfile, createSession, chat } = await setup(async function* (turn) {
    turns.push({ profile: structuredClone(turn.profile), model: turn.model, nativeId: turn.nativeId, enrichment: turn.enrichment });
    if (!turn.enrichment) {
      mainCount++; turn.onNativeSession('native-main');
      if (mainCount === 1) { mainStarted.resolve(); await releaseMain.promise; }
    } else if (mainCount === 1) { metadataStarted.resolve(); await releaseMetadata.promise; if (turn.signal.aborted) return; }
    else nextMetadata.resolve();
    yield* answer(turn);
  });
  const profile = await createProfile({ config: { model: 'profile-old', subagentModel: 'sub-old', authMode: 'api-key' }, credentials: { apiKey: 'key-old' } });
  const session = await createSession(profile, 'override-old');
  const first = chat(session, 'first-user'); await mainStarted.promise;
  expect((await request('PATCH', `/api/sessions/${session.id}`, { model: 'rejected-while-running' })).status).toBe(409);
  expect((await request('PATCH', `/api/sessions/${session.id}`, { profileId: null })).status).toBe(409);
  const update = await request('PUT', `/api/profiles/${profile.id}`, { harness: profile.harness, name: profile.name, revision: profile.revision, config: { model: 'profile-new', subagentModel: 'sub-new', authMode: 'api-key' }, credentials: { apiKey: 'key-new' } });
  expect(update.status).toBe(200); releaseMain.resolve(); await metadataStarted.promise;
  await (await first).text();
  expect(turns.slice(0, 2).map(turn => ({ model: turn.model, config: turn.profile?.config, apiKey: turn.profile?.apiKey }))).toEqual([
    { model: 'override-old', config: { model: 'profile-old', subagentModel: 'sub-old', authMode: 'api-key' }, apiKey: 'key-old' },
    { model: 'override-old', config: { model: 'profile-old', subagentModel: 'sub-old', authMode: 'api-key' }, apiKey: 'key-old' },
  ]);
  const switched = await request('PATCH', `/api/sessions/${session.id}`, { model: 'override-new' }); expect(switched.status).toBe(200);
  expect((await switched.json() as Session).nativeId).toBe('native-main'); releaseMetadata.resolve();
  await (await chat(session, 'second-user')).text(); await nextMetadata.promise;
  expect(turns.slice(2).map(turn => ({ model: turn.model, profileModel: turn.profile?.config.model, apiKey: turn.profile?.apiKey, nativeId: turn.nativeId }))).toEqual([
    { model: 'override-new', profileModel: 'profile-new', apiKey: 'key-new', nativeId: 'native-main' },
    { model: 'override-new', profileModel: 'profile-new', apiKey: 'key-new', nativeId: 'native-main' },
  ]);
  const saved = app.store.sessions.get(session.id)!; expect(saved.profileId).toBe(profile.id); expect(saved.messages).toHaveLength(4);
  expect(await readFile(app.store.path(session.id), 'utf8')).not.toMatch(/key-old|key-new|"nativeConfig"|"credentials"/);
  const alternative = await createProfile({ name: 'Alternative', config: { model: 'profile-alternative' } });
  const switchedProfile = await request('PATCH', `/api/sessions/${session.id}`, { profileId: alternative.id, model: null });
  expect(switchedProfile.status).toBe(200); expect(await switchedProfile.json()).toMatchObject({ id: session.id, nativeId: 'native-main', profileId: alternative.id });
  await (await chat(session, 'third-user')).text();
  expect(turns.slice(-2).map(turn => ({ profileModel: turn.profile?.config.model, model: turn.model, nativeId: turn.nativeId }))).toEqual([
    { profileModel: 'profile-alternative', model: undefined, nativeId: 'native-main' },
    { profileModel: 'profile-alternative', model: undefined, nativeId: 'native-main' },
  ]);
});

test('a harness error cannot copy configured credentials into SSE, session DTOs or session files', async () => {
  const { app, request, createProfile, createSession, chat } = await setup(async function* (turn) { throw new Error(`Provider refused credential ${turn.profile?.apiKey}`); });
  const profile = await createProfile({ config: { authMode: 'api-key' }, credentials: { apiKey: 'gateway-arbitrary-secret-value' } }), session = await createSession(profile);
  const response = await chat(session, 'fail-user');
  expect(await response.text()).not.toContain('gateway-arbitrary-secret-value');
  expect(await (await request('GET', `/api/sessions/${session.id}`)).text()).not.toContain('gateway-arbitrary-secret-value');
  expect(await readFile(app.store.path(session.id), 'utf8')).not.toContain('gateway-arbitrary-secret-value');
});

test('explicit native inheritance preserves the thread while passing an empty profile snapshot and clearing the model', async () => {
  const observed: Pick<HarnessTurn, 'model' | 'profile' | 'nativeId' | 'enrichment'>[] = [];
  const { request, createProfile, createSession, chat } = await setup(async function* (turn) {
    observed.push({ model: turn.model, profile: structuredClone(turn.profile), nativeId: turn.nativeId, enrichment: turn.enrichment });
    if (!turn.enrichment) turn.onNativeSession('preserved-native-thread');
    yield* answer(turn);
  });
  const profile = await createProfile({ config: { model: 'profile-model' } }), session = await createSession(profile, 'session-model');
  await (await chat(session, 'configured-turn')).text();
  const reset = await request('PATCH', `/api/sessions/${session.id}`, { profileId: null, model: null });
  expect(reset.status).toBe(200); const saved = await reset.json() as Session;
  expect(saved.profileId).toBeNull(); expect(saved.model).toBeUndefined(); expect(saved.nativeId).toBe('preserved-native-thread');
  await (await chat(session, 'inherited-turn')).text();
  expect(observed.slice(-2).map(turn => ({ model: turn.model, profile: turn.profile, nativeId: turn.nativeId }))).toEqual([
    { model: undefined, profile: { config: {} }, nativeId: 'preserved-native-thread' },
    { model: undefined, profile: { config: {} }, nativeId: 'preserved-native-thread' },
  ]);
});

test('yielded native and tool error chunks are scrubbed before journal replay and message persistence', async () => {
  const { app, request, createProfile, createSession, chat } = await setup(async function* (turn) {
    yield { type: 'tool-input-available', toolCallId: 'tool', toolName: 'Fixture', input: {} };
    yield { type: 'tool-output-error', toolCallId: 'tool', errorText: `Tool refused ${turn.profile?.authToken}` };
    yield { type: 'error', errorText: `Harness refused ${turn.profile?.authToken}` };
  });
  const profile = await createProfile({ config: { authMode: 'auth-token' }, credentials: { authToken: 'arbitrary-auth-token' } }), session = await createSession(profile);
  const stream = await (await chat(session, 'native-error-user')).text();
  expect(stream).toContain('Tool refused [redacted]'); expect(stream).toContain('Harness refused [redacted]'); expect(stream).not.toContain('arbitrary-auth-token');
  expect(await (await request('GET', `/api/sessions/${session.id}`)).text()).not.toContain('arbitrary-auth-token');
  expect(await readFile(app.store.path(session.id), 'utf8')).not.toContain('arbitrary-auth-token');
});

test('metadata failure diagnostics redact the captured key while preserving successful main output', async () => {
  const reported = deferred(), warn = spyOn(console, 'warn').mockImplementation(() => reported.resolve()); cleanups.push(() => warn.mockRestore());
  const { app, createProfile, createSession, chat } = await setup(async function* (turn) {
    if (turn.enrichment) throw new Error(`Metadata refused ${turn.profile?.apiKey}`);
    turn.onNativeSession('metadata-native'); yield* answer(turn);
  });
  const profile = await createProfile({ config: { authMode: 'api-key' }, credentials: { apiKey: 'private-metadata-key' } }), session = await createSession(profile);
  await (await chat(session, 'metadata-user')).text(); await reported.promise;
  expect(warn).toHaveBeenCalledWith('[metadata]', expect.objectContaining({ error: 'Metadata refused [redacted]' }));
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private-metadata-key');
  expect(app.store.sessions.get(session.id)?.status).toBe('idle'); expect(app.store.sessions.get(session.id)?.error).toBeUndefined();
});

test('persistence rejection diagnostics are scrubbed before the server logs the rejected turn', async () => {
  const reported = deferred(), error = spyOn(console, 'error').mockImplementation(() => reported.resolve()); cleanups.push(() => error.mockRestore());
  const { app, createProfile, createSession, chat } = await setup(), profile = await createProfile({ config: { authMode: 'api-key' }, credentials: { apiKey: 'private-persistence-key' } }), session = await createSession(profile);
  const save = app.store.save.bind(app.store), mock = spyOn(app.store, 'save').mockImplementation(async value => { if (value.status === 'idle' && value.messages.length >= 2) throw new Error('Persistence refused private-persistence-key'); return save(value); });
  cleanups.push(() => mock.mockRestore());
  const stream = await (await chat(session, 'persistence-user')).text(); await reported.promise;
  expect(stream).not.toContain('private-persistence-key');
  expect(error.mock.calls[0]?.[1]).toMatchObject({ message: 'Persistence refused [redacted]' });
  expect(app.store.sessions.get(session.id)?.error).toBe('Persistence refused [redacted]');
});

test('known native provider tokens and auth headers are redacted even without app-stored credentials', () => {
  const message = safeProfileError(new Error('direct-native-value / header-native-value'), { config: {}, nativeConfig: { model_providers: { private: { experimental_bearer_token: 'direct-native-value', http_headers: { Authorization: 'Bearer header-native-value' } } } } });
  expect(message).toBe('[redacted] / [redacted]');
  expect(safeProfileError('Refused sk-prefix.private-suffix', { config: {}, apiKey: 'sk-prefix.private-suffix' })).toBe('Refused [redacted]');
});
