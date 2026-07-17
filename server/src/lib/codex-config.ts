// Persistent Codex-runner config, held in ~/.claude/macaron-codex-config.json.
//
// Data model mirrors the Claude side: a `system` built-in that passes through
// to the user's ~/.codex/config.toml unchanged, plus an arbitrary list of
// custom providers (OpenAI-compatible, self-hosted, …). One is
// active. Fallback flow when the active custom provider goes 503 is to switch
// to system default in Settings and keep working.
//
// Cache is warmed at startup so getCodexConfig() is synchronous for the
// runner's hot path.

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { HOME } from '../config.js';
import type {
  ApprovalMode,
  ModelReasoningEffort,
  SandboxMode,
} from '@openai/codex-sdk';

export const CODEX_SYSTEM_PROVIDER_ID = 'system';

/** Provider-level config — auth + which endpoint to hit. */
export type CodexCustomProvider = {
  id: string;
  /** Human-facing name for the WebUI's ProviderPicker. */
  name: string;
  /** Anthropic-style OpenAI-compatible endpoint (`.../v1` or root). */
  baseUrl: string;
  /** Bearer token for the endpoint. */
  apiKey: string;
  /** Model id sent to the endpoint. */
  model: string;
  /** `wire_api` — `responses` for GPT-5-family / `chat` for legacy. */
  wireApi: 'responses' | 'chat';
  /** Provider name recorded in ~/.codex/sessions rollouts. */
  modelProvider: string;
  /** Reasoning effort — passed to ThreadOptions and mirrored as config. */
  reasoningEffort: ModelReasoningEffort;
  /** Model context window — passed through to codex CLI config. */
  contextWindow: number;
  /** Auto-compact trigger — passed through to codex CLI config. */
  autoCompactTokenLimit: number;
  /** Disable OpenAI-style response storage. */
  disableResponseStorage: boolean;
  /** Enable Codex's web_search tool. */
  webSearchEnabled: boolean;
};

/** Runtime knobs applied REGARDLESS of which provider is active — sandbox
 * / approval need to work even for the pass-through `system` provider,
 * where we can't (and shouldn't) rewrite the user's ~/.codex/config.toml. */
export type CodexRuntimeOptions = {
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalMode;
};

/** Per-turn override for a single thread — each field falls back to the
 * global runtime / active-provider default when omitted, so two concurrent
 * sessions can run at different effort / sandbox without touching Settings. */
export type CodexRuntimeOverride = {
  reasoningEffort?: ModelReasoningEffort;
  sandboxMode?: SandboxMode;
  approvalPolicy?: ApprovalMode;
  webSearchEnabled?: boolean;
};

export type CodexSettings = {
  activeProviderId: string;
  customProviders: CodexCustomProvider[];
  runtime: CodexRuntimeOptions;
};

const CONFIG_PATH = path.join(HOME, '.claude', 'macaron-codex-config.json');

function seededCustomProvider(): CodexCustomProvider {
  return {
    id: randomUUID(),
    name: 'Custom provider',
    baseUrl: process.env.MACARON_CODEX_API_BASE || '',
    apiKey: process.env.MACARON_CODEX_API_KEY || '',
    model: process.env.MACARON_CODEX_MODEL || '',
    wireApi: 'responses',
    modelProvider: 'OpenAI',
    reasoningEffort: 'high',
    contextWindow: 200_000,
    autoCompactTokenLimit: 180_000,
    disableResponseStorage: true,
    webSearchEnabled: false,
  };
}

function defaults(): CodexSettings {
  return {
    // Default = system so a fresh install works with the user's existing
    // codex CLI setup without them touching Settings.
    activeProviderId: CODEX_SYSTEM_PROVIDER_ID,
    customProviders: [seededCustomProvider()],
    runtime: { sandboxMode: 'workspace-write', approvalPolicy: 'never' },
  };
}

