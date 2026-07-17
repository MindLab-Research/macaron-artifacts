import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse, serialize } from './agents-store.js';

// Regression: a UI save must not silently drop frontmatter keys the UI doesn't
// model. permissionMode is the canonical case — Claude Code reads it, but the
// Agents editor only knows name/description/tools/model.
test('parse keeps unknown frontmatter keys in extra', () => {
  const raw = '---\nname: x\ndescription: "d"\npermissionMode: bypassPermissions\n---\nbody\n';
  const a = parse(raw, 'x');
  assert.equal(a.extra?.permissionMode, 'bypassPermissions');
});

test('serialize re-emits unknown keys, so a round-trip preserves permissionMode', () => {
  const raw = '---\nname: x\ndescription: "d"\ntools: Read, Edit\npermissionMode: bypassPermissions\n---\nbody\n';
  const out = serialize(parse(raw, 'x'));
  assert.match(out, /permissionMode: bypassPermissions/);
});

test('round-trip is idempotent (no drift, no growth) with unknown keys present', () => {
  const raw = '---\nname: x\ndescription: "d"\nmodel: sonnet\npermissionMode: acceptEdits\n---\nbody\n';
  const once = serialize(parse(raw, 'x'));
  const twice = serialize(parse(once, 'x'));
  assert.equal(twice, once);
});

test('no extra field when every key is UI-owned', () => {
  const a = parse('---\nname: x\ndescription: "d"\n---\nbody\n', 'x');
  assert.equal(a.extra, undefined);
});
