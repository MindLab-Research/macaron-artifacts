import type { Session, SessionSummary } from './types.js';
export function sessionActivity(session: Session, pending?: { questions: { size: number }; approvals: { size: number } }): NonNullable<SessionSummary['activity']> {
  if (session.status === 'error') return 'error';
  // Only live callbacks can be answered. Historical cards never create a waiting badge after restart.
  if (session.status === 'running') return pending?.questions.size ? 'answer' : pending?.approvals.size ? 'approval' : 'running';
  const last = session.messages.at(-1);
  return last?.role === 'assistant' && !last.metadata?.interrupted ? 'complete' : 'idle';
}
