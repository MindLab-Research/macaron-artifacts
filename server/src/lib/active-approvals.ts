// In-memory registry of the approval responder for each in-flight app-server
// turn, keyed by sessionId. The /approval route looks up the handler and calls
// it with the user's decision; the runner replies on the parked JSON-RPC
// request. Mirrors active-runs.ts (the abort registry) but for the codex
// app-server approval channel.

import type { CodexDecision } from '@macaron/shared';

// Returns true if the approval id was live and answered, false if it was
// already resolved / unknown (client raced with the server clearing it).
export type ApprovalHandler = (approvalId: string, decision: CodexDecision) => boolean;

const handlers = new Map<string, ApprovalHandler>();

export function registerApprovalHandler(sid: string, handler: ApprovalHandler): void {
  handlers.set(sid, handler);
}

export function clearApprovalHandler(sid: string): void {
  handlers.delete(sid);
}

export function respondCodexApproval(sid: string, approvalId: string, decision: CodexDecision): boolean {
  const handler = handlers.get(sid);
  if (!handler) return false;
  return handler(approvalId, decision);
}
