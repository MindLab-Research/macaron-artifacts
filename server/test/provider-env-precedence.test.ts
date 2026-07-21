import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

// Isolate HOME before importing settings-store: CONFIG_PATH is captured at
// module load from ~/.claude/macaron-config.json, so a temp HOME keeps these
// tests off the real config.
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), 'macaron-env-'));

const store = await import('../src/lib/settings-store.js');
// Import the real launcher parser (guarded to not boot the server on import)
// for a genuine CLI-form → warmSettingsCache() → routed-model integration.
const { parseArgs } = await import('../../bin/mcc.mjs');

// The launch override is captured once per warmSettingsCache() call from the
// ambient env, so each test sets env then re-warms to simulate a fresh boot.
async function boot(env: { base?: string; model?: string }) {
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_MODEL;
  if (env.base) process.env.ANTHROPIC_BASE_URL = env.base;
  if (env.model) process.env.ANTHROPIC_MODEL = env.model;
  await store.warmSettingsCache();
}

async function seedCustomActive() {
  const p = await store.addProvider({ name: 'Stored', endpoint: 'https://api.example.com/v1', model: 'stored-model', apiKey: 'sk-test' });
  await store.setActiveProvider(p.id);
  return p;
}

beforeEach(async () => {
  // Reset persisted state to a known System-active baseline between tests.
  await boot({});
  await store.setActiveProvider(store.SYSTEM_PROVIDER_ID);
});

test('System launch passes ambient ANTHROPIC_MODEL through with no env override', async () => {
  await boot({ model: 'Macaron-V1-Venti' });
  const { model, env } = store.getActiveProviderEnv();
  assert.equal(model, 'Macaron-V1-Venti');
  assert.equal(env, null);
});

test('System launch with no ambient model yields undefined', async () => {
  await boot({});
  const { model, env } = store.getActiveProviderEnv();
  assert.equal(model, undefined);
  assert.equal(env, null);
});

test('System launch follows the model in user settings.json', async () => {
  const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ model: 'macaron-settings-model' }));
  try {
    await boot({});
    const { model, env } = store.getActiveProviderEnv();
    assert.equal(model, 'macaron-settings-model');
    assert.equal(env, null);
  } finally {
    rmSync(settingsPath, { force: true });
  }
});

test('an explicit launch model still takes precedence over settings.json', async () => {
  const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ model: 'settings-model' }));
  try {
    await boot({ model: 'launch-model' });
    assert.equal(store.getActiveProviderEnv().model, 'launch-model');
  } finally {
    rmSync(settingsPath, { force: true });
  }
});

test('invalid settings.json does not break provider resolution', async () => {
  const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
  writeFileSync(settingsPath, '{not-json');
  try {
    await boot({});
    const { model, env } = store.getActiveProviderEnv();
    assert.equal(model, undefined);
    assert.equal(env, null);
  } finally {
    rmSync(settingsPath, { force: true });
  }
});

test('active custom provider builds a relay env override', async () => {
  await boot({});
  await seedCustomActive();
  const { model, env } = store.getActiveProviderEnv();
  assert.equal(model, 'stored-model');
  assert.ok(env);
  assert.match(env!.ANTHROPIC_BASE_URL, /\/relay\/anthropic\//);
});

test('custom provider without a model follows user settings.json', async () => {
  const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ model: 'macaron-settings-model' }));
  try {
    await boot({});
    const p = await store.addProvider({
      name: 'Stored without model',
      endpoint: 'https://api.example.com/v1',
      model: '',
      apiKey: 'sk-test',
    });
    await store.setActiveProvider(p.id);

    const { model, env } = store.getActiveProviderEnv();
    assert.equal(model, 'macaron-settings-model');
    assert.ok(env);
    assert.equal(env!.ANTHROPIC_MODEL, 'macaron-settings-model');
  } finally {
    rmSync(settingsPath, { force: true });
  }
});

