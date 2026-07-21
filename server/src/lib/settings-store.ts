// Persisted plugin settings, held in ~/.claude/macaron-config.json.
//
// Data model: the user manages an arbitrary list of Anthropic-compatible
// providers (Macaron, OpenRouter, LiteLLM, self-hosted, …) and picks one
// as active. The special built-in "anthropic" provider always exists,
// uses the user's ambient Claude Code login, and can't be edited/deleted.
//
// Cache is warmed at startup so getActiveProviderEnv() is synchronous —
// hot-path request handlers can call it without awaiting disk I/O.

import { promises as fs, readFileSync, mkdirSync, existsSync, symlinkSync, lstatSync, rmSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { HOME, HOST, PORT, MACARON_API_BASE, MACARON_API_KEY, MACARON_MODEL } from '../config.js';

// The built-in pass-through provider. Never touches the SDK subprocess env —
// it inherits process.env unchanged. Whatever ANTHROPIC_BASE_URL /
// ANTHROPIC_AUTH_TOKEN the user has in their shell is exactly what runs.
export const SYSTEM_PROVIDER_ID = 'system';
// Legacy id kept for one-shot migration only.
const LEGACY_ANTHROPIC_ID = 'anthropic';

const DEFAULT_PROVIDER_NAME = 'Custom provider';

export type CustomProvider = {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  apiKey: string;
};

// Canonical permission-mode set, mirrored on the client via PermissionMode in
// StatusBar.tsx. New sessions initialise their per-session picker to whichever
// mode this global default names — sessions may still override themselves.
export type DefaultPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'bypassPermissions';

export type Settings = {
  activeProviderId: string; // 'anthropic' or a CustomProvider.id
  customProviders: CustomProvider[];
  // Global default for the per-session permission picker. Sessions initialise
  // their own permissionMode to this value on start; a session can still cycle
  // its picker (Shift+Tab / chip select) to override for that session only.
  // 'bypassPermissions' reproduces the old YOLO behaviour (SDK auto-approves
  // every tool call) but per-session override remains available.
  defaultPermissionMode: DefaultPermissionMode;
  // Follow-up suggestions make an extra model call after each clean turn.
  // Default off so users explicitly opt into the token spend.
  followupSuggestions: boolean;
};

// Public projection sent to the client. Never surfaces raw apiKey — only a
// `configured` boolean so the UI can toggle placeholder text.
export type PublicCustomProvider = {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  configured: boolean;
};

export type PublicBuiltinProvider = {
  id: 'system';
  name: string;
  description: string;
  // If the ambient env has ANTHROPIC_BASE_URL set, surface it so the user
  // can tell what their pass-through is actually pointing at (e.g. a GLM
  // relay). null = truly using Anthropic direct.
  detectedEndpoint: string | null;
};

export type PublicSettings = {
  activeProviderId: string;
  builtins: PublicBuiltinProvider[];
  customProviders: PublicCustomProvider[];
  defaultPermissionMode: DefaultPermissionMode;
  followupSuggestions: boolean;
};

const CONFIG_PATH = path.join(HOME, '.claude', 'macaron-config.json');
const CLAUDE_SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');

let cache: Settings | null = null;

// The SDK normally resolves this from settings.json itself. Custom-provider
// runs use an isolated CLAUDE_CONFIG_DIR for auth, though, so the SDK cannot
// see the user's model setting there. Read only this field synchronously on
// the request path so edits made through the Settings page take effect on the
// next turn without another server restart. Invalid or missing files mean the
// same thing as an unset model and fall back to the normal env/SDK behavior.
function readClaudeSettingsModel(): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const model = (parsed as { model?: unknown }).model;
    return typeof model === 'string' && model.trim() ? model.trim() : undefined;
  } catch {
    return undefined;
  }
}

// Launch override: a pasted `mcc` env block (ANTHROPIC_BASE_URL) or `--model`
// (ANTHROPIC_MODEL) at boot is a "run against these params now" intent that
// forces System/pass-through, regardless of the persisted provider. Captured
// once at warm so the effective route and the UI agree on ONE active id.
// Cleared the moment the user picks a provider — that's an explicit choice to
// use its isolated credentials/config instead of the launch env.
let launchOverride = false;
// Effective active provider id: launch override collapses to System.
function effectiveActiveId(s: Settings): string {
  return launchOverride ? SYSTEM_PROVIDER_ID : s.activeProviderId;
}

function seedMacaronProvider(): CustomProvider {
  return {
    id: randomUUID(),
    name: DEFAULT_PROVIDER_NAME,
    endpoint: MACARON_API_BASE,
    model: MACARON_MODEL,
    // Seed from env var so old .env-based setups keep working without a
    // WebUI save. Blank if no env var.
    apiKey: MACARON_API_KEY || '',
  };
}