// Legacy shape (0.6.x): `{ provider: {...single provider fields...} }`.
// Wrap it as a single-entry customProviders[] and default to system.
function migrateIfLegacy(raw: unknown): CodexSettings {
  const r = raw as {
    activeProviderId?: string;
    customProviders?: CodexCustomProvider[];
    runtime?: CodexRuntimeOptions;
    provider?: Partial<CodexCustomProvider> & {
      sandboxMode?: SandboxMode;
      approvalPolicy?: ApprovalMode;
    };
  };
  if (r && Array.isArray(r.customProviders)) {
    const d = defaults();
    return {
      activeProviderId: r.activeProviderId || CODEX_SYSTEM_PROVIDER_ID,
      customProviders: r.customProviders.map(sanitize),
      runtime: { ...d.runtime, ...(r.runtime || {}) },
    };
  }
  // Legacy single-provider shape → wrap.
  const legacy = r?.provider;
  if (!legacy) return defaults();
  const migrated: CodexCustomProvider = sanitize({
    id: randomUUID(),
    name: String(legacy.name || 'Legacy provider'),
    baseUrl: String(legacy.baseUrl || ''),
    apiKey: String(legacy.apiKey || ''),
    model: String(legacy.model || ''),
    wireApi: (legacy.wireApi === 'chat' ? 'chat' : 'responses'),
    modelProvider: String(legacy.modelProvider || 'OpenAI'),
    reasoningEffort: legacy.reasoningEffort || 'high',
    contextWindow: Number(legacy.contextWindow || 200_000),
    autoCompactTokenLimit: Number(legacy.autoCompactTokenLimit || 180_000),
    disableResponseStorage: legacy.disableResponseStorage !== false,
    webSearchEnabled: Boolean(legacy.webSearchEnabled),
  });
  return {
    // If the legacy config had a non-empty apiKey, the user had it wired up —
    // preserve intent by keeping it active. Otherwise default to system.
    activeProviderId: legacy.apiKey ? migrated.id : CODEX_SYSTEM_PROVIDER_ID,
    customProviders: [migrated],
    runtime: {
      sandboxMode: legacy.sandboxMode || 'workspace-write',
      approvalPolicy: legacy.approvalPolicy || 'never',
    },
  };
}

function sanitize(p: CodexCustomProvider): CodexCustomProvider {
  return {
    id: String(p.id || randomUUID()),
    name: String(p.name || 'Unnamed provider').trim(),
    baseUrl: String(p.baseUrl || '').trim(),
    apiKey: String(p.apiKey || ''),
    model: String(p.model || '').trim(),
    wireApi: p.wireApi === 'chat' ? 'chat' : 'responses',
    modelProvider: String(p.modelProvider || 'OpenAI').trim(),
    reasoningEffort: (p.reasoningEffort || 'high') as ModelReasoningEffort,
    contextWindow: Number(p.contextWindow) > 0 ? Number(p.contextWindow) : 200_000,
    autoCompactTokenLimit: Number(p.autoCompactTokenLimit) > 0 ? Number(p.autoCompactTokenLimit) : 180_000,
    disableResponseStorage: p.disableResponseStorage !== false,
    webSearchEnabled: Boolean(p.webSearchEnabled),
  };
}

let cache: CodexSettings | null = null;

async function loadFromDisk(): Promise<CodexSettings> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    return migrateIfLegacy(JSON.parse(raw));
  } catch {
    return defaults();
  }
}

