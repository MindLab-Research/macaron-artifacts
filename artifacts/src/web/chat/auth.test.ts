import { afterEach, describe, expect, test } from 'bun:test';
import { acceptPasswordSession, authenticatedFetch, requestAuth, subscribePasswordRequired } from './auth';

const originalFetch = globalThis.fetch, originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => { globalThis.fetch = originalFetch; if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window'); });
function location() { Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { href: 'https://artifacts.example/', origin: 'https://artifacts.example' } } }); }

describe('server password authentication', () => {
  test('password errors lock only the same-origin server and preserve the response for its caller', async () => {
    location(); let locks = 0;
    const unsubscribe = subscribePasswordRequired(() => locks++);
    globalThis.fetch = (async (_input: RequestInfo | URL) => Response.json({ error: 'login required', passwordRequired: true }, { status: 401 })) as typeof fetch;
    try {
      const response = await authenticatedFetch('/api/sessions');
      expect(locks).toBe(1); expect(await response.json()).toEqual({ error: 'login required', passwordRequired: true });
      await authenticatedFetch('https://paired.example/api/sessions');
      expect(locks).toBe(1);
      globalThis.fetch = (async (_input: RequestInfo | URL) => Response.json({ error: 'pairing required', authRequired: true }, { status: 401 })) as typeof fetch;
      await authenticatedFetch('/api/sessions'); expect(locks).toBe(1);
    } finally { unsubscribe(); }
  });

  test('an expired request cannot lock a newly authenticated session', async () => {
    location(); let locks = 0, release!: (response: Response) => void;
    const unsubscribe = subscribePasswordRequired(() => locks++);
    globalThis.fetch = ((_input: RequestInfo | URL) => new Promise<Response>(resolve => { release = resolve; })) as typeof fetch;
    try {
      const pending = authenticatedFetch('/api/sessions');
      acceptPasswordSession(); release(Response.json({ passwordRequired: true }, { status: 401 }));
      await pending; expect(locks).toBe(0);
    } finally { unsubscribe(); }
  });

  test('unsubscribing removes the password expiry listener', async () => {
    location(); let locks = 0;
    const unsubscribe = subscribePasswordRequired(() => locks++); unsubscribe();
    globalThis.fetch = (async (_input: RequestInfo | URL) => Response.json({ passwordRequired: true }, { status: 401 })) as typeof fetch;
    await authenticatedFetch(new Request('https://artifacts.example/api/chat')); expect(locks).toBe(0);
  });

  test('auth requests stay on the page origin and use cookies without persisting or trimming the password', async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => { requests.push({ input, init }); return Response.json({ enabled: true, authenticated: true }); }) as typeof fetch;
    await requestAuth(); await requestAuth('login', ' password with spaces '); await requestAuth('logout');
    expect(requests.map(request => request.input)).toEqual(['/api/auth', '/api/auth/login', '/api/auth/logout']);
    expect(requests.map(request => request.init?.method)).toEqual(['GET', 'POST', 'POST']);
    expect(requests.every(request => request.init?.credentials === 'same-origin' && request.init.cache === 'no-store')).toBe(true);
    expect(requests[1].init?.body).toBe(JSON.stringify({ password: ' password with spaces ' }));
    expect(new Headers(requests[1].init?.headers).has('authorization')).toBe(false);
  });

  test('login errors distinguish a wrong password, rate limiting, and invalid auth state', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL) => Response.json({ error: 'Wrong password' }, { status: 401 })) as typeof fetch;
    await expect(requestAuth('login', 'bad')).rejects.toThrow('密码不正确');
    globalThis.fetch = (async (_input: RequestInfo | URL) => new Response(null, { status: 429, headers: { 'retry-after': '30' } })) as typeof fetch;
    await expect(requestAuth('login', 'bad')).rejects.toThrow('30 秒后');
    globalThis.fetch = (async (_input: RequestInfo | URL) => Response.json({ authenticated: true })) as typeof fetch;
    await expect(requestAuth()).rejects.toThrow('无效的登录状态');
  });
});
