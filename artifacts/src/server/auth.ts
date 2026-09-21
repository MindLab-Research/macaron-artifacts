import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { isLoopbackHost } from './pairing.js';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000, ATTEMPT_WINDOW_MS = 60_000;
const COOKIE_NAME = 'macaron-artifacts-session';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const failure = (message: string, status: number, retryAfter?: number) => Object.assign(new Error(message), { status, retryAfter });
const derive = (password: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 32, (error, key) => error ? reject(error) : resolve(key)));

export function normalizeOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash ? url.origin : undefined; }
  catch { return undefined; }
}

export class AccessPolicy {
  readonly host: string;
  readonly publicOrigin?: string;
  private readonly publicProtocol?: string;
  private readonly publicHost?: string;
  constructor(options: { host?: string; publicOrigin?: string; password?: string }) {
    this.host = options.host ?? '127.0.0.1';
    if (!this.host || !(isIP(this.host) || /^(?=.{1,253}$)[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(this.host))) throw new Error('MACARON_HOST must be a hostname or IP address, without a port.');
    this.publicOrigin = normalizeOrigin(options.publicOrigin);
    if (options.publicOrigin !== undefined && !this.publicOrigin) throw new Error('MACARON_PUBLIC_ORIGIN must be an HTTP(S) origin without a path.');
    if (this.publicOrigin) { const url = new URL(this.publicOrigin); this.publicProtocol = url.protocol; this.publicHost = url.host; }
    if (options.password !== undefined && (!options.password.trim() || Buffer.byteLength(options.password) > 1024)) throw new Error('MACARON_PASSWORD must contain 1–1024 bytes and cannot be blank.');
    if ((!isLoopbackHost(isIP(this.host) === 6 ? `[${this.host}]` : this.host) || this.publicHost && !isLoopbackHost(this.publicHost)) && !options.password) throw new Error('Set MACARON_PASSWORD before listening outside loopback or using a public origin.');
  }

  request(req: IncomingMessage, passwordEnabled: boolean) {
    const rawHost = req.headers.host, origin = normalizeOrigin(rawHost ? `http://${rawHost}` : undefined), host = origin ? new URL(origin).host : undefined;
    const loopback = isLoopbackHost(host), publicRequest = Boolean(this.publicOrigin && normalizeOrigin(`${this.publicProtocol}//${rawHost}`) === this.publicOrigin);
    const allowed = Boolean(host && (passwordEnabled ? !this.publicOrigin || loopback || publicRequest : loopback && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')));
    // Forwarded headers are untrusted. HTTPS proxies must preserve Host and declare their browser origin explicitly.
    const expectedOrigin = publicRequest ? this.publicOrigin : origin;
    const suppliedOrigin = req.headers.origin, normalized = normalizeOrigin(suppliedOrigin);
    return { allowed, invalidOrigin: Boolean(suppliedOrigin && !normalized), crossOrigin: Boolean(suppliedOrigin && normalized !== expectedOrigin || !suppliedOrigin && req.headers['sec-fetch-site'] === 'cross-site'), secure: expectedOrigin?.startsWith('https:') === true };
  }
}

export type PasswordSession = { expiresAt: number; revoked: boolean; close: Set<() => void>; timer: ReturnType<typeof setTimeout> };
type AttemptWindow = { count: number; until: number };
export class PasswordAuth {
  readonly enabled: boolean;
  private readonly salt = randomBytes(32);
  private key?: Buffer;
  private readonly sessions = new Map<string, PasswordSession>();
  private readonly attempts = new Map<string, AttemptWindow>();
  private global: AttemptWindow = { count: 0, until: 0 };

  private constructor(private readonly now: () => number, private readonly ttl: number, enabled: boolean) { this.enabled = enabled; }
  static async create(password?: string, options: { now?: () => number; ttlMs?: number } = {}) {
    const auth = new PasswordAuth(options.now ?? Date.now, options.ttlMs ?? SESSION_TTL_MS, password !== undefined);
    if (password !== undefined) auth.key = await derive(password, auth.salt);
    return auth;
  }
  private revoke(key: string) { const session = this.sessions.get(key); if (!session) return; session.revoked = true; this.sessions.delete(key); clearTimeout(session.timer); for (const close of session.close) close(); session.close.clear(); }
  private token(req: IncomingMessage): string | undefined {
    const values = (req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE_NAME}=`));
    const token = values.length === 1 ? values[0].slice(COOKIE_NAME.length + 1) : undefined;
    return token && /^[\w-]{43}$/.test(token) ? token : undefined;
  }
  authenticate(req: IncomingMessage): PasswordSession | undefined {
    const token = this.token(req); if (!token) return;
    const key = digest(token), session = this.sessions.get(key);
    if (session && session.expiresAt <= this.now()) { this.revoke(key); return; }
    return session;
  }
  checkAttempt(address: string) {
    const now = this.now();
    if (this.global.until <= now) this.global = { count: 0, until: now + ATTEMPT_WINDOW_MS };
    for (const [key, attempt] of this.attempts) if (attempt.until <= now) this.attempts.delete(key);
    let attempt = this.attempts.get(address);
    if (!attempt) { if (this.attempts.size >= 1000) this.attempts.delete(this.attempts.keys().next().value!); attempt = { count: 0, until: now + ATTEMPT_WINDOW_MS }; this.attempts.set(address, attempt); }
    if (attempt.count >= 10 || this.global.count >= 50) throw failure('尝试次数过多，请稍后再试。', 429, Math.max(1, Math.ceil(((attempt.count >= 10 ? attempt : this.global).until - now) / 1000)));
    attempt.count++; this.global.count++;
  }
  async login(password: unknown, res: ServerResponse, secure: boolean) {
    if (!this.key) throw failure('Password protection is disabled.', 404);
    if (typeof password !== 'string' || Buffer.byteLength(password) > 1024 || !timingSafeEqual(await derive(password, this.salt), this.key)) throw failure('密码不正确。', 401);
    for (const [key, session] of this.sessions) if (session.expiresAt <= this.now()) this.revoke(key);
    // Bound memory even if an authorized client repeatedly logs in without logging out.
    if (this.sessions.size >= 100) this.revoke(this.sessions.keys().next().value!);
    const token = randomBytes(32).toString('base64url'), key = digest(token);
    const timer = setTimeout(() => this.revoke(key), this.ttl); timer.unref();
    this.sessions.set(key, { expiresAt: this.now() + this.ttl, revoked: false, close: new Set(), timer });
    res.setHeader('set-cookie', this.cookie(token, secure, Math.floor(this.ttl / 1000)));
  }
  logout(req: IncomingMessage, res: ServerResponse, secure: boolean) { const token = this.token(req); if (token) this.revoke(digest(token)); res.setHeader('set-cookie', this.cookie('', secure, 0)); }
  private cookie(token: string, secure: boolean, age: number) { return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`; }
  track(session: PasswordSession, response: ServerResponse) {
    // Logout can happen while a request is awaiting native startup, before it subscribes to a stream.
    if (session.revoked || session.expiresAt <= this.now()) { response.end(); return false; }
    const close = () => { if (!response.writableEnded) response.end(); }; session.close.add(close);
    const cleanup = () => { session.close.delete(close); }; response.once('close', cleanup); response.once('finish', cleanup);
    return true;
  }
  dispose() { for (const key of this.sessions.keys()) this.revoke(key); this.attempts.clear(); }
}
