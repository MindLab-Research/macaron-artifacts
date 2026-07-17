// MCP server management, backed by Claude Code's own ~/.claude.json.
//
// macaron IS a Claude Code WebUI, so we read/write the canonical config the
// CLI already uses (top-level `mcpServers`) rather than inventing a private
// store — same file the status-bar counter reads in session-store.ts. Each
// mutation is a read-modify-write that touches only `mcpServers` and leaves
// every other key (projects, OAuth session, caches) untouched.
//
// Secrets: entries carry live tokens inside env/headers, so the public
// projection masks those VALUES to '' while keeping their KEYS — the UI can
// show which env vars a server needs without leaking them. On write, a blank
// value means "keep the stored secret" (same idiom as the provider apiKey).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HOME } from '../config.js';

export type McpTransport = 'stdio' | 'http' | 'sse';

// Raw entry as stored in ~/.claude.json. Extra keys (e.g. alwaysLoad) are
// preserved across edits via the index signature.
type RawMcpServer = {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  [k: string]: unknown;
};

// Client-facing projection. env/headers values are masked (keys kept).
export type PublicMcpServer = {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  alwaysLoad?: boolean;
};

export type McpServerInput = {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
};

export type MutationError = { status: number; message: string };

const CLAUDE_JSON = path.join(HOME, '.claude.json');
const NAME_RE = /^[a-zA-Z0-9_.-]+$/;

// Returns the whole parsed config plus a shallow copy of its mcpServers map.
// A MISSING file is fine — start fresh. A file that EXISTS but fails to parse
// is NOT swallowed: we let JSON.parse throw so a mutation never overwrites a
// real (but momentarily unreadable) config with an empty one.
async function readRaw(): Promise<{ full: Record<string, unknown>; servers: Record<string, RawMcpServer> }> {
  let raw: string;
  try {
    raw = await fs.readFile(CLAUDE_JSON, 'utf8');
  } catch (e) {
    // Only a MISSING file is safe to treat as empty. A file that EXISTS but is
    // unreadable (EACCES, EIO, EMFILE/ENFILE on a busy host) must rethrow —
    // returning {} here would make the next writeServers clobber the whole
    // ~/.claude.json (OAuth, projects, history) with { mcpServers: {…} }.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return { full: {}, servers: {} };
  }
  const full = JSON.parse(raw) as Record<string, unknown>;
  const m = full.mcpServers;
  const servers = m && typeof m === 'object' && !Array.isArray(m) ? { ...(m as Record<string, RawMcpServer>) } : {};
  return { full, servers };
}