test('base-URL launch overrides a stale persisted custom provider (route + UI agree)', async () => {
  await seedCustomActive();
  await boot({ base: 'https://mint.macaron.im', model: 'Macaron-V1-Venti' });
  const { model, env } = store.getActiveProviderEnv();
  assert.equal(model, 'Macaron-V1-Venti');
  assert.equal(env, null); // pass-through, not the relay
  const pub = await store.readPublicSettings();
  assert.equal(pub.activeProviderId, store.SYSTEM_PROVIDER_ID); // UI shows System too
});

test('model-only launch overrides a stale persisted custom provider', async () => {
  await seedCustomActive();
  await boot({ model: 'cli-model' }); // no ambient base URL
  const { model, env } = store.getActiveProviderEnv();
  assert.equal(model, 'cli-model');
  assert.equal(env, null);
  const pub = await store.readPublicSettings();
  assert.equal(pub.activeProviderId, store.SYSTEM_PROVIDER_ID);
});

test('selecting a custom provider clears the launch override and restores isolation', async () => {
  const p = await seedCustomActive();
  await boot({ base: 'https://mint.macaron.im', model: 'Macaron-V1-Venti' });
  // UI initially agrees on System while launched with ambient env.
  assert.equal((await store.readPublicSettings()).activeProviderId, store.SYSTEM_PROVIDER_ID);
  // Explicit selection retires the override.
  await store.setActiveProvider(p.id);
  const { model, env } = store.getActiveProviderEnv();
  assert.equal(model, 'stored-model');
  assert.ok(env);
  assert.match(env!.ANTHROPIC_BASE_URL, /\/relay\/anthropic\//); // relay isolation restored
  assert.equal((await store.readPublicSettings()).activeProviderId, p.id); // UI shows the provider
});

// ---- Finding 1: setActiveProvider() is transactional --------------------

test('a failed provider-selection persist restores cached provider and launchOverride', async () => {
  const p = await seedCustomActive();
  await boot({ base: 'https://mint.macaron.im', model: 'Macaron-V1-Venti' });
  assert.equal((await store.readPublicSettings()).activeProviderId, store.SYSTEM_PROVIDER_ID);

  // Force persist() to fail: replace the config file with a directory so
  // writeFile(CONFIG_PATH) throws EISDIR. The cache mutation must roll back.
  const fs = await import('node:fs');
  const cfg = path.join(process.env.HOME!, '.claude', 'macaron-config.json');
  fs.rmSync(cfg, { force: true });
  fs.mkdirSync(cfg, { recursive: true });
  try {
    await assert.rejects(() => store.setActiveProvider(p.id));
    // Cache + override must be untouched: still System/pass-through.
    assert.equal((await store.readPublicSettings()).activeProviderId, store.SYSTEM_PROVIDER_ID);
    const { model, env } = store.getActiveProviderEnv();
    assert.equal(model, 'Macaron-V1-Venti');
    assert.equal(env, null); // still pass-through, NOT the custom relay
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
  }
});

// ---- Finding 2: real launcher-to-boot integration -----------------------

for (const [label, argv] of [
  ['spaced', ['--model', 'Macaron-V1-Venti']],
  ['inline', ['--model=Macaron-V1-Venti']],
] as const) {
  test(`launcher ${label} --model boots System and routes the CLI model`, async () => {
    await seedCustomActive(); // a stale persisted provider that must be overridden
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_MODEL;
    let exited: number | null = null;
    await parseArgs([...argv], (code: number) => { exited = code; });
    assert.equal(exited, null); // no --help/--version short-circuit
    assert.equal(process.env.ANTHROPIC_MODEL, 'Macaron-V1-Venti'); // CLI form propagated to env
    await store.warmSettingsCache(); // boot picks up the launch override
    assert.equal((await store.readPublicSettings()).activeProviderId, store.SYSTEM_PROVIDER_ID);
    const { model, env } = store.getActiveProviderEnv();
    assert.equal(model, 'Macaron-V1-Venti'); // routed model is the CLI model, not the stored one
    assert.equal(env, null);
  });
}

// ---- Finding 3: base-URL-only pass-through uses default Claude auth ------

test('base-URL-only launch (no creds/model) passes through to the default Claude auth path', async () => {
  await seedCustomActive();
  await boot({ base: 'https://mint.macaron.im' }); // no token, no model
  // Accepted behavior: base URL alone is a launch override → System pass-through.
  // The SDK inherits the ambient env untouched (env: null), so auth falls to the
  // user's existing/default ~/.claude Claude Code login — we set no credentials.
  const { model, env } = store.getActiveProviderEnv();
  assert.equal(model, undefined); // no ambient model → SDK default
  assert.equal(env, null); // no relay, no injected CLAUDE_CONFIG_DIR/token
  assert.equal((await store.readPublicSettings()).activeProviderId, store.SYSTEM_PROVIDER_ID);
});

// ---- Interaction with main's seedProviderFromEnv() bootstrap ------------

test('env-seeding a full provider clears the launch override so UI/routing route the relay', async () => {
  // A pasted endpoint + token (the seed contract) + a boot launch override.
  process.env.MACARON_PROVIDER_ENDPOINT = 'https://mint.macaron.im/v1';
  process.env.MACARON_PROVIDER_TOKEN = 'sk-seed';
  process.env.MACARON_PROVIDER_MODEL = 'macaron-v1-venti';
  try {
    await boot({ base: 'https://mint.macaron.im/v1', model: 'macaron-v1-venti' });
    // Boot order mirrors index.ts: warmSettingsCache() then seedProviderFromEnv().
    const res = await store.seedProviderFromEnv();
    assert.ok(res.seeded && res.activated); // activated over the system default
    // The seeded provider must win — the launch override is retired, so both
    // surfaces route the relay instead of shadowing back to System.
    const pub = await store.readPublicSettings();
    assert.equal(pub.activeProviderId, res.seeded ? res.providerId : '');
    const { env } = store.getActiveProviderEnv();
    assert.ok(env);
    assert.match(env!.ANTHROPIC_BASE_URL, /\/relay\/anthropic\//);
  } finally {
    delete process.env.MACARON_PROVIDER_ENDPOINT;
    delete process.env.MACARON_PROVIDER_TOKEN;
    delete process.env.MACARON_PROVIDER_MODEL;
  }
});

test('a complete env seed with a manual provider already active keeps that provider (kept-active-choice)', async () => {
  const manual = await seedCustomActive(); // user manually picked this one
  process.env.MACARON_PROVIDER_ENDPOINT = 'https://mint.macaron.im/v1';
  process.env.MACARON_PROVIDER_TOKEN = 'sk-seed';
  process.env.MACARON_PROVIDER_MODEL = 'macaron-v1-venti';
  try {
    // Boot with the full ambient env (sets launchOverride) while `manual` stays active.
    await boot({ base: 'https://mint.macaron.im/v1', model: 'macaron-v1-venti' });
    const res = await store.seedProviderFromEnv();
    assert.ok(res.seeded);
    assert.equal(res.activated, false); // main's contract: kept the manual choice
    // The override must be cleared even though we didn't activate the seeded row,
    // so UI + routing keep using the MANUAL provider — not ambient pass-through.
    const pub = await store.readPublicSettings();
    assert.equal(pub.activeProviderId, manual.id);
    const { model, env } = store.getActiveProviderEnv();
    assert.equal(model, 'stored-model'); // the manual provider's model, not the CLI one
    assert.ok(env);
    assert.match(env!.ANTHROPIC_BASE_URL, /\/relay\/anthropic\//);
  } finally {
    delete process.env.MACARON_PROVIDER_ENDPOINT;
    delete process.env.MACARON_PROVIDER_TOKEN;
    delete process.env.MACARON_PROVIDER_MODEL;
  }
});

test('a model-only launch seeds nothing and keeps the pass-through override', async () => {
  await seedCustomActive();
  await boot({ model: 'cli-model' }); // no endpoint/token → seed is a no-op
  const res = await store.seedProviderFromEnv();
  assert.equal(res.seeded, false); // missing-env
  const { model, env } = store.getActiveProviderEnv();
  assert.equal(model, 'cli-model'); // override still governs
  assert.equal(env, null);
  assert.equal((await store.readPublicSettings()).activeProviderId, store.SYSTEM_PROVIDER_ID);
});