function makeDefaults(): Settings {
  return {
    activeProviderId: SYSTEM_PROVIDER_ID,
    // Ship one editable custom entry — users can fill it in, switch to it,
    // or delete it. Same UX as any other custom provider.
    customProviders: [seedMacaronProvider()],
    // WebUI defaults to fully unattended: every tool call auto-approves
    // without a permission prompt. Users who want the safer per-tool ask
    // flow can flip this in Settings, or cycle it per-session with
    // Shift+Tab / the permission chip.
    defaultPermissionMode: 'bypassPermissions',
    followupSuggestions: false,
  };
}

const PERMISSION_MODES: readonly DefaultPermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
] as const;
function normalizePermissionMode(v: unknown): DefaultPermissionMode {
  return typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v)
    ? (v as DefaultPermissionMode)
    : 'default';
}

function normalizeActiveId(id: string): string {
  // Old configs used 'anthropic' as the built-in id; unify on 'system'.
  return id === LEGACY_ANTHROPIC_ID ? SYSTEM_PROVIDER_ID : id;
}

// Old shape (0.x): { provider: 'anthropic'|'macaron', providers: { macaron: { apiKey } } }
// Detected by presence of `providers.macaron` at the top level; converted
// to the current shape by wrapping macaron as a custom provider.
function migrateIfLegacy(raw: unknown): Settings {
  const legacy = raw as {
    provider?: string;
    providers?: { macaron?: { apiKey?: string } };
    activeProviderId?: string;
    customProviders?: CustomProvider[];
    yoloMode?: boolean;
    defaultPermissionMode?: DefaultPermissionMode;
    followupSuggestions?: boolean;
  };
  // A legacy `yoloMode: true` collapses onto `defaultPermissionMode:
  // 'bypassPermissions'` so existing installs preserve their auto-approve
  // behaviour after the picker landed.
  const inferredDefault: DefaultPermissionMode = legacy?.defaultPermissionMode
    ? normalizePermissionMode(legacy.defaultPermissionMode)
    : legacy?.yoloMode
      ? 'bypassPermissions'
      : 'default';
  if (legacy && Array.isArray(legacy.customProviders)) {
    // Already current shape — just normalize the legacy 'anthropic' id.
    return {
      activeProviderId: normalizeActiveId(legacy.activeProviderId || SYSTEM_PROVIDER_ID),
      customProviders: legacy.customProviders.map(sanitizeProvider),
      defaultPermissionMode: inferredDefault,
      followupSuggestions: Boolean(legacy.followupSuggestions),
    };
  }
  // Legacy: rebuild
  const macaron: CustomProvider = {
    id: randomUUID(),
    name: DEFAULT_PROVIDER_NAME,
    endpoint: MACARON_API_BASE,
    model: MACARON_MODEL,
    apiKey: legacy?.providers?.macaron?.apiKey || MACARON_API_KEY || '',
  };
  const wasMacaronActive = legacy?.provider === 'macaron';
  return {
    activeProviderId: wasMacaronActive ? macaron.id : SYSTEM_PROVIDER_ID,
    customProviders: [macaron],
    defaultPermissionMode: inferredDefault,
    followupSuggestions: Boolean(legacy?.followupSuggestions),
  };
}

function sanitizeProvider(p: CustomProvider): CustomProvider {
  return {
    id: String(p.id || randomUUID()),
    name: String(p.name || '').trim() || 'Unnamed provider',
    endpoint: String(p.endpoint || '').trim(),
    model: String(p.model || '').trim(),
    apiKey: String(p.apiKey || ''),
  };
}

async function loadFromDisk(): Promise<Settings> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    return migrateIfLegacy(JSON.parse(raw));
  } catch {
    return makeDefaults();
  }
}

