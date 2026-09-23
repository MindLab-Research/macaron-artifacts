import type { InferUIMessageChunk, UIMessage } from 'ai';
import type { PromptReference } from './prompt-references.js';
import type { QuestionState } from './questions.js';

export type RuntimeSource = 'bundled-sdk' | 'native-cli' | 'gateway' | 'script';
export interface HarnessInfo { id: HarnessId; name: string; available: boolean; detail?: string; source?: RuntimeSource; capabilities: { textDeltas: boolean; reasoningDeltas: boolean; toolInputDeltas: boolean; commandOutputDeltas: boolean; approvals: boolean; fork: boolean } }
export type HarnessId = 'claude-code' | 'codex' | 'opencode' | 'opencode-v2' | 'pi' | 'hermes' | 'openclaw';
// Import graphs follow disk snapshots, independently of each streamed source revision.
export interface Artifact { path: string; source: string; streaming: boolean; revision: number; importsRevision?: number }
export interface Approval { id: string; tool: string; input: unknown }
export type ConnectionTargetKind = 'connector' | 'mcp';
export type ConnectionTargetAction = 'authorize' | 'connect' | 'enable' | 'install' | 'reconnect';
export type ConnectionTargetState = 'pending' | 'initiated' | 'connected' | 'skipped' | 'failed' | 'expired' | 'not_connected';
export type ConnectionSettleReason = 'all_resolved' | 'continue' | 'deadline' | 'interrupt';

export interface ConnectionTargetEnvField {
  name: string;
  required: boolean;
  secret: boolean;
  default: string;
  /** Browser-safe indication; secret default values remain in the adapter. */
  hasDefault?: boolean;
  prompt?: string;
}

export interface ConnectionTarget {
  name: string;
  kind: ConnectionTargetKind;
  action: ConnectionTargetAction;
  state: ConnectionTargetState;
  detail?: string;
  instructions?: string;
  discovery_error?: string;
  connect_url?: string;
  connection_id?: string;
  attempt?: string;
  required_env?: ConnectionTargetEnvField[];
  tools?: string[];
  hint?: string;
}

export interface ConnectionRequest {
  op_id: string;
  seq: number;
  deadline_at: number;
  timeout_seconds: number;
  targets: ConnectionTarget[];
  tool_call_id?: string;
}

export interface ConnectionState extends ConnectionRequest {
  settled?: boolean;
  settled_at?: number;
  settled_by?: ConnectionSettleReason;
}

/** The whole browser vocabulary for a connection operation: answer it, or ask the backend where it stands. */
export type ConnectionCommand =
  | { action: 'status' }
  | { action: 'check' }
  | { action: 'respond'; targets: Array<{ name: string; status: 'approved' | 'skipped'; env?: Record<string, string> }>; settled_by?: 'continue' };

/** What the browser sees. The native op_id never addresses an operation; `id` is minted per turn. */
export interface ConnectionView extends ConnectionState {
  id: string;
  /** Server-owned. False once the operation settled, expired, was stopped, or only survives as history. */
  actionable: boolean;
}

export interface ProviderReview { id: string; runId: string; sessionId: string; canContinue: boolean; scope?: string; explanation?: string; continuationMessage?: string; controlUrl?: string }
export type MessageData = { providerReview: ProviderReview; artifact: Artifact; command: { toolCallId: string; output: string }; approval: Approval & { resolved?: boolean }; question: QuestionState; connection: ConnectionView; usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }; recap: { title?: string; suggestions: string[] } };
export type ChatMessage = UIMessage<{ interrupted?: boolean; references?: PromptReference[]; referenceContext?: string }, MessageData>;
export type ChatChunk = InferUIMessageChunk<ChatMessage>;
export interface Session { id: string; harness: HarnessId; cwd: string; title: string; model?: string; profileId?: string | null; nativeId?: string; messages: ChatMessage[]; suggestions: string[]; createdAt: number; updatedAt: number; status: 'idle' | 'running' | 'error'; error?: string; providerReview?: ProviderReview }
export type SessionSummary = Omit<Session, 'messages'>;
