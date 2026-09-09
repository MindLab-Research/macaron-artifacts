import type { HarnessId } from './types';

/** Only explicit overrides are stored. An absent field inherits the harness's native configuration. */
export interface ProfileConfig {
  model?: string;
  subagentModel?: string;
  effort?: string;
  subagentEffort?: string;
  provider?: string;
  baseUrl?: string;
  authMode?: 'inherit' | 'api-key' | 'auth-token';
  forceSubagentModel?: boolean;
  modelAliases?: Partial<Record<'opus' | 'sonnet' | 'haiku' | 'fable', string>>;
  fineGrainedToolStreaming?: boolean;
  agent?: string;
  variant?: string;
  agentModels?: Record<string, string>;
  features?: Record<string, boolean>;
}
export interface HarnessProfile {
  id: string;
  harness: HarnessId;
  name: string;
  source: 'app' | 'codex';
  config: ProfileConfig;
  revision: string;
  credentials: { apiKey: boolean; authToken: boolean };
  /** A native file write was interrupted; confirm configuration and re-enter private credentials before reuse. */
  pending?: boolean;
  error?: string;
}
export interface ProfileInput {
  harness: HarnessId;
  name: string;
  config: ProfileConfig;
  revision?: string;
  /** Omitted means keep; null means remove. Stored values are never sent back to the browser. */
  credentials?: { apiKey?: string | null; authToken?: string | null };
}
export interface ProfileOptions {
  models: { id: string; name: string; provider?: string; efforts?: string[] }[];
  efforts: string[];
  agents?: { id: string; name: string; subagent: boolean }[];
  features?: { id: string; name: string; description?: string; stage?: string; enabled: boolean; defaultEnabled?: boolean; locked?: boolean }[];
  error?: string;
}