async function persist(): Promise<void> {
  if (!cache) return;
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

export async function readSettings(): Promise<Settings> {
  if (!cache) cache = await loadFromDisk();
  return cache;
}

export async function warmSettingsCache(): Promise<void> {
  await readSettings();
  // Capture launch override once at boot: a pasted ANTHROPIC_BASE_URL or an
  // ambient ANTHROPIC_MODEL (e.g. `mcc --model X`) forces System/pass-through
  // until the user explicitly selects a provider.
  launchOverride = Boolean(process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_MODEL);
  // Persist any migration/defaults on first boot so the file exists.
  await persist();
}

export async function readPublicSettings(): Promise<PublicSettings> {
  const s = await readSettings();
  const envBase = process.env.ANTHROPIC_BASE_URL || '';
  const usingRelay = Boolean(envBase);
  return {
    activeProviderId: effectiveActiveId(s),
    builtins: [
      {
        id: SYSTEM_PROVIDER_ID,
        name: 'System default',
        description: usingRelay
          ? "Passes through your shell's ANTHROPIC_BASE_URL — the SDK will hit your configured relay/gateway. We don't touch anything."
          : "Uses your Claude Code login untouched. We don't override any env vars.",
        detectedEndpoint: usingRelay ? envBase : null,
      },
    ],
    customProviders: s.customProviders.map((p) => ({
      id: p.id,
      name: p.name,
      endpoint: p.endpoint,
      model: p.model,
      configured: Boolean(p.apiKey),
    })),
    defaultPermissionMode: s.defaultPermissionMode,
    followupSuggestions: s.followupSuggestions,
  };
}

// ---------- CRUD --------------------------------------------------------

export async function addProvider(
  input: Omit<CustomProvider, 'id'>,
): Promise<CustomProvider> {
  const s = await readSettings();
  const created = sanitizeProvider({ ...input, id: randomUUID() });
  s.customProviders.push(created);
  await persist();
  return created;
}

export async function updateProvider(
  id: string,
  patch: Partial<Omit<CustomProvider, 'id'>>,
): Promise<CustomProvider | null> {
  const s = await readSettings();
  const idx = s.customProviders.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const cur = s.customProviders[idx]!;
  const next: CustomProvider = sanitizeProvider({
    id: cur.id,
    name: patch.name ?? cur.name,
    endpoint: patch.endpoint ?? cur.endpoint,
    model: patch.model ?? cur.model,
    // Blank apiKey means "keep existing" — matches the UI's "leave blank to
    // preserve" pattern. Callers who want to CLEAR the key should pass a
    // sentinel; not needed for now.
    apiKey: patch.apiKey && patch.apiKey.length > 0 ? patch.apiKey : cur.apiKey,
  });
  s.customProviders[idx] = next;
  await persist();
  return next;
}

export async function deleteProvider(id: string): Promise<boolean> {
  const s = await readSettings();
  const before = s.customProviders.length;
  s.customProviders = s.customProviders.filter((p) => p.id !== id);
  if (s.customProviders.length === before) return false;
  // If we just deleted the active provider, fall back to anthropic default.
  if (s.activeProviderId === id) s.activeProviderId = SYSTEM_PROVIDER_ID;
  await persist();
  return true;
}

export async function setActiveProvider(id: string): Promise<boolean> {
  const s = await readSettings();
  if (id !== SYSTEM_PROVIDER_ID && !s.customProviders.some((p) => p.id === id)) {
    return false;
  }
  // An explicit selection retires the boot launch override: the user is
  // choosing this provider's isolated credentials/config over the launch env.
  // Persist transactionally — a failed write must leave the cached provider
  // AND launchOverride untouched so UI and routing stay in agreement.
  const prevId = s.activeProviderId;
  const prevOverride = launchOverride;
  s.activeProviderId = id;
  launchOverride = false;
  try {
    await persist();
  } catch (e) {
    s.activeProviderId = prevId;
    launchOverride = prevOverride;
    throw e;
  }
  return true;
}

// One-liner bootstrap for users coming from a Macaron API relay's docs page:
// they paste a shell snippet that sets a few env vars and runs `/macaron`, and
// the WebUI opens with the relay's provider already selected — no manual
// Settings → Add provider dance.
//
// Reads (MACARON_* wins; ANTHROPIC_* is the fallback so the same snippet an
// operator ships for `claude` also works for `claude /macaron`):
//   MACARON_PROVIDER_ENDPOINT  | ANTHROPIC_BASE_URL             (required)
//   MACARON_PROVIDER_TOKEN     | ANTHROPIC_AUTH_TOKEN | ANTHROPIC_API_KEY  (required)
//   MACARON_PROVIDER_MODEL     | ANTHROPIC_MODEL                (default: macaron-v1-venti)
//   MACARON_PROVIDER_NAME                                       (default: derived from endpoint host)
//
// Escape hatch: set MACARON_DISABLE_ENV_PROVIDER_SEED=1 (or true/yes) to skip
// entirely — for users whose shell has ANTHROPIC_BASE_URL pointing at some
// unrelated relay they don't want Macaron to adopt.
//
// Semantics (all "A" per product call):
// - Overwrite in place: env is the source of truth; a re-run with different
//   creds refreshes the same provider row (matched by deterministic id).
// - Auto-activate only when the current active provider is still the built-in
//   `system` — never yanks a user who's manually picked another one.
// - Idempotent: same env → same provider id (sha1 of endpoint+model prefix),
//   so paste-and-run twice doesn't spawn dupes.
export async function seedProviderFromEnv(): Promise<
  { seeded: false; reason: 'disabled' | 'missing-env' } | { seeded: true; providerId: string; activated: boolean }
> {
  if (/^(1|true|yes)$/i.test(process.env.MACARON_DISABLE_ENV_PROVIDER_SEED || '')) {
    return { seeded: false, reason: 'disabled' };
  }
  const endpoint = (process.env.MACARON_PROVIDER_ENDPOINT || process.env.ANTHROPIC_BASE_URL || '').trim();
  const token = (process.env.MACARON_PROVIDER_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || '').trim();
  if (!endpoint || !token) return { seeded: false, reason: 'missing-env' };
  const model = (process.env.MACARON_PROVIDER_MODEL || process.env.ANTHROPIC_MODEL || 'macaron-v1-venti').trim();
  const name = (process.env.MACARON_PROVIDER_NAME || deriveProviderNameFromEndpoint(endpoint)).trim();

  // Deterministic id: endpoint+model → same shell snippet always upserts the
  // same row. Formatted UUID-shaped for consistency with existing random ids.
  const hash = createHash('sha1').update(`env:${endpoint}\n${model}`).digest('hex');
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;

  const s = await readSettings();
  const idx = s.customProviders.findIndex((p) => p.id === id);
  const next: CustomProvider = sanitizeProvider({ id, name, endpoint, model, apiKey: token });
  if (idx >= 0) s.customProviders[idx] = next;
  else s.customProviders.push(next);
  const activated = s.activeProviderId === SYSTEM_PROVIDER_ID;
  if (activated) s.activeProviderId = id;
  // A successful complete seed retires the boot launchOverride unconditionally.
  // The override exists to force System pass-through from ambient env when we
  // seed NOTHING; once a complete endpoint+token has been resolved into a real
  // provider row, effectiveActiveId() must stop shadowing to System. This holds
  // for both branches: when we activated the seeded row (route it), AND when a
  // manual provider was already active (main's "kept active choice" — route
  // THAT provider, not ambient pass-through). Override still governs the
  // seed-nothing launches: `--model`-only, or a base URL with no token.
  launchOverride = false;
  await persist();
  return { seeded: true, providerId: id, activated };
}

// "https://mint.macaron.im/v1" → "Mint (env)". Falls back to a generic
// "Provider (env)" for weird / empty hosts. The `(env)` suffix flags the row
// as env-seeded in the sidebar so a user glancing at Settings knows why it
// showed up without them touching Add provider.
function deriveProviderNameFromEndpoint(endpoint: string): string {
  try {
    const host = new URL(endpoint).hostname.replace(/\.$/, '');
    const label = host.split('.').filter((s) => s && s !== 'www')[0] || host;
    if (!label) return 'Provider (env)';
    return `${label[0]!.toUpperCase()}${label.slice(1)} (env)`;
  } catch {
    return 'Provider (env)';
  }
}

// ---------- Active provider → SDK env override -------------------------

// Isolated CLAUDE_CONFIG_DIR for subprocesses run against a custom provider.
// Claude Code CLI reads its OAuth session from ~/.claude/settings.json on
// startup, which would otherwise beat any ANTHROPIC_AUTH_TOKEN we set in
// the subprocess env. We give it a fresh empty dir so the subprocess falls
// through to env-based auth against the custom provider.
//
// Caveat: the CLI ALSO stores session jsonls under <config_dir>/projects/.
// If we let those write to the isolated dir, our WebUI (which reads from
// ~/.claude/projects/) never sees the new session. Fix: symlink
// <isolated>/projects → ~/.claude/projects so sessions land in the same
// place terminal `claude` uses. Terminal `claude` sessions and our
// subprocess sessions coexist in one project tree; only auth is isolated.
const ISOLATED_CONFIG_DIR = path.join(os.tmpdir(), 'macaron-plugin-isolated-claude');
let isolatedDirReady = false;
function ensureIsolatedDir(): string {
  if (!isolatedDirReady) {
    if (!existsSync(ISOLATED_CONFIG_DIR)) mkdirSync(ISOLATED_CONFIG_DIR, { recursive: true });
    // Symlink shared user data so custom-provider subprocesses keep auth isolated
    // without hiding sessions or user-scoped slash commands from the WebUI/CLI.
    for (const dir of ['projects', 'commands']) {
      const link = path.join(ISOLATED_CONFIG_DIR, dir);
      const real = path.join(HOME, '.claude', dir);
      if (!existsSync(real)) mkdirSync(real, { recursive: true });
      try {
        const st = lstatSync(link);
        if (!st.isSymbolicLink()) {
          rmSync(link, { recursive: true, force: true });
          symlinkSync(real, link);
        }
      } catch {
        try { symlinkSync(real, link); } catch { /* already there */ }
      }
    }
    isolatedDirReady = true;
  }
  return ISOLATED_CONFIG_DIR;
}

// Consumed synchronously by request handlers. Requires the cache to be
// warmed (warmSettingsCache() at startup handles that).
// Direct-call variant for server-side operations that need to hit the
// active provider's endpoint themselves (e.g. /compact — where we don't
// want to spawn the whole SDK subprocess just to summarize). Returns null
// when the active provider is `system`, since that path relies on the
// user's ambient Claude auth we don't have server-side.
export function getActiveProviderRaw():
  | { id: string; name: string; endpoint: string; model: string; apiKey: string }
  | null {
  const s = cache ?? makeDefaults();
  if (effectiveActiveId(s) === SYSTEM_PROVIDER_ID) return null;
  const p = s.customProviders.find((x) => x.id === s.activeProviderId);
  if (!p) return null;
  return { id: p.id, name: p.name, endpoint: p.endpoint, model: p.model, apiKey: p.apiKey };
}

// Sync getter for the global default permission mode. Cache is warmed at
// startup by warmSettingsCache(), so this never blocks on disk I/O.
export function getDefaultPermissionMode(): DefaultPermissionMode {
  return normalizePermissionMode((cache ?? makeDefaults()).defaultPermissionMode);
}

export async function setDefaultPermissionMode(
  mode: DefaultPermissionMode,
): Promise<void> {
  const s = await readSettings();
  s.defaultPermissionMode = normalizePermissionMode(mode);
  await persist();
}

export function getFollowupSuggestionsEnabled(): boolean {
  return (cache ?? makeDefaults()).followupSuggestions ?? false;
}

export async function setFollowupSuggestionsEnabled(enabled: boolean): Promise<void> {
  const s = await readSettings();
  s.followupSuggestions = Boolean(enabled);
  await persist();
}

export function getActiveProviderEnv(): {
  model: string | undefined;
  env: Record<string, string> | null;
} {
  const s = cache ?? makeDefaults();
  // Boot launch override (ANTHROPIC_BASE_URL or `--model`) collapses to
  // System/pass-through, matching the id readPublicSettings()/UI report — one
  // contract for both routing and display. A later explicit selection clears
  // it (see setActiveProvider). System also lands here.
  if (effectiveActiveId(s) === SYSTEM_PROVIDER_ID) {
    // Pass-through: inherit process.env unchanged (ANTHROPIC_BASE_URL /
    // ANTHROPIC_AUTH_TOKEN the user exported in their shell). Honor an
    // ambient ANTHROPIC_MODEL too so `mcc --model X` (which sets it) picks
    // the launch model, matching `claude --model X`. When no launch override
    // exists, make the user-scope settings.json model explicit instead of
    // letting the SDK silently choose its own (currently Opus) default.
    return { model: process.env.ANTHROPIC_MODEL || readClaudeSettingsModel(), env: null };
  }
  const p = s.customProviders.find((x) => x.id === s.activeProviderId);
  if (!p) return { model: undefined, env: null };
  const isolatedDir = ensureIsolatedDir();
  // Point the SDK subprocess at our local Anthropic-compatible relay rather
  // than at the provider directly. The relay stubs the /v1/ endpoints the
  // CLI probes at startup (models, org, telemetry), and forwards /v1/messages
  // after rewriting body.model to the provider's configured model id.
  const relayBase = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/relay/anthropic/${p.id}`;
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    // Isolate from user's OAuth session so env-based auth wins.
    CLAUDE_CONFIG_DIR: isolatedDir,
    // Clear any stale OAuth token that might be passed through.
    CLAUDE_CODE_OAUTH_TOKEN: '',
    // Point SDK subprocess at our local relay (see relay.ts).
    ANTHROPIC_BASE_URL: relayBase,
    // Relay uses the provider's key server-side; we still set the env
    // token so the SDK considers itself "authenticated" and skips OAuth.
    ANTHROPIC_AUTH_TOKEN: p.apiKey,
    ANTHROPIC_API_KEY: p.apiKey,
  };
  // A provider's explicit model remains authoritative for that endpoint. An
  // older/partially configured provider can still follow settings.json rather
  // than falling through to the SDK's built-in Opus default.
  const model = p.model || readClaudeSettingsModel();
  if (model) env.ANTHROPIC_MODEL = model;
  return { model: model || undefined, env };
}
