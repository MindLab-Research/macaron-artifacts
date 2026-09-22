import type { Approval, ChatChunk, ConnectionState, HarnessId, HarnessInfo } from '../../shared/types.js';
import type { ProfileConfig, ProfileOptions } from '../../shared/profiles.js';
import type { QuestionRequest, QuestionResponse } from '../../shared/questions.js';

/** Server-only, captured once per turn and reused by its metadata fork. Never serialize this in a Session. */
export interface ResolvedProfile {
  config: ProfileConfig;
  apiKey?: string;
  authToken?: string;
  nativeProfile?: string;
  nativeConfig?: Record<string, unknown>;
}

export interface ConnectionResponse {
  targets: Array<{ name: string; status: 'approved' | 'skipped'; detail?: string; env?: Record<string, string> }>;
  settled_by?: 'continue';
}

/**
 * The narrow set of native operations a connection card may trigger. The adapter binds its own RPC,
 * native session and profile for the whole turn, so a browser never names a transport, owner or method.
 */
export interface ConnectionControls {
  status(): Promise<ConnectionState | undefined>;
  wake(): Promise<void>;
  respond(response: ConnectionResponse): Promise<void>;
}

export interface HarnessTurn {
  nativeId?: string;
  cwd: string;
  prompt: string;
  messageId?: string;
  /** Resume the failed native turn without adding another user message. */
  retry?: boolean;
  model?: string;
  profile?: ResolvedProfile;
  instructions: string;
  signal: AbortSignal;
  // Enrichment branches retain the exact bootstrap and native history. Only the final user instruction changes.
  enrichment?: boolean;
  onNativeSession: (id: string) => void;
  approve: (request: Approval) => Promise<boolean>;
  ask: (request: Omit<QuestionRequest, 'id'>, signal?: AbortSignal) => Promise<QuestionResponse>;
  /**
   * Optional: only harnesses with a native connection protocol publish an operation. Adapters without
   * one, and their tests, need no stub. The adapter mints one opaque id per operation and turn.
   */
  connection?: (id: string, state: ConnectionState, controls: ConnectionControls, actionable: boolean) => void;
}
export interface HarnessAdapter {
  id: HarnessId;
  info(): Promise<HarnessInfo>;
  profileOptions?(cwd: string, profile?: ResolvedProfile): Promise<ProfileOptions>;
  // Adapters emit content parts only; session orchestration owns start/finish and persistence.
  run(turn: HarnessTurn): AsyncIterable<ChatChunk>;
}
