import { afterEach, expect, test } from 'bun:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { AccessPolicy, PasswordAuth } from './auth.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const response = () => new ServerResponse(new IncomingMessage(new Socket()));
const request = (cookie = '') => ({ headers: { cookie } }) as IncomingMessage;

test('expires password sessions and closes both existing and late stream subscriptions', async () => {
  let now = 0;
  const auth = await PasswordAuth.create('a private password', { now: () => now, ttlMs: 1000 }); cleanups.push(() => auth.dispose());
  const login = response(); await auth.login('a private password', login, false);
  const req = request(String(login.getHeader('set-cookie')).split(';')[0]), session = auth.authenticate(req)!;
  const stream = response(); expect(auth.track(session, stream)).toBe(true);
  now = 1001;
  expect(auth.authenticate(req)).toBeUndefined(); expect(stream.writableEnded).toBe(true);
  const late = response(); expect(auth.track(session, late)).toBe(false); expect(late.writableEnded).toBe(true);
});

test('tokens are random, logout revokes just that browser, and malformed cookies fail closed', async () => {
  const auth = await PasswordAuth.create('访问密码 🔑'); cleanups.push(() => auth.dispose());
  const first = response(), second = response(); await auth.login('访问密码 🔑', first, true); await auth.login('访问密码 🔑', second, true);
  const cookie = String(first.getHeader('set-cookie')), other = String(second.getHeader('set-cookie')).split(';')[0];
  expect(cookie).toContain('; HttpOnly; SameSite=Strict; Max-Age=86400; Secure'); expect(cookie).not.toContain('Domain=');
  const value = cookie.split(';')[0], req = request(value), session = auth.authenticate(req)!;
  expect(value).not.toBe(other); expect(auth.authenticate(request(`${value}; ${value}`))).toBeUndefined(); expect(auth.authenticate(request('macaron-artifacts-session=bad'))).toBeUndefined();
  auth.logout(req, response(), true);
  expect(auth.authenticate(req)).toBeUndefined(); expect(auth.authenticate(request(other))).toBeDefined();
  const late = response(); expect(auth.track(session, late)).toBe(false); expect(late.writableEnded).toBe(true);
});

test('login attempt limits recover with time and also cap distributed attempts', async () => {
  let now = 0;
  const auth = await PasswordAuth.create('private password', { now: () => now }); cleanups.push(() => auth.dispose());
  for (let i = 0; i < 10; i++) auth.checkAttempt('one-client');
  expect(() => auth.checkAttempt('one-client')).toThrow('尝试次数过多');
  for (let i = 0; i < 40; i++) auth.checkAttempt(`client-${i}`);
  expect(() => auth.checkAttempt('another-client')).toThrow('尝试次数过多');
  now = 60_001;
  expect(() => auth.checkAttempt('one-client')).not.toThrow();
});

test('network configuration fails closed before exposing an unauthenticated remote listener', () => {
  expect(() => new AccessPolicy({})).not.toThrow();
  for (const host of ['0.0.0.0', '::', '192.168.1.4', 'example.com']) expect(() => new AccessPolicy({ host })).toThrow('MACARON_PASSWORD');
  for (const host of ['127.0.0.1', 'localhost', '::1']) expect(() => new AccessPolicy({ host })).not.toThrow();
  expect(() => new AccessPolicy({ publicOrigin: 'https://artifacts.example' })).toThrow('MACARON_PASSWORD');
  for (const publicOrigin of ['null', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?x=1']) expect(() => new AccessPolicy({ password: 'secret', publicOrigin })).toThrow('MACARON_PUBLIC_ORIGIN');
  for (const password of ['', '   ', 'x'.repeat(1025)]) expect(() => new AccessPolicy({ password })).toThrow('MACARON_PASSWORD');
});
