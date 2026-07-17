import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripToken } from './strip-token.ts';

// stripToken must remove EVERY `token` query param, on both the URL-parse path
// and the malformed-URL fallback (EVE round-2 found the fallback left the second
// of a duplicated `token` behind on `http://public.example:bad/?token=a&token=b`).
test('removes a single token from a well-formed URL', () => {
  assert.equal(stripToken('https://x.test/?token=abc'), 'https://x.test/');
});

test('removes duplicate tokens from a well-formed URL', () => {
  assert.equal(stripToken('https://x.test/?token=a&token=b'), 'https://x.test/');
});

test('removes duplicate tokens from a malformed URL (bad port), keeping other params', () => {
  const out = stripToken('http://public.example:bad/?token=EVE_DUP_FIRST&token=EVE_DUP_SECOND');
  assert.ok(!/token=/i.test(out), `token still present: ${out}`);
  assert.ok(!out.includes('EVE_DUP_SECOND'));
});

test('malformed URL: keeps non-token params and drops only tokens', () => {
  const out = stripToken('http://public.example:bad/?a=1&token=x&b=2&token=y');
  assert.ok(!/token=/i.test(out));
  assert.ok(out.includes('a=1') && out.includes('b=2'));
});

test('malformed URL: preserves the fragment while stripping tokens', () => {
  const out = stripToken('http://public.example:bad/?token=x#frag');
  assert.ok(!/token=/i.test(out));
  assert.ok(out.endsWith('#frag'));
});

test('bare host with token strips the token, keeps the host', () => {
  assert.equal(stripToken('x.test/?token=abc'), 'x.test/');
});

test('malformed URL: strips a percent-encoded token key (%74oken)', () => {
  const out = stripToken('http://public.example:bad/?%74oken=EVE_ENCODED');
  assert.ok(!out.includes('EVE_ENCODED'), `encoded token survived: ${out}`);
  assert.ok(!/oken=/i.test(out));
});

test('malformed URL: strips literal + encoded token keys together', () => {
  const out = stripToken('http://public.example:bad/?token=EVE_LITERAL&%74oken=EVE_ENCODED');
  assert.ok(!out.includes('EVE_LITERAL') && !out.includes('EVE_ENCODED'), out);
});

test('malformed URL: an undecodable key fails safe (dropped)', () => {
  // `%zz` can't be decoded; treat it as a token key and drop it rather than leak.
  const out = stripToken('http://public.example:bad/?%zzoken=EVE_BAD&a=1');
  assert.ok(!out.includes('EVE_BAD'));
  assert.ok(out.includes('a=1'));
});

test('input without a token is returned unchanged', () => {
  assert.equal(stripToken('localhost:7878'), 'localhost:7878');
});

test('empty / whitespace input is returned as-is', () => {
  assert.equal(stripToken(''), '');
  assert.equal(stripToken('   '), '   ');
});