async function persist(): Promise<void> {
  if (!cache) return;
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

export async function warmCodexConfigCache(): Promise<void> {
  cache = await loadFromDisk();
  await persist();
}

export function getCodexConfig(): CodexSettings {
  return cache ?? defaults();
}

/** Active provider or null when the built-in `system` is selected. */
export function getActiveCodexProvider(): CodexCustomProvider | null {
  const s = cache ?? defaults();
  if (s.activeProviderId === CODEX_SYSTEM_PROVIDER_ID) return null;
  return s.customProviders.find((p) => p.id === s.activeProviderId) ?? null;
}

export async function setActiveCodexProvider(id: string): Promise<CodexSettings> {
  if (!cache) cache = await loadFromDisk();
  const isSystem = id === CODEX_SYSTEM_PROVIDER_ID;
  const known = isSystem || cache.customProviders.some((p) => p.id === id);
  if (!known) throw new Error(`unknown providerId: ${id}`);
  cache.activeProviderId = id;
  await persist();
  return cache;
}

export async function createCodexProvider(
  patch: Partial<CodexCustomProvider>,
): Promise<CodexCustomProvider> {
  if (!cache) cache = await loadFromDisk();
  const seed = seededCustomProvider();
  const created = sanitize({ ...seed, ...patch, id: randomUUID() });
  cache.customProviders.push(created);
  await persist();
  return created;
}

export async function updateCodexProvider(
  id: string,
  patch: Partial<CodexCustomProvider>,
): Promise<CodexCustomProvider> {
  if (!cache) cache = await loadFromDisk();
  const idx = cache.customProviders.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error(`unknown providerId: ${id}`);
  const next = sanitize({ ...cache.customProviders[idx]!, ...patch, id });
  cache.customProviders[idx] = next;
  await persist();
  return next;
}

export async function deleteCodexProvider(id: string): Promise<CodexSettings> {
  if (!cache) cache = await loadFromDisk();
  cache.customProviders = cache.customProviders.filter((p) => p.id !== id);
  if (cache.activeProviderId === id) cache.activeProviderId = CODEX_SYSTEM_PROVIDER_ID;
  await persist();
  return cache;
}

export async function updateCodexRuntime(
  patch: Partial<CodexRuntimeOptions>,
): Promise<CodexRuntimeOptions> {
  if (!cache) cache = await loadFromDisk();
  cache.runtime = { ...cache.runtime, ...patch };
  await persist();
  return cache.runtime;
}

// Public projection for the WebUI. Never surfaces raw apiKey.
export type PublicCodexProvider = Omit<CodexCustomProvider, 'apiKey'> & {
  configured: boolean;
};

export type PublicCodexBuiltin = {
  id: 'system';
  name: string;
  description: string;
  /** Best-effort sniff of ~/.codex/config.toml so the UI can show what
   * "system default" points at. null = file missing/unparseable. */
  detectedEndpoint: string | null;
  detectedModel: string | null;
};

export type PublicCodexSettings = {
  activeProviderId: string;
  builtins: PublicCodexBuiltin[];
  customProviders: PublicCodexProvider[];
  runtime: CodexRuntimeOptions;
};

async function detectSystemCodex(): Promise<{
  endpoint: string | null;
  model: string | null;
}> {
  try {
    const raw = await fs.readFile(path.join(HOME, '.codex', 'config.toml'), 'utf8');
    // Cheap TOML sniff — we only want two values for the info banner, so a
    // full TOML parser is overkill. Grabs `base_url = "…"` under
    // `[model_providers.<pick>]` and top-level `model = "…"`.
    const model = /^\s*model\s*=\s*"([^"]+)"/m.exec(raw)?.[1] ?? null;
    const endpoint = /^\s*base_url\s*=\s*"([^"]+)"/m.exec(raw)?.[1] ?? null;
    return { endpoint, model };
  } catch {
    return { endpoint: null, model: null };
  }
}

export async function readPublicCodexSettings(): Promise<PublicCodexSettings> {
  const s = cache ?? defaults();
  const sniff = await detectSystemCodex();
  const usingUpstream = Boolean(sniff.endpoint);
  return {
    activeProviderId: s.activeProviderId,
    builtins: [
      {
        id: CODEX_SYSTEM_PROVIDER_ID,
        name: 'System default',
        description: usingUpstream
          ? `Uses your ~/.codex/config.toml unchanged — hits ${sniff.endpoint}.`
          : 'Uses your ~/.codex/config.toml as-is (or Codex’s built-in defaults if none).',
        detectedEndpoint: sniff.endpoint,
        detectedModel: sniff.model,
      },
    ],
    customProviders: s.customProviders.map((p) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { apiKey: _apiKey, ...rest } = p;
      return { ...rest, configured: Boolean(p.apiKey) };
    }),
    runtime: { ...s.runtime },
  };
}
