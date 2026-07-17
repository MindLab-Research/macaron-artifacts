// Domain types shared by both the Fastify server and the Vite/React webui.

export type Workspace = {
  cwd: string;
  project: string;
  name: string;
  sessionCount: number;
  lastActivity: number;
  lastSessionId: string;
  lastPreview: string;
};

// Which agent engine produced this session. `claude` = claude-agent-sdk
// jsonl under ~/.claude/projects. `codex` = @openai/codex-sdk rollout files
// under ~/.codex/sessions. `kimi` = Kimi Code wire.jsonl + state.json under
// ~/.kimi-code/sessions. All are grouped by cwd into the same Workspace
// list; the tile UI dispatches to the appropriate backend route based on
// this discriminator.
export type SessionKind = 'claude' | 'codex' | 'kimi';

export type SessionListItem = {
  kind: SessionKind;
  project: string;
  cwd: string;
  gitBranch?: string;
  sessionId: string;
  preview: string;
  // User-assigned human label, stored in a macaron sidecar (not in the
  // Claude-owned jsonl). Takes display precedence over `preview` when set.
  label?: string;
  // Native/generated human-readable title. Claude reads ai-title/custom-title
  // records; Codex uses its persisted generated title; Kimi reads state.json.
  // The UI prefers it over `preview` when present.
  title?: string;
  messageCount: number;
  messageCountSuffix?: string;
  mtime: number;
  size?: number;
  resumeCommand: string;
};

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId?: string; text: string; isError?: boolean }
  // Base64-encoded image attached to a user message. Preserved in jsonl by
  // the CLI; the WebUI renders it inline where it appears in the block order,
  // so pastes/attachments interleaved with text stay in position.
  | { kind: 'image'; mimeType: string; data: string }
  // Emitted by the server when it recognises a CLI-generated meta entry such
  // as a `summary` line (post-`/compact` recap) or a "Continue from…" resume
  // marker. Rendered as a dim `※` line by the WebUI, matching CLI.
  | { kind: 'system_event'; eventType: 'summary' | 'compact' | 'resume' | 'meta'; text: string };

export type Message = {
  role: 'user' | 'assistant' | 'system';
  blocks: Block[];
  model?: string;
  timestamp?: string;
  uuid?: string;
};

// Token usage snapshot taken from the last assistant message's `usage`
// field in the jsonl. Cache tokens count toward the context window too, so
// the WebUI sums them for its Context bar.
export type UsageSnapshot = {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  model?: string;
};

// Estimated split of the used context window by source. macaron only sees
// the aggregate `usage` number from the jsonl (not Anthropic's SDK-internal
// per-category counts), so we measure the visible transcript and treat the
// fixed prompt overhead as the residual: system = total − everything measured.
// `total` stays the exact usage sum, so only the internal split is an estimate.
export type ContextBreakdown = {
  system: number; // system prompt + tool defs + MCP + CLAUDE.md (residual, not itemizable)
  messages: number; // user + assistant text
  toolCalls: number; // tool_use inputs
  toolResults: number; // tool_result content (file reads, command output)
  thinking: number; // extended-thinking blocks
  total: number; // matches the Context bar's usage sum
};

export type SessionDetail = {
  kind: SessionKind;
  sessionId: string;
  project: string;
  cwd: string;
  gitBranch?: string;
  // Legacy Macaron sidecar label, retained only so older renamed sessions
  // display consistently until their next native rename migrates them.
  label?: string;
  // Native session title (custom-title / ai-title / lastPrompt / summary)
  // resolved server-side, so the session header can show the same name the
  // sidebar does. Undefined when the session has none.
  title?: string;
  messages: Message[];
  truncated?: boolean;
  totalBytes?: number;
  latestUsage?: UsageSnapshot;
  contextBreakdown?: ContextBreakdown;
  // Environment counters for the status bar. Both are best-effort: MCPs
  // read from ~/.claude/settings.json; CLAUDE.md walks known locations.
  claudeMdCount?: number;
  mcpCount?: number;
};

