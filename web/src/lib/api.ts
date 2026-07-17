// Re-export shared types so existing imports keep working unchanged.
export type {
  Workspace,
  SessionListItem,
  Block,
  Message,
  SessionDetail,
  MessageSearchHit,
  MessageSearchResponse,
  WorkspacesResponse,
  WorkspaceDetailResponse,
  HealthResponse,
  AnalyticsResponse,
  UsageBySession,
  PrContext,
  CreatePrRequest,
  CreatePrResult,
  FileSearchResponse,
  FileContentSearchResponse,
  SavedCommand,
  SavedCommandsResponse,
  DirEntry,
  DirListing,
  CreateShareResponse,
  SharedSessionResponse,
  TunnelProvider,
  TunnelState,
  WorktreeInfo,
  UsageResponse,
  RateLimitWindow,
  SearchHit,
  SearchResponse,
  HooksResponse,
  HookHandlerView,
  HookScope,
  SkillInfo,
  SkillDetail,
  Schedule,
  ScheduleInput,
  SessionKind,
  SlashCommand,
  AgentFile,
  SubagentInfo,
  GitStatus,
  GitFileStatus,
  GitBranches,
  ConfigFileId,
  ConfigFileFormat,
  ConfigFileMeta,
  ConfigFile,
  FileEntry,
  FileListResponse,
  FileReadResponse,
} from '@macaron/shared';

import type {
  WorkspacesResponse,
  WorkspaceDetailResponse,
  SessionDetail,
  MessageSearchResponse,
  HealthResponse,
  AnalyticsResponse,
  PrContext,
  CreatePrRequest,
  CreatePrResult,
  FileSearchResponse,
  FileContentSearchResponse,
  SavedCommand,
  SavedCommandsResponse,
  DirListing,
  CreateShareResponse,
  SharedSessionResponse,
  TunnelProvider,
  TunnelState,
  WorktreeInfo,
  UsageResponse,
  SearchResponse,
  HooksResponse,
  SkillInfo,
  SkillDetail,
  Schedule,
  ScheduleInput,
  SchedulesResponse,
  CommandsResponse,
  AgentsResponse,
  SubagentsResponse,
  GitStatus,
  GitBranches,
  ConfigFileId,
  ConfigFileMeta,
  ConfigFile,
  FileListResponse,
  FileReadResponse,
} from '@macaron/shared';
import { authedFetch } from './auth';

// Thrown by every non-2xx response. Carries the status so callers can branch on
// it (e.g. worktree discard's 409 → confirm-dirty prompt) instead of grepping
// the message string.
export class HttpError extends Error {
  constructor(readonly status: number, body: string) {
    let message = '';
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === 'string') message = parsed.error;
    } catch {
      /* non-JSON error body */
    }
    super(message || (body ? `http ${status}: ${body.slice(0, 200)}` : `http ${status}`));
    this.name = 'HttpError';
  }
}

export async function getJSON<T>(url: string): Promise<T> {
  const r = await authedFetch(url);
  if (!r.ok) throw new HttpError(r.status, await r.text().catch(() => ''));
  return r.json() as Promise<T>;
}

export type PublicBuiltinProvider = {
  id: 'system';
  name: string;
  description: string;
  detectedEndpoint: string | null;
};
export type PublicCustomProvider = {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  configured: boolean;
};
export type DefaultPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'bypassPermissions';

export type PublicSettings = {
  activeProviderId: string;
  builtins: PublicBuiltinProvider[];
  customProviders: PublicCustomProvider[];
  defaultPermissionMode: DefaultPermissionMode;
  followupSuggestions: boolean;
};

export type ProviderInput = {
  name: string;
  endpoint: string;
  model: string;
  apiKey?: string;
};

export type AgentInput = {
  name: string;
  description: string;
  tools: string[];
  model: string;
  prompt: string;
};

export type CommandInput = {
  description?: string;
  argumentHint?: string;
  body: string;
};
export type McpTransport = 'stdio' | 'http' | 'sse';
export type PublicMcpServer = {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  alwaysLoad?: boolean;
};
export type McpServerInput = {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
};

async function req<T>(url: string, init: RequestInit): Promise<T> {
  const r = await authedFetch(url, init);
  if (!r.ok) throw new HttpError(r.status, await r.text().catch(() => ''));
  return r.json() as Promise<T>;
}

