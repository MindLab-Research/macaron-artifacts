import type { InferUIMessageChunk, UIMessage } from 'ai';

export type HarnessId = 'claude-code' | 'codex' | 'opencode' | 'pi' | 'hermes' | 'openclaw';
export interface HarnessInfo { id: HarnessId; name: string; available: boolean; detail?: string; capabilities: { textDeltas: boolean; reasoningDeltas: boolean; toolInputDeltas: boolean; commandOutputDeltas: boolean; approvals: boolean; fork: boolean } }
export interface Artifact { path: string; source: string; streaming: boolean; revision: number }
export interface Approval { id: string; tool: string; input: unknown }
export type MessageData = { artifact: Artifact; command: { toolCallId: string; output: string }; approval: Approval & { resolved?: boolean }; usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }; recap: { title?: string; suggestions: string[] } };
export type ChatMessage = UIMessage<{ interrupted?: boolean }, MessageData>;
export type ChatChunk = InferUIMessageChunk<ChatMessage>;
export interface Session { id: string; harness: HarnessId; cwd: string; title: string; model?: string; profileId?: string | null; nativeId?: string; messages: ChatMessage[]; suggestions: string[]; createdAt: number; updatedAt: number; status: 'idle' | 'running' | 'error'; error?: string }
export type SessionSummary = Omit<Session, 'messages'>;
