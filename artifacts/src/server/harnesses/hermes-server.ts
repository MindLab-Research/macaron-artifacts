import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { abortError, abortable, record, safeError, string } from './common.js';

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
export interface HermesRpcOptions { cwd: string; binary: string; profile?: string; token?: string; url?: string; secrets?: string[]; onFailure?: (error: Error) => void }
export interface HermesServerRequest { id: string; method: string; params: Record<string, unknown> }
type ServerRequestListener = (request: HermesServerRequest) => boolean | void;

/** JSON-RPC client for Hermes' public `serve` WebSocket gateway. It deliberately does not parse the TUI ANSI stream. */
export class HermesRpc {
  private process?: ChildProcessByStdio<null, Readable, Readable>;
  private socket?: WebSocket;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private closing = false;
  private readonly secrets: string[];
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readySettled = false;
  private connectTask?: Promise<void>;
  private managedToken?: string;
  private failed?: Error;
  private readonly eventListeners = new Set<(event: Record<string, unknown>) => void>();
  private readonly serverRequestListeners = new Set<ServerRequestListener>();

  constructor(private readonly options: HermesRpcOptions) {
    this.secrets = [options.token, ...(options.secrets || [])].filter((value): value is string => Boolean(value));
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
  }

  onEvent(listener: (event: Record<string, unknown>) => void) { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); }
  onServerRequest(listener: ServerRequestListener) { this.serverRequestListeners.add(listener); return () => this.serverRequestListeners.delete(listener); }
  replayOpenRequests(entries: unknown) {
    if (!Array.isArray(entries)) return 0;
    let count = 0;
    for (const entry of entries) {
      const request = serverRequestFrom(record(entry));
      if (request) { count++; this.dispatchServerRequest(request); }
    }
    return count;
  }
  respond(id: string, result: Record<string, unknown>) { this.send({ jsonrpc: '2.0', id, result }); }
  respondError(id: string, code: number, message: string) { this.send({ jsonrpc: '2.0', id, error: { code, message } }); }
  async connect(signal: AbortSignal): Promise<void> {
    if (this.failed) throw this.failed;
    if (this.connectTask) return abortable(this.connectTask, signal);
    this.connectTask = this.open(signal);
    void this.connectTask.catch(() => {});
    return abortable(this.connectTask, signal);
  }
  private async open(signal: AbortSignal): Promise<void> {
    let url = this.options.url || '';
    if (!url) url = await this.startServer(signal);
    const parsed = new URL(url);
    if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
    if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
    if (parsed.pathname === '/' || !parsed.pathname) parsed.pathname = '/api/ws';
    const token = this.options.token || this.managedToken;
    if (token && !parsed.searchParams.has('token')) parsed.searchParams.set('token', token);
    const socket = this.socket = new WebSocket(parsed);
    socket.addEventListener('message', event => this.receive(String(event.data)));
    socket.addEventListener('error', () => this.fail(new Error('Hermes gateway WebSocket failed')));
    socket.addEventListener('close', () => { if (!this.closing) this.fail(new Error('Hermes gateway WebSocket closed')); });
    await abortable(this.ready, signal);
  }
  async request(method: string, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    await this.connect(signal || AbortSignal.timeout(30_000));
    const id = ++this.nextId;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Hermes ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
    return signal ? abortable(promise, signal) : promise;
  }
  async close() {
    this.closing = true;
    this.fail(new Error('Hermes gateway closed'));
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close();
    if (this.process && this.process.exitCode === null) {
      this.process.kill('SIGTERM');
      const child = this.process;
      await new Promise<void>(resolve => { const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve(); }, 1500); child.once('close', () => { clearTimeout(timer); resolve(); }); });
    }
  }
  private async startServer(signal: AbortSignal): Promise<string> {
    const token = this.managedToken = this.options.token || randomBytes(32).toString('base64url');
    this.secrets.push(token);
    const args = [...(this.options.profile ? ['--profile', this.options.profile] : []), 'serve', '--host', '127.0.0.1', '--port', '0', '--isolated'];
    const env = { ...process.env, HERMES_DESKTOP: '1', HERMES_DASHBOARD_SESSION_TOKEN: token };
    const child = this.process = spawn(this.options.binary, args, { cwd: this.options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    child.stderr?.resume();
    if (!child.stdout) throw new Error('Hermes serve did not expose stdout');
    const lines = createInterface({ input: child.stdout });
    return abortable(new Promise<string>((resolve, reject) => {
      const onLine = (line: string) => { const url = parseHermesReadyLine(line); if (url) { lines.removeListener('line', onLine); resolve(url); } };
      lines.on('line', onLine);
      child.once('error', error => reject(error));
      child.once('close', code => reject(new Error(`Hermes serve exited before ready (${code ?? 'signal'})`)));
    }), signal);
  }
  private receive(raw: string) {
    let frame: Record<string, unknown>;
    try { frame = record(JSON.parse(raw)); } catch { this.fail(new Error('Hermes gateway returned invalid JSON')); return; }
    if (frame.method === 'event') {
      const params = record(frame.params);
      // Advertise once per connection, on the first ready: the gateway only routes server
      // requests to clients that opted in, and a reconnect arrives as a fresh HermesRpc.
      if (params.type === 'gateway.ready' && !this.readySettled) {
        this.readySettled = true; this.resolveReady();
        void this.request('client.capabilities', { server_requests: true }, undefined, 15_000).catch(() => {});
      }
      for (const listener of this.eventListeners) listener(params);
      return;
    }
    // Server-to-client requests carry a string id; this client's own requests always use a number.
    const serverRequest = serverRequestFrom(frame);
    if (serverRequest) { this.dispatchServerRequest(serverRequest); return; }
    if (frame.id === undefined || typeof frame.id !== 'number') return;
    const pending = this.pending.get(frame.id); if (!pending) return;
    this.pending.delete(frame.id); clearTimeout(pending.timer);
    if (frame.error) { const error = record(frame.error); pending.reject(new Error(this.redact(string(error.message) || 'Hermes request failed'))); }
    else pending.resolve(record(frame.result));
  }
  /** The first listener to claim the request owns answering it; an unclaimed request still needs a reply. */
  private dispatchServerRequest(request: HermesServerRequest) {
    for (const listener of this.serverRequestListeners) {
      try {
        if (listener(request) !== false) return;
      } catch {
        this.respondError(request.id, -32603, `server request handler crashed: ${request.method}`);
        return;
      }
    }
    this.respondError(request.id, -32601, `no handler for server request: ${request.method}`);
  }

  private send(frame: Record<string, unknown>) {
    if (!this.socket || this.socket.readyState >= WebSocket.CLOSING) return;
    try { this.socket.send(JSON.stringify(frame)); } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }
  private fail(error: Error) { if (this.failed) return; this.failed = error; for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); if (!this.readySettled) { this.readySettled = true; this.rejectReady(error); } if (!this.closing) { this.options.onFailure?.(error); for (const listener of this.eventListeners) listener({ type: 'connection.error', payload: { message: error.message } }); } }
  private redact(message: string) { return this.secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), safeError(message)); }
}

function serverRequestFrom(frame: Record<string, unknown>): HermesServerRequest | undefined {
  const { id, method } = frame;
  return typeof id === 'string' && typeof method === 'string' ? { id, method, params: record(frame.params) } : undefined;
}

export function rpcPayload(result: Record<string, unknown>): Record<string, unknown> { return record(result.result ?? result); }
export function parseHermesReadyLine(line: string): string | undefined { const match = line.match(/HERMES_BACKEND_READY\s+port=(\d+)/); return match ? `ws://127.0.0.1:${match[1]}/api/ws` : undefined; }
