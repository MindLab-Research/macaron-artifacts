// SSE protocol shared by the Fastify server (publisher) and the React client
// (consumer). All events flowing through /api/workspaces/.../sessions (POST),
// /api/sessions/.../message (POST) and /api/sessions/.../live (GET) match one
// of these shapes.

// Codex plan step lifecycle, mirroring the app-server's TurnPlanStepStatus.
export type CodexPlanStatus = 'pending' | 'inProgress' | 'completed';

// Which native approval surface a request belongs to.
export type CodexApprovalKind = 'command' | 'file' | 'network';

// The decision the user picks, matching the app-server's approval decision
// enums (command supports the first four; file supports accept/acceptForSession
// /decline/cancel). Amendment-carrying variants are answered as plain `accept`
// for now — the destructured amendment payloads aren't surfaced in the UI yet.
export type CodexDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export type SessionStreamEvent =
  | { type: 'meta'; cwd: string; sessionId: string; startedAt?: number }
  | { type: 'starting'; cwd: string }
  | { type: 'user-text'; text: string; images?: Array<{ mimeType: string; dataUrl: string }> }
  | { type: 'delta'; text: string }
  // Reasoning/thinking stream, distinct from assistant `delta` so the client
  // can style/collapse it as its own block rather than inline prose.
  | { type: 'reasoning'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_input_delta'; id: string; name: string; partial_json: string; accumulated: string }
  | { type: 'tool_input_done'; id: string; name: string; final_json: string }
  | { type: 'tool_result'; tool_use_id: string; text: string; isError: boolean }
  | { type: 'permission_request'; id: string; toolName: string; input: unknown; suggestion?: { label: string } }
  | { type: 'permission_resolved'; id: string; decision: 'allow' | 'deny' }
  // Codex-native plan surface (turn/plan/updated). One card per thread, updated
  // monotonically — the client replaces its plan with the newest `steps`.
  | { type: 'codex_plan'; steps: Array<{ step: string; status: CodexPlanStatus }>; explanation?: string | null }
  // Codex-native approval request (command / file / network). The client shows
  // a decision card and POSTs the chosen `decision` back to
  // /api/codex/threads/:sid/approval. `available` lists the decisions codex
  // offered for this specific request. Cleared by codex_approval_resolved.
  | { type: 'codex_approval_request'; id: string; kind: CodexApprovalKind; command?: string; cwd?: string; reason?: string | null; fileChanges?: Array<{ path: string; kind: string; diff?: string }>; grantRoot?: string | null; network?: { host: string; protocol: string; port?: number }; available: CodexDecision[] }
  // The request is no longer actionable (answered, turn ended, or server
  // cleared it via serverRequest/resolved). The client disables the card.
  | { type: 'codex_approval_resolved'; id: string; decision?: CodexDecision | 'stale' }
  | { type: 'usage'; outputTokens: number; thinkingTokens?: number }
  | { type: 'event'; event: string; subtype: string | null }
  | { type: 'log'; text: string }
  | { type: 'warn'; text: string }
  | { type: 'error'; error: string }
  | { type: 'done'; exitCode: number; error?: string }
  | { type: 'followup_delta'; text: string }
  | { type: 'live-end'; reason?: string };

// System-wide event stream (GET /api/events). The server watches the claude,
// codex and kimi transcript trees and pushes a debounced nudge whenever a
// transcript file changes on disk — including sessions started outside the
// WebUI in a terminal. Clients refetch their workspace list on receipt, so
// external sessions surface live instead of on the next slow poll.
export type SystemEvent = { type: 'sessions-changed'; engine: 'claude' | 'codex' | 'kimi' };
// PTY terminal protocol, streamed over /api/terminal/.../stream (SSE).
// `history` is the FULL scrollback snapshot (client applies reset+write, so
// replay on (re)connect is idempotent); `output` is an incremental chunk.
// Client→server input/resize go over sibling POST routes, not this stream.
export type TerminalStreamEvent =
  | { type: 'history'; data: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number }
  | { type: 'error'; error: string };