async function writeServers(full: Record<string, unknown>, servers: Record<string, RawMcpServer>): Promise<void> {
  full.mcpServers = servers;
  await fs.mkdir(path.dirname(CLAUDE_JSON), { recursive: true });
  // Atomic replace: write to a temp file in the same dir, then rename over the
  // target (atomic on POSIX). A plain truncate-then-write would leave the whole
  // multi-key ~/.claude.json truncated if the process dies mid-write.
  const tmp = `${CLAUDE_JSON}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(full, null, 2), 'utf8');
  await fs.rename(tmp, CLAUDE_JSON);
}

function inferTransport(s: RawMcpServer): McpTransport {
  // Trust the explicit `type` first. Inferring from `command` before checking
  // `type` would misread an http/sse entry that carries a stray `command` as
  // stdio — toPublic then hides its url and the next save deletes it.
  const t = String(s.type || '').toLowerCase();
  if (t === 'stdio' || t === 'http' || t === 'sse') return t;
  if (s.command) return 'stdio';
  return 'http';
}

function maskMap(m: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const k of Object.keys(m)) out[k] = '';
  return Object.keys(out).length ? out : undefined;
}

function toPublic(name: string, s: RawMcpServer): PublicMcpServer {
  const transport = inferTransport(s);
  const p: PublicMcpServer = { name, transport };
  if (transport === 'stdio') {
    if (s.command) p.command = s.command;
    if (Array.isArray(s.args)) p.args = s.args.map(String);
    const env = maskMap(s.env);
    if (env) p.env = env;
  } else {
    if (s.url) p.url = s.url;
    const headers = maskMap(s.headers);
    if (headers) p.headers = headers;
  }
  if (s.alwaysLoad === true) p.alwaysLoad = true;
  return p;
}

// Blank incoming value = keep the stored secret; non-blank overwrites; keys
// absent from `incoming` are dropped (that's how the UI removes an env var).
function mergeSecrets(
  incoming: Record<string, string> | undefined,
  existing: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!incoming) return undefined;
  const out: Record<string, string> = {};
  for (const [rawKey, v] of Object.entries(incoming)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (v && v.length > 0) out[key] = v;
    else if (existing && typeof existing[key] === 'string') out[key] = existing[key]!;
  }
  return Object.keys(out).length ? out : undefined;
}

// Build the entry to store, starting from the existing raw one so unknown
// keys survive. Transport-specific fields are reset first so switching
// stdio<->http can't leave a stale command/url behind.
function buildRaw(input: McpServerInput, base: RawMcpServer | undefined): RawMcpServer {
  const next: RawMcpServer = { ...(base || {}) };
  delete next.command; delete next.args; delete next.env; delete next.url; delete next.headers;
  if (input.transport === 'stdio') {
    next.type = 'stdio';
    next.command = (input.command || '').trim();
    const args = (input.args || []).map(String).map((a) => a.trim()).filter((a) => a.length > 0);
    if (args.length) next.args = args;
    const env = mergeSecrets(input.env, base?.env);
    if (env) next.env = env;
  } else {
    next.type = input.transport;
    next.url = (input.url || '').trim();
    const headers = mergeSecrets(input.headers, base?.headers);
    if (headers) next.headers = headers;
  }
  return next;
}

function validate(input: McpServerInput): MutationError | null {
  const name = (input.name || '').trim();
  if (!name) return { status: 400, message: 'name required' };
  if (!NAME_RE.test(name)) return { status: 400, message: 'name may contain only letters, digits, dot, dash, underscore' };
  if (input.transport === 'stdio') {
    if (!(input.command || '').trim()) return { status: 400, message: 'command required for stdio' };
  } else if (input.transport === 'http' || input.transport === 'sse') {
    if (!(input.url || '').trim()) return { status: 400, message: `url required for ${input.transport}` };
  } else {
    return { status: 400, message: 'invalid transport' };
  }
  return null;
}

export async function readPublicMcpServers(): Promise<PublicMcpServer[]> {
  const { servers } = await readRaw();
  return Object.entries(servers)
    .map(([name, s]) => toPublic(name, s))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function addServer(input: McpServerInput): Promise<{ ok: true } | MutationError> {
  const err = validate(input);
  if (err) return err;
  const name = input.name.trim();
  const { full, servers } = await readRaw();
  if (servers[name]) return { status: 409, message: `server "${name}" already exists` };
  servers[name] = buildRaw(input, undefined);
  await writeServers(full, servers);
  return { ok: true };
}

export async function updateServer(oldName: string, input: McpServerInput): Promise<{ ok: true } | MutationError> {
  const err = validate(input);
  if (err) return err;
  const newName = input.name.trim();
  const { full, servers } = await readRaw();
  const base = servers[oldName];
  if (!base) return { status: 404, message: `server "${oldName}" not found` };
  if (newName !== oldName && servers[newName]) return { status: 409, message: `server "${newName}" already exists` };
  const next = buildRaw(input, base);
  if (newName !== oldName) delete servers[oldName];
  servers[newName] = next;
  await writeServers(full, servers);
  return { ok: true };
}

export async function deleteServer(name: string): Promise<{ ok: true } | MutationError> {
  const { full, servers } = await readRaw();
  if (!servers[name]) return { status: 404, message: `server "${name}" not found` };
  delete servers[name];
  await writeServers(full, servers);
  return { ok: true };
}
