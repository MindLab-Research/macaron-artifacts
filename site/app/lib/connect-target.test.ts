import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTarget } from './connect-target.ts';

// Table-driven coverage of every normalization branch: bare host (scheme
// inferred by host), https + path/query/hash forced to root, http allowed only
// for local hosts, other schemes / userinfo rejected, token from field vs URL,
// and token encoding. Extends PR #144's gate with the http-localhost case.
const cases: Array<{ name: string; url: string; token: string; self?: string; expect: { href: string } | { error: true } }> = [
  // bare host → scheme inferred
  { name: 'bare public host → https + field token', url: 'x.trycloudflare.com', token: 'tok9', expect: { href: 'https://x.trycloudflare.com/?token=tok9' } },
  { name: 'bare public host, no token', url: 'x.trycloudflare.com', token: '', expect: { href: 'https://x.trycloudflare.com/' } },
  { name: 'bare localhost:port → http (the local case)', url: 'localhost:7878', token: 'lt', expect: { href: 'http://localhost:7878/?token=lt' } },
  { name: 'bare 127.0.0.1 → http', url: '127.0.0.1:7979', token: '', expect: { href: 'http://127.0.0.1:7979/' } },
  { name: 'bare 192.168 LAN host → http', url: '192.168.1.50:7878', token: 'k', expect: { href: 'http://192.168.1.50:7878/?token=k' } },
  // explicit https
  { name: 'https root + url token kept', url: 'https://x.trycloudflare.com/?token=abc123', token: '', expect: { href: 'https://x.trycloudflare.com/?token=abc123' } },
  { name: 'https + deep path is forced to root', url: 'https://tunnel.test/deep/path?token=url-token', token: '', expect: { href: 'https://tunnel.test/?token=url-token' } },
  { name: 'https + path + hash dropped', url: 'https://tunnel.test/a/b#frag', token: 'k', expect: { href: 'https://tunnel.test/?token=k' } },
  { name: 'field token overrides url token', url: 'https://x.test/?token=inurl', token: 'field-wins', expect: { href: 'https://x.test/?token=field-wins' } },
  { name: 'token is url-encoded', url: 'https://x.test/', token: 'a b/c+d', expect: { href: 'https://x.test/?token=a+b%2Fc%2Bd' } },
  // explicit http: local ok, public rejected
  { name: 'explicit http://localhost is allowed', url: 'http://localhost:7878/?token=abc', token: '', expect: { href: 'http://localhost:7878/?token=abc' } },
  { name: 'explicit http://127.0.0.1 is allowed', url: 'http://127.0.0.1:7878/', token: 't', expect: { href: 'http://127.0.0.1:7878/?token=t' } },
  { name: 'http to a PUBLIC host is rejected', url: 'http://x.test/?token=abc', token: '', expect: { error: true } },
  // other schemes / userinfo / junk
  { name: 'ftp scheme is rejected (not treated as bare host)', url: 'ftp://tunnel.test/share?token=url-token', token: '', expect: { error: true } },
  { name: 'ws scheme is rejected', url: 'ws://tunnel.test/', token: '', expect: { error: true } },
  { name: 'userinfo is rejected', url: 'https://user:pass@tunnel.test/path?token=url-token', token: '', expect: { error: true } },
  { name: 'username-only is rejected', url: 'https://user@tunnel.test/', token: '', expect: { error: true } },
  { name: 'empty input is rejected', url: '', token: '', expect: { error: true } },
  { name: 'whitespace-only input is rejected', url: '   ', token: '', expect: { error: true } },
  { name: 'garbage is rejected', url: 'not a url ::::', token: 'x', expect: { error: true } },

  // EVE PR #158 regressions — DNS-prefix bypass of the http/local gate. A hostname
  // that merely starts with a private-range prefix is NOT local and must fail
  // closed (http rejected), never send a token in cleartext to a public host.
  { name: '127.x DNS name is not local (http rejected)', url: 'http://127.attacker.invalid:7878/?token=EVE_BYPASS', token: '', expect: { error: true } },
  { name: '10.x DNS name is not local', url: 'http://10.attacker.invalid:7878/', token: 't', expect: { error: true } },
  { name: '192.168 DNS name is not local', url: 'http://192.168.attacker.invalid:7878/', token: 't', expect: { error: true } },
  { name: '172.16 DNS name is not local', url: 'http://172.16.attacker.invalid:7878/', token: 't', expect: { error: true } },
  { name: 'fc-prefixed DNS name is not local', url: 'http://fc-attacker.invalid:7878/', token: 't', expect: { error: true } },
  { name: 'fd-prefixed DNS name is not local', url: 'http://fd.attacker.invalid:7878/', token: 't', expect: { error: true } },
  { name: 'bare 127.x DNS name infers https, not http', url: '127.attacker.invalid:7878', token: 't', expect: { href: 'https://127.attacker.invalid:7878/?token=t' } },
  { name: 'octet > 255 is not a v4 literal (public)', url: 'http://127.0.0.999:7878/', token: 't', expect: { error: true } },
  { name: 'five octets is not a v4 literal (public)', url: 'http://127.0.0.0.1:7878/', token: 't', expect: { error: true } },

  // Ranges the header comment claims but the old code missed.
  { name: '169.254 link-local → http allowed', url: 'http://169.254.1.2:7878/', token: 't', expect: { href: 'http://169.254.1.2:7878/?token=t' } },
  { name: 'fe80 link-local IPv6 → http allowed', url: 'http://[fe80::1]:7878/', token: 't', expect: { href: 'http://[fe80::1]:7878/?token=t' } },
  { name: '::1 IPv6 loopback → http allowed', url: 'http://[::1]:7878/', token: 't', expect: { href: 'http://[::1]:7878/?token=t' } },
  { name: 'trailing-dot localhost. → http allowed', url: 'http://localhost.:7878/', token: 't', expect: { href: 'http://localhost.:7878/?token=t' } },

  // Self-origin rejection — never send the token back to the docs host itself.
  { name: 'self origin is rejected', url: 'https://docs.example.com/?token=EVE_SELF', token: '', self: 'https://docs.example.com', expect: { error: true } },
  { name: 'self origin bare host is rejected', url: 'docs.example.com', token: 't', self: 'https://docs.example.com', expect: { error: true } },
  { name: 'different origin under same self is allowed', url: 'https://other.example.com/', token: 't', self: 'https://docs.example.com', expect: { href: 'https://other.example.com/?token=t' } },

  // EVE round-2: IPv6 range must be decided by the numeric first hextet, not a
  // text prefix. `fc::1` is 00fc::1 and is NOT in fc00::/7 — must fail closed.
  { name: 'fc::1 is not ULA (http rejected)', url: 'http://[fc::1]:7878/?token=EVE_IPV6', token: '', expect: { error: true } },
  { name: 'fca::1 is not ULA', url: 'http://[fca::1]:7878/', token: 't', expect: { error: true } },
  { name: 'fd0::1 is not ULA', url: 'http://[fd0::1]:7878/', token: 't', expect: { error: true } },
  { name: 'fe8::1 is not link-local', url: 'http://[fe8::1]:7878/', token: 't', expect: { error: true } },
  { name: 'feb::1 is not link-local', url: 'http://[feb::1]:7878/', token: 't', expect: { error: true } },
  { name: 'fc00::1 IS ULA (http allowed)', url: 'http://[fc00::1]:7878/', token: 't', expect: { href: 'http://[fc00::1]:7878/?token=t' } },
  { name: 'fdff::1 IS ULA', url: 'http://[fdff::1]:7878/', token: 't', expect: { href: 'http://[fdff::1]:7878/?token=t' } },
  { name: 'fe80::1 IS link-local', url: 'http://[fe80::1]:7878/', token: 't', expect: { href: 'http://[fe80::1]:7878/?token=t' } },
  { name: 'febf::1 IS link-local', url: 'http://[febf::1]:7878/', token: 't', expect: { href: 'http://[febf::1]:7878/?token=t' } },

  // EVE round-2: self-origin must survive a DNS trailing dot on either side.
  { name: 'self origin with trailing dot is rejected', url: 'https://docs.example.com./?token=EVE_DOT', token: '', self: 'https://docs.example.com', expect: { error: true } },
  { name: 'self origin bare host with trailing dot is rejected', url: 'docs.example.com.', token: 't', self: 'https://docs.example.com', expect: { error: true } },
];

for (const c of cases) {
  test(c.name, () => {
    const r = buildTarget(c.url, c.token, c.self);
    if ('error' in c.expect) {
      assert.ok('error' in r, `expected an error for ${JSON.stringify(c.url)}, got ${JSON.stringify(r)}`);
    } else {
      assert.deepEqual(r, c.expect);
    }
  });
}