// Cost & usage analytics. Rolled up from the same `message.usage` fields
// session-store already reads, priced by the server's model rate table.
// Token counts are summed across every assistant message in the window;
// costUsd is the sum of per-message cost (input/output/cache-write/cache-read
// each at their own rate). `known` on a per-model row is false when the model
// string didn't match the rate table and a default estimate was used.
export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  messageCount: number;
  sessionCount: number;
};
export type UsageDaily = { date: string } & Omit<UsageTotals, 'sessionCount'>;
export type UsageByModel = { model: string; known: boolean } & Omit<UsageTotals, 'sessionCount'>;
export type UsageBySession = {
  project: string;
  sessionId: string;
  preview: string;
  model: string;
  lastActivity: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  messageCount: number;
};
export type AnalyticsResponse = {
  window: string;
  since: number;
  until: number;
  // Calendar-day bounds (YYYY-MM-DD) in the *server's* local timezone, matching
  // the keys in `daily`. The web grid must build its date range from these
  // strings rather than re-deriving days from `since`/`until` in the browser's
  // timezone — otherwise a UTC server + LA browser disagree on the day boundary
  // and whole days go missing from the heatmap.
  sinceDate: string;
  untilDate: string;
  totals: UsageTotals;
  daily: UsageDaily[];
  byModel: UsageByModel[];
  bySession: UsageBySession[];
};

// A saved prompt / custom slash command — one `.md` file under
// ~/.claude/commands/. `name` is the filename stem (invoked as `/name`);
// `description` and `argumentHint` come from the YAML frontmatter; `body` is
// the prompt template (may reference $ARGUMENTS / $1 / $2 …). Project-scoped
// commands (.claude/commands/) are deferred to a follow-up.
export type SavedCommand = {
  name: string;
  description: string;
  argumentHint: string;
  body: string;
  mtime: number;
};

// A transcript-search match — one message whose text contains the query.
// The palette deep-links into the session via project+sessionId, and uses
// `uuid` to scroll to the exact message when the session view is mounted.
export type MessageSearchHit = {
  project: string;
  sessionId: string;
  uuid?: string;
  role: 'user' | 'assistant';
  snippet: string;
  preview: string;
  mtime: number;
};
// Git/PR state for the current session's cwd, used to prefill and gate the
// "Create PR" action. `ahead` = commits on `branch` not on `defaultBranch`;
// `null` means the base ref couldn't be resolved (e.g. a single-branch or
// shallow clone where neither `origin/<default>` nor local `<default>` is
// present) - distinct from a genuine `0`. `existingPrUrl` is set when a PR
// already exists for this branch.
export type PrContext = {
  branch: string;
  defaultBranch: string;
  ahead: number | null;
  dirty: boolean;
  hasRemote: boolean;
  existingPrUrl?: string;
};
export type CreatePrRequest = { title: string; body: string; draft: boolean };
// `created` is false when we short-circuited to an already-open PR.
export type CreatePrResult = { url: string; created: boolean };
export type DirEntry = { name: string; path: string };
export type DirListing = { path: string; parent: string | null; home: string; entries: DirEntry[] };
// Web Push. `subscription` is the browser PushSubscription.toJSON() shape sent
// to /api/push/subscribe and stored server-side; `notify` is the JSON payload
// the server ships to the SW's `push` handler (see web/public/sw.js).
export type PushSubscriptionPayload = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};
export type PushNotifyPayload = {
  title: string;
  body?: string;
  tag?: string;
  requireInteraction?: boolean;
  // Hash-route the SW opens/focuses on click, e.g. `#/w/:project/s/:sid`.
  url?: string;
};

// A per-session git worktree: the session's agent runs with cwd pointing at
// `worktreePath` (a dedicated branch off `baseBranch`), so parallel sessions
// in one repo never stomp each other's uncommitted changes. `exists` reflects
// whether the worktree dir is still on disk (users can delete it manually);
// `dirty` is set from `git status --porcelain` when the tree is present.
export type WorktreeInfo = {
  sessionId: string;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  status: 'active' | 'merged' | 'discarded';
  exists: boolean;
  dirty?: boolean;
};

// Rate-limit / usage state for the active Claude subscription, read from the
// ambient OAuth login (~/.claude/.credentials.json) via the oauth/usage
// endpoint. `utilization` is 0-100; `resetsAt` is an ISO timestamp (null when
// the window is empty). Only the 5-hour and weekly windows are surfaced — the
// two the always-visible meters need.
export type RateLimitWindow = { utilization: number; resetsAt: string | null };

// `available` is false when there's no ambient OAuth login to read (e.g. the
// user runs on a custom provider), so the client can hide the widget without
// treating it as an error.
export type UsageResponse = {
  available: boolean;
  fiveHour: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
};

// A Claude Code skill discovered under ~/.claude/skills/<name>/SKILL.md.
// `name`/`description` come from the SKILL.md YAML frontmatter; `enabled`
// reflects the skillOverrides entry in ~/.claude/settings.json (a skill with
// no override is enabled by default). `source` marks whether the dir is a
// symlink (managed elsewhere) so the UI can warn before editing/deleting.
export type SkillInfo = {
  // Directory name — the identifier used for skillOverrides + the /skill-name command.
  dir: string;
  name: string;
  description: string;
  allowedTools?: string;
  enabled: boolean;
  source: 'dir' | 'symlink';
};

