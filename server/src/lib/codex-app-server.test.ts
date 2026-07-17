import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeDecisions, buildApprovalResponseFrame } from './codex-app-server.js';
import {
  registerApprovalHandler,
  clearApprovalHandler,
  respondCodexApproval,
} from './active-approvals.js';
import type { CodexDecision } from '@macaron/shared';

// --- approval response wire shape (transport-level) -------------------------

// app-server does not use JSON-RPC response envelopes. The reply must echo the
// request method + id with a `response: { decision }` payload; a `{jsonrpc,id,
// result}` frame is silently dropped and leaves the turn parked. Assert the
// exact bytes written to stdout for both approval kinds.
test('buildApprovalResponseFrame emits the app-server response shape, not JSON-RPC', () => {
  const line = buildApprovalResponseFrame(10, 'item/commandExecution/requestApproval', 'accept');
  assert.equal(line.endsWith('\n'), true);
  const parsed = JSON.parse(line);
  assert.deepEqual(parsed, {
    method: 'item/commandExecution/requestApproval',
    id: 10,
    response: { decision: 'accept' },
  });
  // Must NOT be a JSON-RPC response envelope.
  assert.equal('jsonrpc' in parsed, false);
  assert.equal('result' in parsed, false);
});

test('buildApprovalResponseFrame echoes the file-approval method and each decision', () => {
  for (const d of ['accept', 'acceptForSession', 'decline', 'cancel'] as CodexDecision[]) {
    const parsed = JSON.parse(buildApprovalResponseFrame('t1:5', 'item/fileChange/requestApproval', d));
    assert.deepEqual(parsed, {
      method: 'item/fileChange/requestApproval',
      id: 't1:5',
      response: { decision: d },
    });
  }
});

// --- normalizeDecisions: availableDecisions → plain CodexDecision[] ---------

test('normalizeDecisions keeps the four known plain decisions', () => {
  assert.deepEqual(
    normalizeDecisions(['accept', 'acceptForSession', 'decline', 'cancel']),
    ['accept', 'acceptForSession', 'decline', 'cancel'],
  );
});

test('normalizeDecisions drops amendment objects but keeps sibling strings', () => {
  const available = ['accept', { acceptWithExecpolicyAmendment: { foo: 1 } }, 'decline'];
  assert.deepEqual(normalizeDecisions(available), ['accept', 'decline']);
});

test('normalizeDecisions falls back when nothing usable is offered', () => {
  assert.deepEqual(normalizeDecisions(undefined), ['accept', 'decline', 'cancel']);
  assert.deepEqual(normalizeDecisions([{ onlyAmendments: true }]), ['accept', 'decline', 'cancel']);
});

// --- approval correlation + every decision routes back correctly ------------

// Model the runner's handler: it holds a map of approvalId → JSON-RPC requestId
// and replies on the matching request. The test asserts the /approval route's
// respondCodexApproval reaches the right parked request for every decision, and
// that a stale/unknown id returns false.
test('respondCodexApproval correlates each decision to its parked request', () => {
  const sid = 'thread-1';
  const replies: Array<{ requestId: number; decision: CodexDecision }> = [];
  const pending = new Map<string, number>([
    ['thread-1:10', 10],
    ['thread-1:11', 11],
  ]);
  registerApprovalHandler(sid, (approvalId, decision) => {
    const requestId = pending.get(approvalId);
    if (requestId === undefined) return false;
    replies.push({ requestId, decision });
    pending.delete(approvalId);
    return true;
  });

  const all: CodexDecision[] = ['accept', 'acceptForSession', 'decline', 'cancel'];
  // Same request answered by each decision in turn (re-seed so the id stays live).
  for (const d of all) {
    pending.set('thread-1:10', 10);
    assert.equal(respondCodexApproval(sid, 'thread-1:10', d), true);
    assert.deepEqual(replies.at(-1), { requestId: 10, decision: d });
  }

  // A second concurrent request routes to its own id, not the first.
  assert.equal(respondCodexApproval(sid, 'thread-1:11', 'accept'), true);
  assert.equal(replies.at(-1)!.requestId, 11);

  // Answering an already-cleared id (server raced us) reports not-live.
  assert.equal(respondCodexApproval(sid, 'thread-1:11', 'accept'), false);

  clearApprovalHandler(sid);
  // After the turn ends the handler is gone: the route reports not-live.
  assert.equal(respondCodexApproval(sid, 'thread-1:10', 'accept'), false);
});

test('respondCodexApproval isolates handlers per session', () => {
  registerApprovalHandler('a', () => true);
  assert.equal(respondCodexApproval('b', 'a:1', 'accept'), false);
  clearApprovalHandler('a');
});
