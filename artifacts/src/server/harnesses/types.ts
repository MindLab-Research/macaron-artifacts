import type { Approval, ChatChunk, HarnessId, HarnessInfo } from '../../shared/types.js';
import type { ProfileConfig, ProfileOptions } from '../../shared/profiles.js';

/** Server-only, captured once per turn and reused by its metadata fork. Never serialize this in a Session. */
export interface ResolvedProfile {
  config: ProfileConfig;
  apiKey?: string;
  authToken?: string;
  nativeProfile?: string;
  nativeConfig?: Record<string, unknown>;
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
}
export interface HarnessAdapter {
  id: HarnessId;
  info(): Promise<HarnessInfo>;
  profileOptions?(cwd: string, profile?: ResolvedProfile): Promise<ProfileOptions>;
  // Adapters emit content parts only; session orchestration owns start/finish and persistence.
  run(turn: HarnessTurn): AsyncIterable<ChatChunk>;
}
