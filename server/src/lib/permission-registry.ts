// Pending permission decisions keyed by request id. When the SDK's
// canUseTool callback fires, the runner records a resolver here and yields
// a `permission_request` event. The client posts back to
// `/permission-decision`, which invokes the resolver so canUseTool returns
// and the SDK proceeds.

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';

export type PermissionDecision =
  // `mode` (allow only) switches the session's permission mode as the tool is
  // approved — used by the plan-approval panel to exit plan mode into
  // acceptEdits ("auto-accept") or default ("manually approve each edit").
  // scope on an `allow`: 'once' (default) runs the tool this one time; 'session'
  // remembers it for the rest of this server session; 'always' persists it for
  // this project cwd. The runner's canUseTool acts on scope after resolving.
  | { decision: 'allow'; mode?: PermissionMode; scope?: 'once' | 'session' | 'always' }
  | { decision: 'deny'; reason?: string };

const pending = new Map<string, (d: PermissionDecision) => void>();

export function registerPending(id: string, resolve: (d: PermissionDecision) => void): void {
  pending.set(id, resolve);
}

export function resolvePending(id: string, decision: PermissionDecision): boolean {
  const r = pending.get(id);
  if (!r) return false;
  r(decision);
  pending.delete(id);
  return true;
}

export function forgetPending(id: string): void {
  pending.delete(id);
}
