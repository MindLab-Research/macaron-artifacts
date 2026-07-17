import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostedTarget, HANDOFF_KEY } from './hosted-target.ts';

// hostedTarget turns buildTarget's `<origin>/?token=` into a same-origin hosted
// route + a one-time handoff. The server/token ride in the HANDOFF (stashed
// same-tab by the connect page), NEVER on the route URL — that's the P0 fix so
// the credential can't leak into the document GET / access logs / referrers. It
// must pick /app vs /app/codex by engine, split origin + token, and keep the
// route a bare relative path with no query.

test('claude engine → /app route + handoff carrying origin and token', () => {
  assert.deepEqual(hostedTarget('http://localhost:7878/?token=t', 'claude'), {
    route: '/app',
    handoff: { server: 'http://localhost:7878', token: 't' },
  });
});

test('codex engine → /app/codex route', () => {
  assert.deepEqual(hostedTarget('http://localhost:7979/?token=t', 'codex'), {
    route: '/app/codex',
    handoff: { server: 'http://localhost:7979', token: 't' },
  });
});

test('no token → empty token in handoff', () => {
  assert.deepEqual(hostedTarget('https://x.trycloudflare.com/', 'claude'), {
    route: '/app',
    handoff: { server: 'https://x.trycloudflare.com', token: '' },
  });
});

test('server is the ORIGIN only — any path/query on the input is dropped', () => {
  const { handoff } = hostedTarget('https://tunnel.test/?token=abc', 'claude');
  assert.equal(handoff.server, 'https://tunnel.test');
});

test('route is a bare relative path — no token/server ever on the URL', () => {
  const { route } = hostedTarget('https://tunnel.test/?token=secret', 'codex');
  assert.equal(route, '/app/codex');
  assert.ok(!route.includes('secret') && !route.includes('server') && !route.includes('?'), route);
});

// Cross-workspace contract: the web bundle reads this exact sessionStorage key
// (web/src/lib/auth.ts pins the same literal in web/test/apiBase.test.ts). If
// either side renames it, its own tests fail instead of hosted mode silently
// never consuming the handoff.
test('HANDOFF_KEY matches the literal the web bundle consumes', () => {
  assert.equal(HANDOFF_KEY, 'macaron_connect_handoff');
});
