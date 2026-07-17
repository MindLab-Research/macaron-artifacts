import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveToken } from '../src/lib/auth.js';

// P1: enabling hosted mode by setting MACARON_ALLOWED_ORIGINS alone must NOT
// leave a loopback API unarmed. isLocalRequest denies the frictionless-localhost
// bypass to any cross-origin browser request, so a hosted page on an allowlisted
// origin would otherwise reach a fully unauthenticated API. resolveToken arms a
// token whenever cross-origin is enabled, mirroring the non-loopback-bind case.

test('loopback + no cross-origin + no token → auth off (frictionless local default)', () => {
  assert.deepEqual(resolveToken('127.0.0.1', '', false), { token: '', generated: false });
});

test('loopback + cross-origin enabled + no token → a token is generated', () => {
  const r = resolveToken('127.0.0.1', '', true);
  assert.equal(r.generated, true);
  assert.ok(r.token.length > 0);
});

test('non-loopback bind + no token → generated (unchanged)', () => {
  assert.equal(resolveToken('0.0.0.0', '', false).generated, true);
});

test('a configured token always wins, cross-origin or not', () => {
  assert.deepEqual(resolveToken('127.0.0.1', 'set', true), { token: 'set', generated: false });
});
