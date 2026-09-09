import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';

const DEFAULT_CODE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_GRANT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ORIGINS = ['https://artifacts.macaron.im'];
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type PairingOptions = { enabled?: boolean; allowedOrigins?: string[]; code?: string; codeTtlMs?: number; grantTtlMs?: number; now?: () => number };
export type PairingContext = { id: string; name: string; expiresAt: number; protocolVersion: 1 };
export type PairingGrant = PairingContext & { origin: string };

function digest(value: string): Buffer { return createHash('sha256').update(value).digest(); }
function sameSecret(value: string, expected: Buffer): boolean { const actual = digest(value); return actual.length === expected.length && timingSafeEqual(actual, expected); }
function validOrigin(value: string): string | undefined {
  try {
    const url = new URL(value), authority = value.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]+)/i)?.[1];
    if (!authority || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' && url.pathname !== '' || url.search || url.hash) return undefined;
    const explicitPort = /:\d+$/.test(authority) ? authority.slice(authority.lastIndexOf(':')) : '';
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    return `${url.protocol}//${hostname.includes(':') ? `[${hostname}]` : hostname}${explicitPort}`;
  } catch { return undefined; }
}
function makeCode(): string {
  const bytes = randomBytes(16), chars = [...bytes].map(byte => ALPHABET[byte % ALPHABET.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}-${chars.slice(12).join('')}`;
}
function error(message: string, status: number): Error & { status: number } { return Object.assign(new Error(message), { status }); }

type InternalGrant = PairingGrant & { tokenDigest: Buffer; close: Set<() => void>; expiryTimer?: ReturnType<typeof setTimeout> };

export class PairingManager {
  readonly enabled: boolean;
  readonly allowedOrigins: readonly string[];
  private readonly codeTtlMs: number;
  private readonly grantTtlMs: number;
  private readonly now: () => number;
  private codeDigest: Buffer;
  private codeExpiresAt: number;
  private attempts = 0;
  private currentCode: string;
  private grants = new Map<string, InternalGrant>();

  constructor(options: PairingOptions = {}) {
    this.enabled = options.enabled === true;
    this.now = options.now ?? Date.now;
    this.codeTtlMs = Math.max(1, options.codeTtlMs ?? DEFAULT_CODE_TTL_MS);
    this.grantTtlMs = Math.max(1, options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS);
    this.allowedOrigins = [...new Set((options.allowedOrigins?.length ? options.allowedOrigins : DEFAULT_ORIGINS).map(validOrigin).filter((origin): origin is string => Boolean(origin)))];
    this.currentCode = options.code ?? makeCode();
    this.codeDigest = digest(this.currentCode);
    this.codeExpiresAt = this.now() + this.codeTtlMs;
  }

  get code(): string { return this.currentCode; }
  get codeExpiry(): number { return this.codeExpiresAt; }
  get paired(): boolean { this.expire(); return this.grants.size > 0; }

  originAllowed(origin: string | undefined): boolean { return Boolean(origin && this.allowedOrigins.includes(origin)); }

  claim(code: string, origin: string): { token: string; id: string; name: string; expiresAt: number; protocolVersion: 1 } {
    if (!this.enabled) throw error('Pairing is disabled.', 404);
    const normalizedOrigin = validOrigin(origin);
    if (!normalizedOrigin || !this.originAllowed(normalizedOrigin)) throw error('This WebUI origin is not allowed.', 403);
    this.expire();
    if (this.now() >= this.codeExpiresAt) throw error('The pairing code has expired. Generate a new code locally.', 410);
    if (this.attempts >= 10) throw error('Too many pairing attempts. Generate a new code locally.', 429);
    this.attempts++;
    if (!sameSecret(code.trim().toUpperCase(), this.codeDigest)) throw error('Invalid pairing code.', 401);
    const id = crypto.randomUUID(), token = randomBytes(32).toString('base64url'), grant: InternalGrant = { id, name: 'Macaron Artifacts', origin: normalizedOrigin, expiresAt: this.now() + this.grantTtlMs, protocolVersion: 1, tokenDigest: digest(token), close: new Set() };
    grant.expiryTimer = setTimeout(() => this.revoke(id), this.grantTtlMs); grant.expiryTimer.unref?.(); this.grants.set(id, grant);
    this.currentCode = ''; this.codeDigest = digest(randomBytes(32).toString('base64url')); this.codeExpiresAt = this.now();
    return { token, id, name: grant.name, expiresAt: grant.expiresAt, protocolVersion: 1 };
  }

  authenticate(token: string | undefined, origin: string | undefined): InternalGrant | undefined {
    this.expire();
    if (!token || !origin) return undefined;
    const normalizedOrigin = validOrigin(origin);
    if (!normalizedOrigin) return undefined;
    for (const grant of this.grants.values()) if (grant.origin === normalizedOrigin && sameSecret(token, grant.tokenDigest)) return grant;
    return undefined;
  }

  context(grant: PairingGrant): PairingContext { return { id: grant.id, name: grant.name, expiresAt: grant.expiresAt, protocolVersion: 1 }; }
  list(): PairingContext[] { this.expire(); return [...this.grants.values()].map(grant => this.context(grant)); }
  revoke(id: string): boolean { const grant = this.grants.get(id); if (!grant) return false; this.grants.delete(id); if (grant.expiryTimer) clearTimeout(grant.expiryTimer); for (const close of grant.close) close(); grant.close.clear(); return true; }
  revokeCurrent(grant: PairingGrant): boolean { return this.revoke(grant.id); }
  track(grant: PairingGrant, response: ServerResponse): () => void {
    const internal = this.grants.get(grant.id); if (!internal) return () => {};
    const close = () => { if (!response.writableEnded) response.end(); };
    internal.close.add(close); const cleanup = () => { internal.close.delete(close); };
    response.once('close', cleanup); response.once('finish', cleanup); return cleanup;
  }
  generateCode(): { code: string; expiresAt: number } {
    if (!this.enabled) throw error('Pairing is disabled.', 404);
    this.currentCode = makeCode(); this.codeDigest = digest(this.currentCode); this.codeExpiresAt = this.now() + this.codeTtlMs; this.attempts = 0;
    return { code: this.currentCode, expiresAt: this.codeExpiresAt };
  }
  expire(): void { const now = this.now(); for (const grant of this.grants.values()) if (grant.expiresAt <= now) this.revoke(grant.id); }
}

export function bearerToken(value: string | undefined): string | undefined { return value?.startsWith('Bearer ') ? value.slice(7) : undefined; }
export function isLoopbackHost(value: string | undefined): boolean { if (!value) return false; try { const host = new URL(`http://${value}`).hostname; return host === 'localhost' || host === '::1' || host === '[::1]' || host === '127.0.0.1'; } catch { return false; } }
export function originHost(value: string | undefined): string | undefined { try { return value ? new URL(value).host : undefined; } catch { return undefined; } }
export function originProtocol(value: string | undefined): string | undefined { try { return value ? new URL(value).protocol : undefined; } catch { return undefined; } }
