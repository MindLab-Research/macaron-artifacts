// Codex WebUI ↔ server API. Namespaced under /api/codex/*.

import type {
  SessionListItem,
  SessionDetail,
  Workspace,
  CodexDecision,
} from '@macaron/shared';
import { authedFetch } from '../lib/auth';

export type CodexThread = SessionListItem;
export type CodexWorkspace = Workspace;

export type CodexReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexApprovalPolicy = 'never' | 'on-request' | 'on-failure' | 'untrusted';

export type PublicCodexProvider = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  wireApi: 'responses' | 'chat';
  modelProvider: string;
  reasoningEffort: CodexReasoningEffort;
  webSearchEnabled: boolean;
  contextWindow: number;
  autoCompactTokenLimit: number;
  disableResponseStorage: boolean;
  configured: boolean;
};

export type PublicCodexBuiltin = {
  id: 'system';
  name: string;
  description: string;
  detectedEndpoint: string | null;
  detectedModel: string | null;
};

export type CodexRuntimeOptions = {
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
};

// Per-turn override sent alongside a new/resumed thread. Every field is
// optional — omitted ones fall back to the global config on the server.
export type CodexRuntimeOverride = {
  reasoningEffort?: CodexReasoningEffort;
  sandboxMode?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  webSearchEnabled?: boolean;
};

export type PublicCodexSettings = {
  activeProviderId: string;
  builtins: PublicCodexBuiltin[];
  customProviders: PublicCodexProvider[];
  runtime: CodexRuntimeOptions;
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

export const codexApi = {
  threads: () => getJSON<{ threads: CodexThread[] }>('/api/codex/threads'),
  workspaces: () => getJSON<{ workspaces: CodexWorkspace[] }>('/api/codex/workspaces'),
  workspace: (project: string) =>
    getJSON<{ workspace: CodexWorkspace; sessions: CodexThread[] }>(
      `/api/codex/workspaces/${encodeURIComponent(project)}`,
    ),
  thread: (sid: string) => getJSON<SessionDetail>(`/api/codex/threads/${encodeURIComponent(sid)}`),
  deleteThread: async (sid: string): Promise<void> => {
    const r = await authedFetch(`/api/codex/threads/${encodeURIComponent(sid)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`http ${r.status}`);
  },
  // Rename a thread. Blank name clears the override so the sidebar falls
  // back to the ai-title / first-user-prompt preview. Backed by the
  // engine-agnostic label sidecar so both Claude and Codex share the same
  // user-visible name for a given sid.
  setThreadLabel: (sid: string, name: string) =>
    reqJSON<{ ok: boolean; label: string }>(
      `/api/codex/threads/${encodeURIComponent(sid)}/label`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      },
    ),
  stopThread: (sid: string) =>
    reqJSON<{ ok: boolean; running: boolean }>(
      `/api/codex/threads/${encodeURIComponent(sid)}/stop`,
      { method: 'POST' },
    ),
  approve: (sid: string, id: string, decision: CodexDecision) =>
    reqJSON<{ ok: boolean }>(`/api/codex/threads/${encodeURIComponent(sid)}/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, decision }),
    }),
  config: () => getJSON<PublicCodexSettings>('/api/codex/config'),
  setActive: (providerId: string) =>
    reqJSON<PublicCodexSettings>('/api/codex/config/active', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId }),
    }),
  setRuntime: (patch: Partial<CodexRuntimeOptions>) =>
    reqJSON<PublicCodexSettings>('/api/codex/config/runtime', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  createProvider: (patch: Partial<PublicCodexProvider> & { apiKey?: string }) =>
    reqJSON<{ id: string; settings: PublicCodexSettings }>('/api/codex/config/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  updateProvider: (id: string, patch: Partial<PublicCodexProvider> & { apiKey?: string }) =>
    reqJSON<PublicCodexSettings>(`/api/codex/config/providers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  deleteProvider: async (id: string): Promise<PublicCodexSettings> => {
    const r = await authedFetch(`/api/codex/config/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`http ${r.status}`);
    return r.json();
  },
  engine: () => getJSON<{ engine: 'claude' | 'codex' }>('/api/engine'),
};