export const api = {
  health: () => getJSON<HealthResponse>('/api/health'),
  analytics: (window: string) =>
    getJSON<AnalyticsResponse>(`/api/analytics?window=${encodeURIComponent(window)}`),
  settings: () => getJSON<PublicSettings>('/api/settings'),
  usage: () => getJSON<UsageResponse>('/api/usage'),

  addProvider: (input: ProviderInput) =>
    req<{ id: string; settings: PublicSettings }>('/api/settings/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  updateProvider: (id: string, patch: Partial<ProviderInput>) =>
    req<PublicSettings>(`/api/settings/providers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  deleteProvider: (id: string) =>
    req<PublicSettings>(`/api/settings/providers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  setActiveProvider: (providerId: string) =>
    req<PublicSettings>('/api/settings/active', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId }),
    }),
  setDefaultPermissionMode: (mode: DefaultPermissionMode) =>
    req<PublicSettings>('/api/settings/permission-mode', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    }),
  setFollowupSuggestions: (enabled: boolean) =>
    req<PublicSettings>('/api/settings/followups', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),
  skills: () => getJSON<{ skills: SkillInfo[] }>('/api/skills'),
  skill: (dir: string) => getJSON<SkillDetail>(`/api/skills/${encodeURIComponent(dir)}`),
  setSkillEnabled: (dir: string, enabled: boolean) =>
    req<{ skills: SkillInfo[] }>(`/api/skills/${encodeURIComponent(dir)}/enabled`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),
  createSkill: (input: { name: string; description: string; body?: string }) =>
    req<{ dir: string; skills: SkillInfo[] }>('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  savedCommands: () => getJSON<SavedCommandsResponse>('/api/commands'),
  createCommand: (name: string, input: CommandInput) =>
    req<SavedCommand>('/api/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ...input }),
    }),
  updateCommand: (name: string, input: CommandInput) =>
    req<SavedCommand>(`/api/commands/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  deleteCommand: (name: string) =>
    req<{ ok: true }>(`/api/commands/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
  mcpServers: () => getJSON<{ servers: PublicMcpServer[] }>('/api/mcp/servers'),
  addMcpServer: (input: McpServerInput) =>
    req<{ servers: PublicMcpServer[] }>('/api/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  updateMcpServer: (name: string, input: McpServerInput) =>
    req<{ servers: PublicMcpServer[] }>(`/api/mcp/servers/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  deleteMcpServer: (name: string) =>
    req<{ servers: PublicMcpServer[] }>(`/api/mcp/servers/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
  configFiles: () => getJSON<{ files: ConfigFileMeta[] }>('/api/config-files'),
  configFile: (id: ConfigFileId) => getJSON<ConfigFile>(`/api/config-files/${id}`),
  saveConfigFile: async (id: ConfigFileId, content: string): Promise<ConfigFile> => {
    const r = await authedFetch(`/api/config-files/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!r.ok) {
      // Surface the server's validation message (e.g. "Invalid JSON: …")
      // verbatim so the editor can show it inline.
      const body = (await r.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error || `http ${r.status}`);
    }
    return r.json() as Promise<ConfigFile>;
  },
  workspaces: () => getJSON<WorkspacesResponse>('/api/workspaces'),
  createProject: (input: { name?: string; gitUrl?: string; parent?: string }) =>
    req<{ project: string; cwd: string; name: string }>('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  defaultProjectParent: () => getJSON<{ path: string }>('/api/projects/default-parent'),
  searchMessages: (q: string, limit = 30) =>
    getJSON<MessageSearchResponse>(
      `/api/search/messages?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  listDirs: (path?: string) =>
    getJSON<DirListing>(`/api/fs/dirs?path=${encodeURIComponent(path ?? '')}`),
  workspace: (project: string) =>
    getJSON<WorkspaceDetailResponse>(`/api/workspaces/${encodeURIComponent(project)}`),
  // Read-only hooks view. Pass an encoded project to include that workspace's
  // project + local settings.json; omit it for user-scope hooks only.
  hooks: (project?: string) =>
    getJSON<HooksResponse>(
      project ? `/api/hooks?project=${encodeURIComponent(project)}` : '/api/hooks',
    ),
  searchFiles: (project: string, q: string, limit = 50) =>
    getJSON<FileSearchResponse>(
      `/api/workspaces/${encodeURIComponent(project)}/files?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  searchFileContent: (project: string, q: string, limit = 100) =>
    getJSON<FileContentSearchResponse>(
      `/api/workspaces/${encodeURIComponent(project)}/files/content?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  session: (project: string, sid: string) =>
    getJSON<SessionDetail>(
      `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}`,
    ),
  commands: (project: string) =>
    getJSON<CommandsResponse>(
      `/api/sessions/claude/${encodeURIComponent(project)}/commands`,
    ),
  deleteSession: async (project: string, sid: string): Promise<void> => {
    const r = await authedFetch(
      `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}`,
      { method: 'DELETE' },
    );
    if (!r.ok) throw new Error(`http ${r.status}`);
  },
  setSessionLabel: (project: string, sid: string, name: string) =>
    req<{ ok: true; label: string }>(
      `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}/label`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      },
    ),
  duplicateSession: (project: string, sid: string) =>
    req<{ ok: true; newSid: string }>(
      `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}/duplicate`,
      { method: 'POST' },
    ),
  permissionDecision: (
    id: string,
    decision: 'allow' | 'deny',
    opts?: { scope?: 'once' | 'session' | 'always'; reason?: string; mode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' },
  ) =>
    req<{ ok: boolean }>('/api/permission-decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, decision, scope: opts?.scope, reason: opts?.reason, mode: opts?.mode }),
    }),
  stopSession: (project: string, sid: string) =>
    req<{ ok: boolean; running: boolean }>(
      `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}/stop`,
      { method: 'POST' },
    ),
  rewindSession: (project: string, sid: string, uuid: string) =>
    req<{ ok: true; dropped: number; backupPath: string }>(
      `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}/rewind`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid }),
      },
    ),
  forkSession: (project: string, sid: string, uuid: string) =>
    req<{ ok: true; newSid: string; kept: number }>(
      `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}/fork`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid }),
      },
    ),
  compactSession: (project: string, sid: string) =>
    req<{ ok: true; summary: string; backupPath: string; kept: number }>(
      `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}/compact`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
    ),
  prContext: (project: string, sid: string) =>
    // Use `req` (not `getJSON`) so the server's descriptive error body
    // ("not a git repository", etc.) reaches the toast instead of a bare
    // `http 400`, matching the createPr path.
    req<PrContext>(
      `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}/pr-context`,
      { method: 'GET' },
    ),
  createPr: (project: string, sid: string, input: CreatePrRequest) =>
    req<CreatePrResult>(
      `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}/pr`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    ),
  createShare: (project: string, sid: string) =>
    req<CreateShareResponse>('/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, sid }),
    }),
  revokeShare: (project: string, sid: string) =>
    req<{ ok: boolean }>('/api/share/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, sid }),
    }),
  sharedSession: (token: string) =>
    getJSON<SharedSessionResponse>(`/api/public/share/${encodeURIComponent(token)}`),
  tunnelStatus: () => getJSON<TunnelState>('/api/tunnel/status'),
  startTunnel: (provider: TunnelProvider) =>
    req<TunnelState>('/api/tunnel/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    }),
  stopTunnel: () => req<TunnelState>('/api/tunnel/stop', { method: 'POST' }),
  search: (q: string, limit = 40) =>
    getJSON<SearchResponse>(
      `/api/search?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(String(limit))}`,
    ),
  gitStatus: (project: string) =>
    getJSON<GitStatus>(`/api/git/${encodeURIComponent(project)}/status`),
  gitDiff: (project: string, file: string, opts: { staged?: boolean; untracked?: boolean } = {}) => {
    const q = new URLSearchParams({ file });
    if (opts.staged) q.set('staged', '1');
    if (opts.untracked) q.set('untracked', '1');
    return getJSON<{ diff: string }>(`/api/git/${encodeURIComponent(project)}/diff?${q}`);
  },
  gitStage: (project: string, files: string[]) =>
    req<{ ok: true }>(`/api/git/${encodeURIComponent(project)}/stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
    }),
  gitUnstage: (project: string, files: string[]) =>
    req<{ ok: true }>(`/api/git/${encodeURIComponent(project)}/unstage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
    }),
  gitCommit: (project: string, message: string, all: boolean) =>
    req<{ ok: true; output: string }>(`/api/git/${encodeURIComponent(project)}/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, all }),
    }),
  gitBranches: (project: string) =>
    getJSON<GitBranches>(`/api/git/${encodeURIComponent(project)}/branches`),
  gitCheckout: (project: string, branch: string, create: boolean) =>
    req<{ ok: true; output: string }>(`/api/git/${encodeURIComponent(project)}/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch, create }),
    }),
  schedules: () => getJSON<SchedulesResponse>('/api/schedules'),
  createSchedule: (input: ScheduleInput) =>
    req<Schedule>('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  updateSchedule: (id: string, patch: Partial<ScheduleInput>) =>
    req<Schedule>(`/api/schedules/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  deleteSchedule: async (id: string): Promise<void> => {
    const r = await authedFetch(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`http ${r.status}`);
  },
  pauseSchedule: (id: string) =>
    req<Schedule>(`/api/schedules/${encodeURIComponent(id)}/pause`, { method: 'POST' }),
  resumeSchedule: (id: string) =>
    req<Schedule>(`/api/schedules/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
  runScheduleNow: (id: string) =>
    req<{ ok: true }>(`/api/schedules/${encodeURIComponent(id)}/run-now`, { method: 'POST' }),
  worktrees: () => getJSON<{ worktrees: WorktreeInfo[] }>('/api/worktrees'),
  mergeWorktree: (sid: string) =>
    req<{ ok: true; merged: true }>(`/api/worktrees/${encodeURIComponent(sid)}/merge`, { method: 'POST' }),
  discardWorktree: (sid: string, force = false) =>
    req<{ ok: true }>(`/api/worktrees/${encodeURIComponent(sid)}/discard${force ? '?force=1' : ''}`, { method: 'POST' }),

  // Custom subagents (~/.claude/agents/*.md). Mutations return the full list
  // so the caller replaces state in one shot, matching the provider CRUD.
  agents: () => getJSON<AgentsResponse>('/api/agents'),
  createAgent: (input: AgentInput) =>
    req<AgentsResponse>('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  updateAgent: (name: string, patch: Partial<Omit<AgentInput, 'name'>>) =>
    req<AgentsResponse>(`/api/agents/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  deleteAgent: (name: string) =>
    req<AgentsResponse>(`/api/agents/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  // Subagent child sessions spawned from a transcript.
  subagents: (project: string, sid: string) =>
    getJSON<SubagentsResponse>(
      `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}/subagents`,
    ),
  subagent: (project: string, sid: string, agentId: string) =>
    getJSON<SessionDetail>(
      `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}/subagents/${encodeURIComponent(agentId)}`,
    ),
  listFiles: (project: string, path = '') =>
    getJSON<FileListResponse>(
      `/api/files/${encodeURIComponent(project)}/list?path=${encodeURIComponent(path)}`,
    ),
  readFile: async (project: string, path: string): Promise<FileReadResponse> => {
    const r = await authedFetch(
      `/api/files/${encodeURIComponent(project)}/read?path=${encodeURIComponent(path)}`,
    );
    if (!r.ok) {
      // Surface the server's reason (e.g. "binary file", "file too large") so
      // the editor can show a helpful placeholder instead of "http 415".
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || `http ${r.status}`);
    }
    return r.json() as Promise<FileReadResponse>;
  },
  writeFile: (project: string, path: string, content: string) =>
    req<{ ok: true; bytes: number }>(`/api/files/${encodeURIComponent(project)}/write`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    }),
};

export function basename(p: string): string {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

// Single source of truth for a session row's display name, shared by the
// sidebar, dashboard, workspace tiles and command palette so every surface
// agrees. Priority: user/native title (`label` for a manual rename, `title` for
// the native ai-title/custom-title the server resolved) > first-prompt preview >
// short sid. Both Claude and Codex populate `title`, so this is provider-neutral.
export function sessionTitle(s: { label?: string; title?: string; preview?: string; sessionId: string }): string {
  return s.label || s.title || s.preview || s.sessionId.slice(0, 8);
}

// Trigger a client-side download of `text` as a file named `name`. Used by the
// session Markdown export — no server round-trip since the WebUI already holds
// the parsed transcript.
export function downloadTextFile(name: string, text: string, mime = 'text/markdown'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function fmtAgo(ms: number): string {
  if (!ms) return '—';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}
