import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { record, safeError } from './common.js';
import { tomlLiteral } from './codex-profile-toml.js';

export interface CodexConnection {
  notification?: (method: string, params: unknown) => void;
  serverRequest?: (method: string, params: unknown) => Promise<unknown>;
  failure?: (error: Error) => void;
  request(method: string, params: unknown): Promise<Record<string, unknown>>;
  notify(method: string, params: unknown): void;
  close(): Promise<void>;
}

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
export interface CodexRpcOptions { cwd?: string; env?: NodeJS.ProcessEnv; config?: Record<string, unknown>; secrets?: string[] }

export class CodexRpc implements CodexConnection {
  notification?: CodexConnection['notification'];
  serverRequest?: CodexConnection['serverRequest'];
  failure?: CodexConnection['failure'];
  private process: ChildProcessWithoutNullStreams;
  private requests = new Map<number, Pending>();
  private nextId = 0;
  private closing = false;
  private exited: Promise<void>;

  constructor(binary: string, private options: CodexRpcOptions = {}) {
    const overrides = Object.entries(options.config || {}).flatMap(([key, value]) => ['-c', `${key}=${tomlLiteral(value)}`]);
    this.process = spawn(binary, ['app-server', ...overrides], { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const lines = createInterface({ input: this.process.stdout });
    lines.on('line', (line) => {
      try { this.receive(JSON.parse(line)); } catch { this.fail(new Error('Codex returned an invalid protocol frame')); }
    });
    // Draining stderr avoids a blocked child without exposing inherited provider credentials in diagnostics.
    this.process.stderr.resume();
    this.process.stdin.on('error', (error) => { if (!this.closing) this.fail(new Error(safeError(error))); });
    this.exited = new Promise((resolve) => {
      this.process.once('close', (code) => { lines.close(); if (!this.closing) this.fail(new Error(`Codex app-server exited before the turn completed (${code ?? 'signal'})`)); resolve(); });
    });
    this.process.on('error', (error) => this.fail(new Error(safeError(error))));
  }

  request(method: string, params: unknown): Promise<Record<string, unknown>> {
    if (this.closing) return Promise.reject(new Error('Codex connection is closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error(`Codex ${method} timed out`)); }, 30_000);
      this.requests.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  notify(method: string, params: unknown) { this.write({ method, params }); }
  private write(frame: unknown) { if (!this.closing) this.process.stdin.write(`${JSON.stringify(frame)}\n`); }
  private receive(value: unknown) {
    const frame = record(value);
    if (typeof frame.method === 'string') {
      if (frame.id !== undefined) {
        const id = frame.id;
        void Promise.resolve().then(() => {
          if (!this.serverRequest) throw new Error('Unsupported Codex server request');
          return this.serverRequest(frame.method as string, frame.params);
        }).then((result) => this.write({ id, result }), () => this.write({ id, error: { code: -32601, message: 'This client cannot fulfill the request' } }));
      } else this.notification?.(frame.method, frame.params);
    } else if (typeof frame.id === 'number') {
      const pending = this.requests.get(frame.id);
      if (!pending) return;
      this.requests.delete(frame.id); clearTimeout(pending.timer);
      if (frame.error) {
        const message = (this.options.secrets || []).filter(Boolean).reduce((text, secret) => text.split(secret).join('[redacted]'), safeError(record(frame.error).message || 'Codex request failed'));
        pending.reject(new Error(message));
      }
      else pending.resolve(record(frame.result));
    }
  }
  private fail(error: Error) {
    for (const pending of this.requests.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.requests.clear();
    if (!this.closing) this.failure?.(error);
  }
  async close() {
    if (this.closing) return this.exited;
    this.closing = true;
    this.fail(new Error('Codex connection closed'));
    const kill = (signal: NodeJS.Signals) => {
      if (this.process.exitCode !== null || this.process.signalCode !== null) return;
      try { if (process.platform !== 'win32' && this.process.pid) process.kill(-this.process.pid, signal); else this.process.kill(signal); } catch { /* Process already exited. */ }
    };
    this.process.stdin.end();
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 1500);
    try { await this.exited; } finally { clearTimeout(timer); }
  }
}
