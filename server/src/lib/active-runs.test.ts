import assert from 'node:assert/strict';
import { test } from 'node:test';
import { abortRun, claimRun, endRun } from './active-runs.js';

test('a session claim stays owned until its runner releases it', () => {
  const sid = 'claim-owner-test';
  const first = new AbortController();
  const competing = new AbortController();

  assert.equal(claimRun(sid, first), true);
  assert.equal(claimRun(sid, competing), false);
  assert.equal(abortRun(sid), true);
  assert.equal(first.signal.aborted, true);
  assert.equal(abortRun(sid), false);

  assert.equal(endRun(sid, competing), false);
  assert.equal(claimRun(sid, competing), false);
  assert.equal(endRun(sid, first), true);
  assert.equal(claimRun(sid, competing), true);
  assert.equal(endRun(sid, competing), true);
});
