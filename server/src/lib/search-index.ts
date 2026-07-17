// Opt-in SQLite mirror of the parsed session JSONL, used purely as a derived
// full-text index. The JSONL under ~/.claude/projects stays the source of
// truth; this DB is a rebuildable cache that powers cross-session search.
//
// Driver: Node's built-in `node:sqlite` when the current runtime supports it.
// It is lazy-loaded so unsupported runtimes can still boot and simply report
// search unavailable instead of crashing during module evaluation.
//
// On by default; set MACARON_SEARCH=0 (or false/off) to disable — the index is
// then never opened and the /api/search routes report it as disabled.

import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { SearchHit } from '@macaron/shared';
import { CLAUDE_PROJECTS, HOME } from '../config.js';

export const DB_PATH = path.join(HOME, '.claude', 'macaron-index.db');
const SEARCH_HL_OPEN = '\u0002';
const SEARCH_HL_CLOSE = '\u0003';
const FTS_SCHEMA_VERSION = 2;
const require = createRequire(import.meta.url);

type DatabaseSync = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
};

export function isSearchEnabled(): boolean {
  const v = (process.env.MACARON_SEARCH || '').toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no' && sqliteModule() !== null;
}

export type { SearchHit };

let db: DatabaseSync | null = null;
let sqlite: { DatabaseSync: new (path: string) => DatabaseSync } | null | undefined;

function sqliteModule(): { DatabaseSync: new (path: string) => DatabaseSync } | null {
  if (sqlite !== undefined) return sqlite;
  try {
    sqlite = require('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };
  } catch {
    sqlite = null;
  }
  return sqlite;
}

function getDb(): DatabaseSync {
  if (db) return db;
  const mod = sqliteModule();
  if (!mod) throw new Error('node:sqlite is unavailable in this runtime');
  const d = new mod.DatabaseSync(DB_PATH);
  d.exec('PRAGMA journal_mode = WAL');
  d.exec('PRAGMA synchronous = NORMAL');
  d.exec('PRAGMA busy_timeout = 5000');
  d.exec(`
    CREATE TABLE IF NOT EXISTS files (
      file_path  TEXT PRIMARY KEY,
      project    TEXT NOT NULL,
      session_id TEXT NOT NULL,
      cwd        TEXT NOT NULL DEFAULT '',
      mtime_ms   INTEGER NOT NULL,
      size       INTEGER NOT NULL,
      msg_count  INTEGER NOT NULL DEFAULT 0,
      fts_version INTEGER NOT NULL DEFAULT 0,
      indexed_at INTEGER NOT NULL
    )
  `);
  try {
    d.exec('ALTER TABLE files ADD COLUMN fts_version INTEGER NOT NULL DEFAULT 0');
  } catch {
    /* already migrated */
  }
  const version = (d.prepare('SELECT fts_version FROM files LIMIT 1').get() as { fts_version: number } | undefined)?.fts_version ?? FTS_SCHEMA_VERSION;
  if (version < FTS_SCHEMA_VERSION) {
    d.exec('DROP TABLE IF EXISTS messages');
    d.exec('UPDATE files SET fts_version = 0');
  }
  // text is column 0 so snippet(messages, 0, …) targets it. Everything else is
  // UNINDEXED — stored for retrieval but kept out of the full-text index.
  d.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(
      text,
      file_path UNINDEXED,
      project UNINDEXED,
      session_id UNINDEXED,
      cwd UNINDEXED,
      role UNINDEXED,
      uuid UNINDEXED,
      ts UNINDEXED,
      tokenize = 'unicode61'
    )
  `);
  db = d;
  return d;
}

// One parsed JSONL line → the searchable text for it, or null to skip. Mirrors
// the block handling in session-store.readSessionMessages but keeps only the
// high-signal prose: user/assistant text + thinking, and post-/compact
// summaries. Tool payloads are large and noisy, so they're intentionally left
// out of the index.
function lineToText(o: {
  type?: string;
  isMeta?: boolean;
  summary?: string;
  message?: { content?: unknown };
}): { role: string; text: string } | null {
  if (o.type === 'summary' && typeof o.summary === 'string') {
    return { role: 'summary', text: o.summary };
  }
  if (o.type !== 'user' && o.type !== 'assistant') return null;
  if (o.isMeta) return null;
  const c = o.message?.content;
  let text = '';
  if (typeof c === 'string') {
    text = c;
  } else if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const b of c as Array<{ type?: string; text?: string; thinking?: string }>) {
      if (b.type === 'text' && b.text) parts.push(b.text);
      else if (b.type === 'thinking' && b.thinking) parts.push(b.thinking);
    }
    text = parts.join('\n');
  }
  text = text.trim();
  if (!text) return null;
  // Drop the synthetic tool_result / system reminder envelopes the CLI writes
  // as "user" turns — they'd pollute results with machinery, not conversation.
  if (text.startsWith('<') && text.includes('tool_result')) return null;
  // Cap a single message so one giant paste can't bloat the index.
  return { role: o.type, text: text.length > 100_000 ? text.slice(0, 100_000) : text };
}

// Re-index a single JSONL file iff its mtime or size changed since last sync.
// Returns true when it did work. All writes for a file run in one transaction.
async function syncFile(filePath: string, project: string, sessionId: string): Promise<boolean> {
  let st;
  try {
    st = await fs.stat(filePath);
  } catch {
    return false;
  }
  const d = getDb();
  const prev = d
    .prepare('SELECT mtime_ms, size, fts_version FROM files WHERE file_path = ?')
    .get(filePath) as { mtime_ms: number; size: number; fts_version: number } | undefined;
  if (prev && prev.mtime_ms === st.mtimeMs && prev.size === st.size && prev.fts_version === FTS_SCHEMA_VERSION) return false;

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return false;
  }

  const rows: Array<{ text: string; role: string; uuid: string; ts: string }> = [];
  let cwd = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (!cwd && o.cwd) cwd = o.cwd;
      const parsed = lineToText(o);
      if (parsed) rows.push({ ...parsed, uuid: o.uuid || '', ts: o.timestamp || '' });
    } catch {
      /* skip malformed line */
    }
  }

  const insert = d.prepare(
    'INSERT INTO messages(text, file_path, project, session_id, cwd, role, uuid, ts) VALUES (?,?,?,?,?,?,?,?)',
  );
  d.exec('BEGIN');
  try {
    d.prepare('DELETE FROM messages WHERE file_path = ?').run(filePath);
    for (const r of rows) {
      insert.run(r.text, filePath, project, sessionId, cwd, r.role, r.uuid, r.ts);
    }
    d.prepare(
      `INSERT INTO files(file_path, project, session_id, cwd, mtime_ms, size, msg_count, fts_version, indexed_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(file_path) DO UPDATE SET
         project=excluded.project, session_id=excluded.session_id, cwd=excluded.cwd,
         mtime_ms=excluded.mtime_ms, size=excluded.size, msg_count=excluded.msg_count, fts_version=excluded.fts_version,
         indexed_at=excluded.indexed_at`,
    ).run(filePath, project, sessionId, cwd, st.mtimeMs, st.size, rows.length, FTS_SCHEMA_VERSION, Date.now());
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return true;
}

let syncing: Promise<{ scanned: number; changed: number }> | null = null;
let lastSyncAt = 0;

// Walk ~/.claude/projects, incrementally re-index every session file, and prune
// index rows for files that no longer exist on disk. Coalesces concurrent
// callers onto one in-flight run.
export function syncAll(): Promise<{ scanned: number; changed: number }> {
  if (syncing) return syncing;
  const run = (async () => {
    let scanned = 0;
    let changed = 0;
    const seen = new Set<string>();
    let projects: import('node:fs').Dirent[] = [];
    try {
      projects = await fs.readdir(CLAUDE_PROJECTS, { withFileTypes: true });
    } catch {
      /* no projects dir yet */
    }
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const projDir = path.join(CLAUDE_PROJECTS, p.name);
      let files: string[] = [];
      try {
        files = await fs.readdir(projDir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const filePath = path.join(projDir, f);
        seen.add(filePath);
        scanned++;
        try {
          if (await syncFile(filePath, p.name, f.slice(0, -6))) changed++;
        } catch {
          /* skip a file that failed to index; others still proceed */
        }
      }
    }
    // Prune rows for deleted sessions so search never returns dead links.
    try {
      const d = getDb();
      const known = d.prepare('SELECT file_path FROM files').all() as Array<{ file_path: string }>;
      for (const { file_path } of known) {
        if (seen.has(file_path)) continue;
        d.exec('BEGIN');
        try {
          d.prepare('DELETE FROM messages WHERE file_path = ?').run(file_path);
          d.prepare('DELETE FROM files WHERE file_path = ?').run(file_path);
          d.exec('COMMIT');
          changed++;
        } catch {
          d.exec('ROLLBACK');
        }
      }
    } catch {
      /* index unavailable — nothing to prune */
    }
    lastSyncAt = Date.now();
    return { scanned, changed };
  })();
  syncing = run;
  run.finally(() => {
    syncing = null;
  });
  return run;
}

// Cheap freshness pass before a search: only re-walks if the last sync is older
// than the throttle window, so rapid keystroke searches don't re-stat the whole
// tree every time.
const SYNC_THROTTLE_MS = 3000;
async function maybeSync(): Promise<void> {
  if (Date.now() - lastSyncAt < SYNC_THROTTLE_MS) return;
  try {
    await syncAll();
  } catch {
    /* stale index is better than a failed search */
  }
}

// Turn free-text into an FTS5 MATCH expression: each word becomes a quoted
// term (quoting neutralizes FTS operators), and the final word gets a `*` so
// the query matches as-you-type prefixes. Returns null when there's nothing to
// search for.
function toMatchExpr(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens
    .map((t, i) => {
      const quoted = `"${t.replace(/"/g, '""')}"`;
      return i === tokens.length - 1 ? `${quoted} *` : quoted;
    })
    .join(' ');
}

