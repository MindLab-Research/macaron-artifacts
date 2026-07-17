// Persisted plugin settings, held in ~/.claude/macaron-config.json.
//
// Data model: the user manages an arbitrary list of Anthropic-compatible
// providers (Macaron, OpenRouter, LiteLLM, self-hosted, …) and picks one
// as active. The special built-in "anthropic" provider always exists,
// uses the user's ambient Claude Code login, and can't be edited/deleted.
//
// Cache is warmed at startup so getActiveProviderEnv() is synchronous —
// hot-path request handlers can call it without awaiting disk I/O.

import { promises as fs, mkdirSync, existsSync, symlinkSync, lstatSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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

let cache: Settings | null = null;

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
  // Persist any migration/defaults on first boot so the file exists.
  await persist();
}

export async function readPublicSettings(): Promise<PublicSettings> {
  const s = await readSettings();
  const envBase = process.env.ANTHROPIC_BASE_URL || '';
  const usingRelay = Boolean(envBase);
  return {
    activeProviderId: s.activeProviderId,
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
  s.activeProviderId = id;
  await persist();
  return true;
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
  if (s.activeProviderId === SYSTEM_PROVIDER_ID) return null;
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
  if (s.activeProviderId === SYSTEM_PROVIDER_ID) {
    return { model: undefined, env: null };
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
  if (p.model) env.ANTHROPIC_MODEL = p.model;
  return { model: p.model || undefined, env };
}
