import { expect, test } from 'bun:test';
import type { Session } from './types';
import { sessionActivity } from './session-activity';
const session: Session = { id: 'test', harness: 'codex', cwd: '/', title: '', messages: [], suggestions: [], createdAt: 0, updatedAt: 0, status: 'idle' };
test('empty sessions are not completed and stale requests never create a waiting state', () => {
  const pending = { questions: { size: 1 }, approvals: { size: 1 } };
  expect(sessionActivity(session, pending)).toBe('idle');
  expect(sessionActivity({ ...session, status: 'running' }, pending)).toBe('answer');
  expect(sessionActivity({ ...session, status: 'running' }, { ...pending, questions: { size: 0 } })).toBe('approval');
  expect(sessionActivity({ ...session, status: 'error' }, pending)).toBe('error');
  expect(sessionActivity({ ...session, messages: [{ id: 'a', role: 'assistant', parts: [] }] })).toBe('complete');
  expect(sessionActivity({ ...session, messages: [{ id: 'a', role: 'assistant', parts: [], metadata: { interrupted: true } }] })).toBe('idle');
});