export async function search(query: string, limit = 40): Promise<SearchHit[]> {
  const expr = toMatchExpr(query);
  if (!expr) return [];
  await maybeSync();
  const d = getDb();
  const capped = Math.min(Math.max(limit, 1), 100);
  const rows = d
    .prepare(
      `SELECT project, session_id, cwd, role, uuid, ts,
              snippet(messages, 0, ?, ?, '…', 12) AS snippet,
              bm25(messages) AS score
       FROM messages
       WHERE messages MATCH ?
       ORDER BY score
       LIMIT ?`,
    )
    .all(SEARCH_HL_OPEN, SEARCH_HL_CLOSE, expr, capped) as Array<{
    project: string;
    session_id: string;
    cwd: string;
    role: string;
    uuid: string;
    ts: string;
    snippet: string;
  }>;
  return rows.map((r) => ({
    project: r.project,
    sessionId: r.session_id,
    cwd: r.cwd,
    role: r.role,
    uuid: r.uuid,
    ts: r.ts,
    snippet: r.snippet,
  }));
}

export function indexStats(): { files: number; messages: number; lastSyncAt: number } {
  try {
    const d = getDb();
    const files = (d.prepare('SELECT count(*) AS c FROM files').get() as { c: number }).c;
    const messages = (d.prepare('SELECT count(*) AS c FROM messages').get() as { c: number }).c;
    return { files, messages, lastSyncAt };
  } catch {
    return { files: 0, messages: 0, lastSyncAt };
  }
}
