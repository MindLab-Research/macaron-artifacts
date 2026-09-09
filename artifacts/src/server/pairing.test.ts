import { describe, expect, test } from 'bun:test';
import { PairingManager, bearerToken, isLoopbackHost } from './pairing.js';

describe('PairingManager', () => {
  test('creates one hashed, origin-bound grant and consumes its code once', () => {
    const manager = new PairingManager({ enabled: true, allowedOrigins: ['https://artifacts.example'], code: 'ABCD-EFGH-JKLM-NPQR' });
    const result = manager.claim('abcd-efgh-jklm-npqr', 'https://artifacts.example');
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(manager.authenticate(result.token, 'https://artifacts.example')?.id).toBe(result.id);
    expect(manager.authenticate(result.token, 'https://artifacts.example:443')).toBeUndefined();
    expect(manager.authenticate(result.token, 'https://evil.example')).toBeUndefined();
    expect(() => manager.claim('ABCD-EFGH-JKLM-NPQR', 'https://artifacts.example')).toThrow('expired');
    expect(manager.list()).toEqual([{ id: result.id, name: 'Macaron Artifacts', expiresAt: result.expiresAt, protocolVersion: 1 }]);
  });

  test('expires codes and grants independently with a deterministic clock', () => {
    let now = 1_000;
    const manager = new PairingManager({ enabled: true, allowedOrigins: ['https://artifacts.example'], code: 'ABCD-EFGH-JKLM-NPQR', codeTtlMs: 100, grantTtlMs: 1_000, now: () => now });
    now += 101;
    expect(() => manager.claim('ABCD-EFGH-JKLM-NPQR', 'https://artifacts.example')).toThrow('expired');
    const renewed = manager.generateCode();
    const result = manager.claim(renewed.code, 'https://artifacts.example');
    now += 999; expect(manager.authenticate(result.token, 'https://artifacts.example')).toBeDefined();
    now += 1; expect(manager.authenticate(result.token, 'https://artifacts.example')).toBeUndefined();
  });

  test('limits invalid attempts and allows independent grants after code rotation', () => {
    const manager = new PairingManager({ enabled: true, allowedOrigins: ['https://artifacts.example'], code: 'ABCD-EFGH-JKLM-NPQR' });
    for (let i = 0; i < 10; i++) expect(() => manager.claim('WRONG-CODE', 'https://artifacts.example')).toThrow('Invalid pairing code');
    expect(() => manager.claim('ABCD-EFGH-JKLM-NPQR', 'https://artifacts.example')).toThrow('Too many');
    const renewed = manager.generateCode(), result = manager.claim(renewed.code, 'https://artifacts.example');
    expect(manager.list()).toMatchObject([{ id: result.id, protocolVersion: 1 }]);
  });

  test('claims a code only once under concurrent callers', async () => {
    const manager = new PairingManager({ enabled: true, allowedOrigins: ['https://artifacts.example'], code: 'ABCD-EFGH-JKLM-NPQR' });
    const results = await Promise.allSettled([1, 2].map(() => Promise.resolve().then(() => manager.claim('ABCD-EFGH-JKLM-NPQR', 'https://artifacts.example'))));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  });

  test('extracts bearer credentials only from the authorization scheme', () => {
    expect(bearerToken('Bearer secret')).toBe('secret');
    expect(bearerToken('Basic secret')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });

  test('recognizes IPv4, IPv6, and localhost loopback hosts only', () => {
    expect(isLoopbackHost('127.0.0.1:43860')).toBe(true); expect(isLoopbackHost('[::1]:43860')).toBe(true); expect(isLoopbackHost('localhost:43860')).toBe(true); expect(isLoopbackHost('0.0.0.0:43860')).toBe(false);
  });
});
