import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from './uuid';

const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
afterEach(() => { Object.defineProperty(globalThis, 'crypto', original); });

test('uses the native UUID implementation when available', () => {
  const source = { randomUUID() { expect(this).toBe(source); return '00112233-4455-4677-8899-aabbccddeeff'; } };
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: source });
  expect(randomUUID()).toBe('00112233-4455-4677-8899-aabbccddeeff');
});

test('remote HTTP fallback preserves cryptographic entropy and sets the UUID v4 version and variant', () => {
  let calls = 0;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues(bytes: Uint8Array) { calls++; expect(bytes).toBeInstanceOf(Uint8Array); expect(bytes.length).toBe(16); bytes.set(Array.from({ length: 16 }, (_, index) => index * 17)); return bytes; } } });
  expect(randomUUID()).toBe('00112233-4455-4677-8899-aabbccddeeff'); expect(calls).toBe(1);
});

test('fallback enforces the UUID variant bits even when all random bytes are set', () => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues(bytes: Uint8Array) { return bytes.fill(255); } } });
  expect(randomUUID()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
});