export type SkillsResponse = { skills: SkillInfo[] };
// Full SKILL.md body for the detail/editor pane.
export type SkillDetail = SkillInfo & { body: string; path: string };

// A saved cron/one-time prompt. The scheduler fires it by spawning a fresh
// session (runClaude/runCodex, no resume) at `nextRunAt`, exactly as the
// "+ New Session" POST does — just with no client attached.
export type Schedule = {
  id: string;
  name: string;
  prompt: string;
  engine: SessionKind;
  cwd: string;
  // 5-field cron string (recurring) OR an ISO-8601 local datetime (one-time).
  // croner parses both; `oneShot` only records which input mode the user chose
  // (for the UI badge + create-time validation) — after a one-shot fires,
  // its nextRun() is naturally null, so the same fire path ends it.
  pattern: string;
  oneShot: boolean;
  status: 'active' | 'paused' | 'done';
  nextRunAt: number | null; // unix ms; null when paused/done or unschedulable
  lastRunAt: number | null;
  lastStatus: 'ok' | 'error' | null;
  lastSessionId: string | null; // sid of the most recent fired session
  createdAt: number;
  updatedAt: number;
};

export type ScheduleInput = {
  name: string;
  prompt: string;
  engine: SessionKind;
  cwd: string;
  pattern: string;
  oneShot: boolean;
};

// A slash command surfaced in the composer palette. `name` is the bare
// command (no leading slash). `builtin` = a CLI command worth listing;
// `project`/`user` come from `.claude/commands/**/*.md` (cwd / $HOME). A
// subdirectory becomes `namespace` for display only — it does NOT change the
// command name the SDK expands.
export type SlashCommand = {
  name: string;
  description?: string;
  argumentHint?: string;
  source: 'builtin' | 'project' | 'user';
  namespace?: string;
};

// ---- Git panel ------------------------------------------------------------
// Per-file entry from `git status --porcelain=v1`. `x`/`y` are the raw
// index/worktree status codes (M, A, D, R, ?, …). A file can be both staged
// and unstaged at once (edited after `git add`), so the two flags are
// independent, not mutually exclusive.
export type GitFileStatus = {
  path: string;
  x: string;
  y: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  renamedFrom?: string;
};

export type GitStatus = {
  isRepo: boolean;
  branch: string;
  detached: boolean;
  hasCommits: boolean;
  ahead: number;
  behind: number;
  upstream?: string;
  files: GitFileStatus[];
};

export type GitBranches = { current: string; branches: string[] };

// ---- File explorer -------------------------------------------------------
// A single entry in a directory listing. `path` is relative to the project
// cwd (root = ''), so the web tree can request children without knowing the
// absolute path (the server re-resolves + confines it).
export type FileEntry = {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  mtime?: number;
};

export type FileListResponse = { root: string; path: string; entries: FileEntry[] };
export type FileReadResponse = { path: string; content: string; size: number };

export type WorkspacesResponse = { workspaces: Workspace[] };
export type SavedCommandsResponse = { commands: SavedCommand[] };
export type MessageSearchResponse = { hits: MessageSearchHit[] };
export type WorkspaceDetailResponse = { workspace: Workspace; sessions: SessionListItem[] };
// Result of the composer's @-mention file search: repo-relative POSIX paths
// under the workspace cwd, matched by substring on the needle.
export type FileSearchResponse = { cwd: string; results: string[] };
export type FileContentHit = { path: string; matches: { line: number; text: string }[] };
export type FileContentSearchResponse = { cwd: string; results: FileContentHit[] };
export type SchedulesResponse = { schedules: Schedule[] };
export type HealthResponse = {
  ok: boolean;
  model: string;
  // Present only when the SQLite search index is enabled; null when disabled
  // via MACARON_SEARCH=0. Lets the UI show index size / gate the search entry.
  search?: { files: number; messages: number; lastSyncAt: number } | null;
};
export type AuthStatusResponse = { required: boolean };

// Share links: a session is published behind an unguessable token. The token
// is the capability — possession grants read access, no login. The token URL
// never leaks the on-disk project/sid, but resolving it returns the full
// SessionDetail (sid, project, absolute cwd) to whoever holds the link.
export type CreateShareResponse = { token: string };
export type SharedSessionResponse = { sessionId: string; createdAt: number; detail: SessionDetail };

