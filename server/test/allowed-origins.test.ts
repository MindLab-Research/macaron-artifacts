import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAllowedOrigins, OFFICIAL_HOSTED_ORIGINS } from '../src/config.js';

const OFFICIAL = OFFICIAL_HOSTED_ORIGINS[0];

test('no explicit origins, hosted off → empty (same-origin default)', () => {
  assert.deepEqual(buildAllowedOrigins([], false), []);
});

test('hosted on → official origins are appended', () => {
  assert.deepEqual(buildAllowedOrigins([], true), [...OFFICIAL_HOSTED_ORIGINS]);
});

test('explicit + hosted → union, explicit first, deduped', () => {
  assert.deepEqual(buildAllowedOrigins(['https://a.test'], true), ['https://a.test', OFFICIAL]);
});

test('duplicate explicit origins are removed in first-seen order', () => {
  assert.deepEqual(
    buildAllowedOrigins(['https://a.test', 'https://a.test', 'https://b.test', 'https://a.test'], true),
    ['https://a.test', 'https://b.test', OFFICIAL],
  );
});

test('explicit already lists the official origin → not duplicated', () => {
  assert.deepEqual(buildAllowedOrigins([OFFICIAL], true), [OFFICIAL]);
});

test('explicit origins pass through untouched when hosted is off', () => {
  assert.deepEqual(buildAllowedOrigins(['https://a.test', 'https://b.test'], false), ['https://a.test', 'https://b.test']);
});
