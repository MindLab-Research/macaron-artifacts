// Kimi WebUI ↔ server API. Namespaced under /api/kimi/*.

import type {
  SessionListItem,
  SessionDetail,
  Workspace,
} from '@macaron/shared';
import { authedFetch } from '../lib/auth';

export type KimiThread = SessionListItem;
export type KimiWorkspace = Workspace;

export type KimiProviderType = 'kimi' | 'anthropic' | 'openai';

export type PublicKimiProvider = {
  id: string;
  name: string;
  model: string;
  baseUrl: string;
  providerType: KimiProviderType;
  configured: boolean;
};

export type PublicKimiBuiltin = {
  id: 'system';
  name: string;
  description: string;
  detectedModel: string | null;
};

export type PublicKimiSettings = {
  activeProviderId: string;
  builtins: PublicKimiBuiltin[];
  customProviders: PublicKimiProvider[];
};

async function getJSON<T>(url: string): Promise<T> {
  const r = await authedFetch(url);
  if (!r.ok) throw new Error(`http ${r.status}`);
  return r.json() as Promise<T>;
}

async function reqJSON<T>(url: string, init: RequestInit): Promise<T> {
  const r = await authedFetch(url, init);
  if (!r.ok) throw new Error(`http ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json() as Promise<T>;
}

export const kimiApi = {
  threads: () => getJSON<{ threads: KimiThread[] }>('/api/kimi/threads'),
  workspaces: () => getJSON<{ workspaces: KimiWorkspace[] }>('/api/kimi/workspaces'),
  workspace: (project: string) =>
    getJSON<{ workspace: KimiWorkspace; sessions: KimiThread[] }>(
      `/api/kimi/workspaces/${encodeURIComponent(project)}`,
    ),
  thread: (sid: string) => getJSON<SessionDetail>(`/api/kimi/threads/${encodeURIComponent(sid)}`),
  deleteThread: async (sid: string): Promise<void> => {
    const r = await authedFetch(`/api/kimi/threads/${encodeURIComponent(sid)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`http ${r.status}`);
  },
  stopThread: (sid: string) =>
    reqJSON<{ ok: boolean; running: boolean }>(
      `/api/kimi/threads/${encodeURIComponent(sid)}/stop`,
      { method: 'POST' },
    ),
  config: () => getJSON<PublicKimiSettings>('/api/kimi/config'),
  setActive: (providerId: string) =>
    reqJSON<PublicKimiSettings>('/api/kimi/config/active', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId }),
    }),
  createProvider: (patch: Partial<PublicKimiProvider> & { apiKey?: string }) =>
    reqJSON<{ id: string; settings: PublicKimiSettings }>('/api/kimi/config/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  updateProvider: (id: string, patch: Partial<PublicKimiProvider> & { apiKey?: string }) =>
    reqJSON<PublicKimiSettings>(`/api/kimi/config/providers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  deleteProvider: async (id: string): Promise<PublicKimiSettings> => {
    const r = await authedFetch(`/api/kimi/config/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`http ${r.status}`);
    return r.json();
  },
  engine: () => getJSON<{ engine: 'claude' | 'codex' | 'kimi' }>('/api/engine'),
};
