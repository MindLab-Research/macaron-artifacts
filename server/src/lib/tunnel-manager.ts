// Zero-config remote access. Starts one tunnel at a time by spawning an
// installed CLI (`cloudflared` or `ngrok`) that publishes the local server
// port on a public URL. State is held in-process; the WebUI polls it via
// /api/tunnel/status. Modeled on nadeko0/claude-code-studio's tunnel-manager
// (spawn → parse stdout/stderr for the URL → in-memory state) plus
// vibetunnel's common-path binary probe.

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { TunnelProvider, TunnelState } from '@macaron/shared';
import { PORT } from '../config.js';
import { ensureArmedToken, getArmedToken } from './auth.js';

type ProviderSpec = {
  bin: string;
  // Quick, account-less tunnels where possible. `localhost` (not 127.0.0.1)
  // matches what the CLIs expect and keeps the banner URL stable.
  args: (port: number) => string[];
  // Pull the public URL out of accumulated stdout+stderr, or null if not
  // ready yet. cloudflared prints to stderr, ngrok to stdout — we feed both.
  extract: (acc: string) => string | null;
  installUrl: string;
};

const SPECS: Record<TunnelProvider, ProviderSpec> = {
  cloudflared: {
    bin: 'cloudflared',
    args: (port) => ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'],
    extract: (acc) => acc.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)?.[0] ?? null,
    installUrl: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
  },
  ngrok: {
    bin: 'ngrok',
    // Structured JSON logs on stdout — the pretty TTY output isn't parseable.
    args: (port) => ['http', String(port), '--log', 'stdout', '--log-format', 'json'],
    extract: (acc) => {
      for (const line of acc.split('\n')) {
        const s = line.trim();
        if (!s.startsWith('{')) continue;
        try {
          const log = JSON.parse(s) as { msg?: string; url?: string };
          if (log.msg === 'started tunnel' && log.url?.startsWith('https://')) return log.url;
        } catch { /* partial line — wait for more */ }
      }
      return null;
    },
    installUrl: 'https://ngrok.com/download',
  },
};

const START_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 5_000;

// Resolve a CLI even when it isn't on the server's PATH (GUI-launched apps
// often have a minimal PATH). Try PATH first, then common install dirs.
function resolveBinary(bin: string): string | null {
  try {
    return execFileSync('which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch { /* not on PATH */ }
  const home = os.homedir();
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(home, '.local/bin'), path.join(home, 'bin')]) {
    const p = path.join(dir, bin);
    if (existsSync(p)) return p;
  }
  return null;
}

let proc: ChildProcess | null = null;
// Internal state omits `token` — it's derived from the live armed token only
// when running, so getTunnelState() is the single place that attaches it.
type TunnelCore = Omit<TunnelState, 'token'>;
let state: TunnelCore = { status: 'stopped', provider: null, url: null, startedAt: null, error: null };

export function getTunnelState(): TunnelState {
  // Surface the armed token alongside a live URL so the UI can build a ?token=
  // share link that unlocks on first load; nothing to share when not running.
  return { ...state, token: state.status === 'running' ? getArmedToken() || null : null };
}

export function startTunnel(provider: TunnelProvider): Promise<TunnelState> {
  if (state.status === 'starting' || state.status === 'running') {
    return Promise.reject(new Error('a tunnel is already active — stop it first'));
  }
  const spec = SPECS[provider];
  const binPath = resolveBinary(spec.bin);
  if (!binPath) {
    state = { status: 'error', provider, url: null, startedAt: null, error: `${spec.bin} not found — install it (${spec.installUrl}) and retry` };
    return Promise.reject(new Error(state.error!));
  }

  // Arm a token before the port is exposed: a tunnel forwards public traffic to
  // localhost, which the auth hook would otherwise wave through as loopback, so
  // exposing an auth-off server would be wide open. ensureArmedToken generates
  // one only if none is configured; an existing (env / auto-gen) token is kept.
  ensureArmedToken();

  state = { status: 'starting', provider, url: null, startedAt: Date.now(), error: null };

  return new Promise<TunnelState>((resolve, reject) => {
    // Drop CLAUDECODE so the tunnel CLI doesn't think it's inside a Claude
    // Code sandbox; keep the rest of the env for PATH/HOME.
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const child = spawn(binPath, spec.args(PORT), { stdio: ['ignore', 'pipe', 'pipe'], env });
    proc = child;

    let acc = '';
    let settled = false;
    const timer = setTimeout(() => {
      // Stale guard (matches onChunk/exit): a stop or provider-switch nulls or
      // replaces proc, so an old start's timer must not clobber the current state.
      if (settled || proc !== child) return;
      settled = true;
      state = { status: 'error', provider, url: null, startedAt: null, error: `timed out waiting for ${spec.bin} to publish a URL` };
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new Error(state.error!));
    }, START_TIMEOUT_MS);
    // Don't let the startup timer keep the event loop alive during a
    // shutdown-mid-start (the SIGTERM→SIGKILL kill timer is unref'd for the
    // same reason).
    timer.unref();

    const onChunk = (buf: Buffer) => {
      if (settled || proc !== child) return;
      acc += buf.toString();
      const url = spec.extract(acc);
      if (!url) return;
      settled = true;
      clearTimeout(timer);
      state = { status: 'running', provider, url, startedAt: state.startedAt, error: null };
      resolve(getTunnelState());
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (proc === child) proc = null;
      state = { status: 'error', provider, url: null, startedAt: null, error: err.message };
      reject(err);
    });

    // Process died. If it happened after we were live, reflect that; the stale
    // guard keeps a killed-old-proc from clobbering a freshly started one.
    child.on('exit', (code, signal) => {
      if (proc !== child) return;
      proc = null;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        state = { status: 'error', provider, url: null, startedAt: null, error: `${spec.bin} exited (code ${code ?? 'null'}) before publishing a URL` };
        reject(new Error(state.error!));
        return;
      }
      // Post-settle exit. A user stop nulls `proc` before killing, so this branch
      // only runs when a still-owned child dies on its own. If the tunnel was
      // live and the CLI crashed, surface `error` (with the code/signal) instead
      // of masking it as a user-initiated `stopped`.
      if (state.status !== 'running') return;
      const how = signal ? `signal ${signal}` : `code ${code ?? 'null'}`;
      state = code === 0
        ? { status: 'stopped', provider: null, url: null, startedAt: null, error: null }
        : { status: 'error', provider, url: null, startedAt: null, error: `${spec.bin} tunnel exited unexpectedly (${how})` };
    });
  });
}

export function stopTunnel(): TunnelState {
  shutdownTunnel();
  state = { status: 'stopped', provider: null, url: null, startedAt: null, error: null };
  return getTunnelState();
}

export function shutdownTunnel(): void {
  const child = proc;
  proc = null;
  if (child) {
    try {
      child.kill('SIGTERM');
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, KILL_GRACE_MS);
      t.unref();
    } catch { /* already gone */ }
  }
}

// Never let a public tunnel outlive the server.
process.once('exit', () => { try { proc?.kill('SIGKILL'); } catch { /* noop */ } });
