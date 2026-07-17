import os from 'node:os';
import path from 'node:path';

export const PORT = parseInt(process.env.MACARON_PORT || '7878', 10);
export const HOST = process.env.MACARON_HOST || '127.0.0.1';

// Optional shared token that gates the API when the server is reachable from
// the network. Empty = auth off (the default for loopback-only binds).
export const AUTH_TOKEN = process.env.MACARON_AUTH_TOKEN || '';

// The official Macaron-hosted WebUI origins. These are vetted first-party sites
// that serve the exact same web/ build and only ever drive the server through
// the same token-gated API — so opting them in (via --allow-hosted or
// MACARON_ALLOW_HOSTED=1) is the safe, no-typo way to enable hosted mode.
// Enabling any origin arms an auth token (resolveToken), so the API is never
// left unauthenticated cross-origin.
export const OFFICIAL_HOSTED_ORIGINS = ['https://artifacts.macaron.im'];

// Merge the explicit allowlist (env / CLI) with the official origins when the
// user opts into hosted mode. Additive union, deduped, order-stable: explicit
// origins first, then any official ones not already listed. `*` in the explicit
// list still wins (reflect-any, dev only).
export function buildAllowedOrigins(explicit: string[], allowHosted: boolean): string[] {
  const out = [...new Set(explicit)];
  if (allowHosted) for (const o of OFFICIAL_HOSTED_ORIGINS) if (!out.includes(o)) out.push(o);
  return out;
}

// Origins allowed to reach the API cross-origin (comma-separated). Empty = the
// UI is same-origin (the default) and no CORS headers are emitted. Set this to
// the hosted docs origin (e.g. https://artifacts.macaron.im) to let a hosted
// WebUI drive this server, or set MACARON_ALLOW_HOSTED=1 to pull in the official
// origins above. Use `*` to reflect any origin (dev only — combined with a
// bearer/`?token=` secret, but still avoid on shared machines).
const EXPLICIT_ORIGINS = (process.env.MACARON_ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const ALLOWED_ORIGINS = buildAllowedOrigins(EXPLICIT_ORIGINS, /^(1|true|yes)$/i.test(process.env.MACARON_ALLOW_HOSTED || ''));

// Optional env overrides. Users normally set the Macaron API key via the
// Settings page (persisted to ~/.claude/macaron-config.json); env vars still
// win for ops-driven / one-shot invocations.
export const MACARON_API_BASE = process.env.MACARON_API_BASE || '';
export const MACARON_API_KEY = process.env.MACARON_API_KEY || '';
export const MACARON_MODEL = process.env.MACARON_MODEL || '';

export const HOME = os.homedir();
export const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');
// Custom subagent definitions live here as `<name>.md` (YAML frontmatter +
// system-prompt body). Claude Code scans this dir at user scope.
export const CLAUDE_AGENTS = path.join(HOME, '.claude', 'agents');
// User-scoped saved prompts / custom slash commands. One `.md` per command,
// invoked as `/<filename-stem>` in any session.
export const CLAUDE_COMMANDS = path.join(HOME, '.claude', 'commands');
export const CODEX_SESSIONS = path.join(HOME, '.codex', 'sessions');
// Kimi Code data root ($KIMI_CODE_HOME or ~/.kimi-code). Sessions live in
// sessions/<workDirKey>/<sessionId>/ with a session_index.jsonl fast path.
export const KIMI_HOME = process.env.KIMI_CODE_HOME || path.join(HOME, '.kimi-code');
export const KIMI_SESSIONS = path.join(KIMI_HOME, 'sessions');

// Root for the "New Project" wizard — freshly created dirs and `git clone`
// targets land here. Overridable so ops can point it at a mounted volume.
export const PROJECTS_ROOT = process.env.MACARON_PROJECTS_ROOT || path.join(HOME, 'macaron-projects');

// Web root (repo's web/ dir). Same hop from compiled location in both dev (tsx src/) and prod (node dist/).
// src/config.ts → ../../web  (and after build: dist/config.js → ../../web)
export const WEB_ROOT = path.resolve(import.meta.dirname, '..', '..', 'web');

// Web assets (Vite build output). When running in dev (vite dev server on :5173 with proxy), this directory may not exist — @fastify/static handles that.
export const WEB_DIST = path.join(WEB_ROOT, 'dist');
