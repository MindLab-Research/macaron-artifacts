// Persistent Kimi-runner config, held in ~/.kimi-code/macaron-kimi-config.json
// (honors $KIMI_CODE_HOME).
//
// Data model mirrors the Codex side: a `system` built-in that passes through
// to the user's ambient Kimi Code login (OAuth "system" provider — no env
// overrides), plus an arbitrary list of custom providers synthesized at spawn
// time via the KIMI_MODEL_* env family (KIMI_MODEL_NAME / _API_KEY /
// _BASE_URL / _PROVIDER_TYPE) so the user's own ~/.kimi-code/config.toml is
// never rewritten. One is active.
//
// Cache is warmed at startup so getKimiConfig() is synchronous for the
// runner's hot path.

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { KIMI_HOME } from '../config.js';

export const KIMI_SYSTEM_PROVIDER_ID = 'system';

export type KimiProviderType = 'kimi' | 'anthropic' | 'openai';

/** Provider-level config — auth + which endpoint to hit. */
export type KimiCustomProvider = {
  id: string;
  /** Human-facing name for the WebUI's ProviderPicker. */
  name: string;
  /** Model id sent to the endpoint (KIMI_MODEL_NAME — also the enable switch). */
  model: string;
  /** Endpoint root (KIMI_MODEL_BASE_URL). */
  baseUrl: string;
  /** Bearer token for the endpoint (KIMI_MODEL_API_KEY). */
  apiKey: string;
  /** Wire protocol the endpoint speaks (KIMI_MODEL_PROVIDER_TYPE). */
  providerType: KimiProviderType;
};

export type KimiSettings = {
  activeProviderId: string;
  customProviders: KimiCustomProvider[];
};

const CONFIG_PATH = path.join(KIMI_HOME, 'macaron-kimi-config.json');

function seededCustomProvider(): KimiCustomProvider {
  return {
    id: randomUUID(),
    name: 'Custom provider',
    model: process.env.MACARON_KIMI_MODEL || '',
    baseUrl: process.env.MACARON_KIMI_API_BASE || '',
    apiKey: process.env.MACARON_KIMI_API_KEY || '',
    providerType: 'anthropic',
  };
}

function defaults(): KimiSettings {
  return {
    // Default = system so a fresh install works with the user's existing
    // kimi CLI login without them touching Settings.
    activeProviderId: KIMI_SYSTEM_PROVIDER_ID,
    customProviders: [seededCustomProvider()],
  };
}

function sanitize(p: KimiCustomProvider): KimiCustomProvider {
  const providerType: KimiProviderType = p.providerType === 'anthropic' || p.providerType === 'openai' ? p.providerType : 'kimi';
  return {
    id: String(p.id || randomUUID()),
    name: String(p.name || 'Unnamed provider').trim(),
    model: String(p.model || '').trim(),
    baseUrl: String(p.baseUrl || '').trim(),
    apiKey: String(p.apiKey || ''),
    providerType,
  };
}

let cache: KimiSettings | null = null;

async function loadFromDisk(): Promise<KimiSettings> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<KimiSettings>;
    if (parsed && Array.isArray(parsed.customProviders)) {
      return {
        activeProviderId: parsed.activeProviderId || KIMI_SYSTEM_PROVIDER_ID,
        customProviders: parsed.customProviders.map(sanitize),
      };
    }
    return defaults();
  } catch {
    return defaults();
  }
}

