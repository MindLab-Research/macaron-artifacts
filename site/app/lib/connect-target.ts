// Normalize a pasted Macaron server URL (+ optional token) into a safe jump
// target `<origin>/?token=<t>`. The macaron server serves its OWN WebUI, so
// "connecting" is a redirect: we send the browser to the server's origin where
// the WebUI loads same-origin (no CORS, no in-page cross-origin fetch). This
// function is the whole security surface, so it fails closed.
//
// Scheme rules:
//   - scheme-less input (`box.example.com`, `localhost:7878`) → assume the
//     right scheme by host: loopback / private hosts get http (the local case
//     the user actually runs), everything else gets https.
//   - explicit `https://` always allowed.
//   - explicit `http://` allowed ONLY for a loopback / private-LAN host — an
//     access token over http to a public host is unsafe and is rejected. "Local"
//     is decided by a STRICT IP-literal parse, never string prefixes, so a DNS
//     name like `127.attacker.invalid` is public and fails closed.
//   - any other explicit scheme (ftp/ws/…) and any userinfo is rejected.
//   - the site's own origin is rejected — never send the token back to the docs
//     host (pass `selfOrigin` = `window.location.origin`).
// See MAC-8578 / EVE's reviews on PR #144 and #158.

export type BuildResult = { href: string } | { error: string };

// Compare a parsed URL's origin against `selfOrigin`, treating a hostname that
// differs only by a single trailing dot (`host` vs `host.`) as the same origin.
function sameOrigin(parsed: URL, selfOrigin: string): boolean {
  let self: URL;
  try { self = new URL(selfOrigin); } catch { return false; }
  if (parsed.protocol !== self.protocol || parsed.port !== self.port) return false;
  const strip = (host: string) => host.replace(/\.$/, '').toLowerCase();
  return strip(parsed.hostname) === strip(self.hostname);
}

// Matches a leading URI scheme per RFC 3986 (`scheme ":"`), but NOT a bare
// `host:port` — a scheme's colon is never followed by a digit, whereas
// `localhost:7878` is host:port. So `https://x` / `ftp://x` are schemes, while
// `localhost:7878` is treated as scheme-less and gets its scheme inferred.
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i;

// Parse a string as a strict IPv4 literal (exactly four 0-255 octets, no
// leading zeros beyond a lone 0). Returns the octets, or null if it isn't a
// literal — so a DNS name like `127.attacker.invalid` returns null and cannot
// masquerade as a private address via prefix matching.
function parseIPv4(h: string): [number, number, number, number] | null {
  const parts = h.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    if (p.length > 1 && p[0] === '0') return null; // no leading zeros (rejects octal-ish input)
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out as [number, number, number, number];
}

// A host that never leaves the machine / LAN, where an http token is acceptable:
// loopback names, 127.0.0.0/8, 10/8, 192.168/16, 172.16-31/12, 169.254/16
// (link-local), and ::1 / fe80::/10 / fc00::/7. Anything that is neither an
// explicit loopback name nor a valid IP literal in these ranges fails closed —
// an ordinary DNS name is NEVER treated as local.
function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  // Loopback names (accept a trailing dot, the FQDN root form).
  if (h === 'localhost' || h === 'localhost.' || h.endsWith('.localhost') || h.endsWith('.localhost.')) return true;

  // IPv6 literal (URL keeps the brackets in .hostname; strip them). Decide the
  // range by the numeric value of the FIRST 16-bit hextet, never a text prefix:
  // `fc::1` is `00fc::1` (first hextet 0x00fc) and is NOT ULA, so it fails closed.
  if (h.startsWith('[') && h.endsWith(']')) {
    const v6 = h.slice(1, -1);
    if (v6 === '::1') return true;                       // loopback
    const first = v6.startsWith('::') ? 0 : parseInt(v6.split(':')[0], 16);
    if (Number.isNaN(first)) return false;
    if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10 link-local
    if (first >= 0xfc00 && first <= 0xfdff) return true; // fc00::/7 unique-local
    return false;
  }

  const ip = parseIPv4(h);
  if (!ip) return false; // not a loopback name and not an IPv4 literal → fail closed
  const [a, b] = ip;
  if (a === 127) return true;                 // 127.0.0.0/8 loopback
  if (a === 10) return true;                  // 10.0.0.0/8
  if (a === 192 && b === 168) return true;    // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 169 && b === 254) return true;    // 169.254.0.0/16 link-local
  return false;
}

export function buildTarget(rawUrl: string, rawToken: string, selfOrigin?: string): BuildResult {
  const input = rawUrl.trim();
  if (!input) return { error: 'Paste your Macaron server URL first.' };

  let parsed: URL;
  try {
    if (HAS_SCHEME.test(input)) {
      parsed = new URL(input);
    } else {
      // Infer the scheme from the host: local hosts default to http (that's how
      // the local server is reached), everything else to https.
      const probe = new URL(`https://${input}`);
      parsed = new URL((isLocalHost(probe.hostname) ? 'http://' : 'https://') + input);
    }
  } catch {
    return { error: 'That does not look like a valid URL.' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: 'Use an http:// or https:// URL.' };
  }
  if (parsed.protocol === 'http:' && !isLocalHost(parsed.hostname)) {
    return { error: 'Use https:// for a public server — an access token over http is unsafe.' };
  }
  if (parsed.username || parsed.password) return { error: 'Remove the user:pass@ part from the URL.' };
  // Never send the token to this site's own origin — that would leak it into
  // the docs host's request log / browser history instead of a Macaron server.
  // Normalize a single trailing dot on the hostname so `<host>.` (DNS-equal but
  // a distinct serialized origin) can't slip past the equality check.
  if (selfOrigin && sameOrigin(parsed, selfOrigin)) {
    return { error: 'That is this site’s own address — paste your Macaron server URL instead.' };
  }

  // A token typed into the field wins; otherwise keep one already in the URL.
  const token = rawToken.trim() || parsed.searchParams.get('token') || '';
  // Force root: origin drops any pathname/query/hash, so the token can only
  // land on `<origin>/`, never a deeper path or a different host.
  const base = new URL('/', parsed.origin);
  if (token) base.searchParams.set('token', token);
  return { href: base.toString() };
}