// One full-text search hit — a single matched message inside a session. The
// snippet wraps matched terms in U+0002/U+0003 control chars (SEARCH_HL_OPEN /
// SEARCH_HL_CLOSE) so the client can highlight by splitting on them, never by
// interpreting message text as markup.
export type SearchHit = {
  project: string;
  sessionId: string;
  cwd: string;
  role: string;
  uuid: string;
  ts: string;
  snippet: string;
};

export type SearchResponse = {
  enabled: boolean;
  query: string;
  hits: SearchHit[];
};

// Delimiters the server uses to mark matched terms inside a SearchHit.snippet.
export const SEARCH_HL_OPEN = '';
export const SEARCH_HL_CLOSE = '';

export type ConfigResponse = {
  macaron: { base: string; model: string; configured: boolean };
};

// Zero-config remote access. The server can start one tunnel at a time via an
// installed CLI (`cloudflared` or `ngrok`) that exposes the local port on a
// public URL, which the Settings page surfaces as a link + QR code.
export type TunnelProvider = 'cloudflared' | 'ngrok';
export type TunnelStatus = 'stopped' | 'starting' | 'running' | 'error';
export type TunnelState = {
  status: TunnelStatus;
  provider: TunnelProvider | null;
  url: string | null;
  startedAt: number | null;
  error: string | null;
  // The access token the tunnel armed, so the UI can build a ?token= share link
  // that unlocks on first load. null when auth was already configured out-of-band
  // (env token) — the operator shares that secret themselves.
  token: string | null;
};

// A custom subagent definition (~/.claude/agents/<name>.md). `prompt` is the
// markdown body after the frontmatter — it becomes the agent's system prompt.
// `tools` is the frontmatter allowlist; empty = inherit all tools.
export type AgentFile = {
  name: string;
  description: string;
  tools: string[];
  model: string;
  prompt: string;
  // Frontmatter keys the UI doesn't model (e.g. permissionMode), preserved
  // verbatim across an edit so a UI save never silently drops them.
  extra?: Record<string, string>;
};

export type AgentsResponse = { agents: AgentFile[] };

// One subagent (child session) spawned from a parent transcript. The parent's
// assistant `tool_use` block whose `name === 'Agent'` carries the same
// `toolUseId`; the child's own transcript lives in a sibling
// `<sid>/subagents/agent-<agentId>.jsonl` file.
export type SubagentInfo = {
  agentId: string;
  agentType: string;
  description: string;
  toolUseId: string;
};

export type SubagentsResponse = { subagents: SubagentInfo[] };

// ---- Hooks viewer ------------------------------------------------------
// Read-only projection of the `hooks` block in a settings.json, flattened
// from Claude Code's three-level nesting (event → matcher group → handlers)
// into one row per handler so the WebUI can render a plain table. See
// https://code.claude.com/docs/en/hooks for the source schema.

// Which settings.json a hook came from. Scope decides precedence and lets
// the UI tag each row with where to edit it.
export type HookScope = 'user' | 'project' | 'local';

export type HookHandlerView = {
  // Event that triggers the hook, e.g. 'PreToolUse', 'PostToolUse', 'Stop'.
  event: string;
  // Matcher that narrows when it fires (tool name / glob). '' or '*' means
  // "every occurrence of the event".
  matcher: string;
  scope: HookScope;
  // Absolute path of the settings.json this handler was read from.
  source: string;
  // Handler kind: 'command' | 'http' | 'prompt' | 'agent' | future kinds.
  type: string;
  // The command line (command hooks), URL (http hooks), or a short label for
  // other kinds — whatever best identifies what runs.
  run: string;
  // Optional `if` sub-command filter that gates a single handler.
  condition?: string;
};

export type HooksResponse = {
  handlers: HookHandlerView[];
  // Which scopes were actually found on disk, so the UI can explain an empty
  // result ("no project settings.json") instead of just showing nothing.
  sources: Array<{ scope: HookScope; path: string; present: boolean; error?: string }>;
};

// Browser-editable Claude Code config files (user scope, under ~/.claude).
// `settings` is JSON (schema-guarded on write); `memory` is the free-form
// CLAUDE.md markdown. `format` tells the editor which validation to apply.
export type ConfigFileId = 'user-settings' | 'user-memory';
export type ConfigFileFormat = 'json' | 'markdown';

export type ConfigFileMeta = {
  id: ConfigFileId;
  label: string;
  path: string;
  format: ConfigFileFormat;
  exists: boolean;
};

// Full content of one file. `content` is '' when the file doesn't exist yet —
// saving then creates it.
export type ConfigFile = ConfigFileMeta & { content: string };

export type ConfigFilesResponse = { files: ConfigFileMeta[] };
export type CommandsResponse = { commands: SlashCommand[] };