async function persist(): Promise<void> {
  if (!cache) return;
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

export async function warmKimiConfigCache(): Promise<void> {
  cache = await loadFromDisk();
  await persist();
}

export function getKimiConfig(): KimiSettings {
  return cache ?? defaults();
}

/** Active provider or null when the built-in `system` is selected. */
export function getActiveKimiProvider(): KimiCustomProvider | null {
  const s = cache ?? defaults();
  if (s.activeProviderId === KIMI_SYSTEM_PROVIDER_ID) return null;
  return s.customProviders.find((p) => p.id === s.activeProviderId) ?? null;
}

// Env for a spawned kimi process. A custom provider maps onto the
// KIMI_MODEL_* family (KIMI_MODEL_NAME doubles as the enable switch); the
// `system` builtin means ambient OAuth login, so no overrides at all.
export function getActiveKimiProviderEnv(): Record<string, string> {
  const p = getActiveKimiProvider();
  if (!p || !p.model) return {};
  const env: Record<string, string> = {
    KIMI_MODEL_NAME: p.model,
    KIMI_MODEL_PROVIDER_TYPE: p.providerType,
  };
  if (p.baseUrl) env.KIMI_MODEL_BASE_URL = p.baseUrl;
  if (p.apiKey) env.KIMI_MODEL_API_KEY = p.apiKey;
  return env;
}

export async function setActiveKimiProvider(id: string): Promise<KimiSettings> {
  if (!cache) cache = await loadFromDisk();
  const isSystem = id === KIMI_SYSTEM_PROVIDER_ID;
  const known = isSystem || cache.customProviders.some((p) => p.id === id);
  if (!known) throw new Error(`unknown providerId: ${id}`);
  cache.activeProviderId = id;
  await persist();
  return cache;
}

export async function createKimiProvider(
  patch: Partial<KimiCustomProvider>,
): Promise<KimiCustomProvider> {
  if (!cache) cache = await loadFromDisk();
  const seed = seededCustomProvider();
  const created = sanitize({ ...seed, ...patch, id: randomUUID() });
  cache.customProviders.push(created);
  await persist();
  return created;
}

export async function updateKimiProvider(
  id: string,
  patch: Partial<KimiCustomProvider>,
): Promise<KimiCustomProvider> {
  if (!cache) cache = await loadFromDisk();
  const idx = cache.customProviders.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error(`unknown providerId: ${id}`);
  const next = sanitize({ ...cache.customProviders[idx]!, ...patch, id });
  cache.customProviders[idx] = next;
  await persist();
  return next;
}

export async function deleteKimiProvider(id: string): Promise<KimiSettings> {
  if (!cache) cache = await loadFromDisk();
  cache.customProviders = cache.customProviders.filter((p) => p.id !== id);
  if (cache.activeProviderId === id) cache.activeProviderId = KIMI_SYSTEM_PROVIDER_ID;
  await persist();
  return cache;
}

// Public projection for the WebUI. Never surfaces raw apiKey.
export type PublicKimiProvider = Omit<KimiCustomProvider, 'apiKey'> & {
  configured: boolean;
};

export type PublicKimiBuiltin = {
  id: 'system';
  name: string;
  description: string;
  /** Best-effort sniff of ~/.kimi-code/config.toml so the UI can show what
   * "system default" points at. null = file missing/unparseable. */
  detectedModel: string | null;
};

export type PublicKimiSettings = {
  activeProviderId: string;
  builtins: PublicKimiBuiltin[];
  customProviders: PublicKimiProvider[];
};

async function detectSystemKimi(): Promise<{ model: string | null }> {
  try {
    const raw = await fs.readFile(path.join(KIMI_HOME, 'config.toml'), 'utf8');
    // Cheap TOML sniff — we only want the default model for the info banner,
    // so a full TOML parser is overkill.
    const model = /^\s*default_model\s*=\s*"([^"]+)"/m.exec(raw)?.[1] ?? null;
    return { model };
  } catch {
    return { model: null };
  }
}

export async function readPublicKimiSettings(): Promise<PublicKimiSettings> {
  const s = cache ?? defaults();
  const sniff = await detectSystemKimi();
  return {
    activeProviderId: s.activeProviderId,
    builtins: [
      {
        id: KIMI_SYSTEM_PROVIDER_ID,
        name: 'System default',
        description: sniff.model
          ? `Uses your ambient Kimi Code login unchanged — default model ${sniff.model}.`
          : 'Uses your ambient Kimi Code login as-is (or kimi’s built-in defaults if none).',
        detectedModel: sniff.model,
      },
    ],
    customProviders: s.customProviders.map((p) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { apiKey: _apiKey, ...rest } = p;
      return { ...rest, configured: Boolean(p.apiKey) };
    }),
  };
}
