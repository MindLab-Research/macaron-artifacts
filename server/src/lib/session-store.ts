import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import ignore from 'ignore';
import type {
  Block,
  ContextBreakdown,
  Message,
  MessageSearchHit,
  SessionDetail,
  SessionListItem,
  SubagentInfo,
  UsageSnapshot,
  Workspace,
} from '@macaron/shared';
import { CLAUDE_PROJECTS, HOME } from '../config.js';
import { deleteLabel, getLabels } from './label-store.js';

export function basename(p: string): string {
  if (!p) return '';
  return p.split('/').filter(Boolean).pop() || p;
}

export function decodeClaudeProjectName(encoded: string): string {
  return encoded.replace(/^-/, '/').replace(/-/g, '/');
}

type SessionSummary = {
  firstUserText: string;
  // Claude-native session title, resolved with the same priority the CLI and
  // the official Agent SDK use for `/resume`'s list: customTitle > aiTitle >
  // lastPrompt > summary. Empty when the session has none of them (falls back
  // to firstUserText downstream). See resolveNativeTitle.
  title: string;
  cwd: string;
  gitBranch: string;
  headLines: number;
  truncated: boolean;
  mtime: number;
  size: number;
};

// Native title fields harvested from a session's jsonl, last-occurrence-wins
// per field (the CLI appends `ai-title` / `custom-title` / updates lastPrompt
// over the session's life). Kept as a struct so the head scan and the tail
// scan can feed the same resolver.
export type NativeTitleFields = {
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
  summary?: string;
};

// Priority mirrors the official Agent SDK's list_sessions:
// customTitle > aiTitle > lastPrompt > summary. firstPrompt is intentionally
// NOT here — callers use it as the preview-level fallback instead.
export function resolveNativeTitle(f: NativeTitleFields): string {
  return f.customTitle || f.aiTitle || f.lastPrompt || f.summary || '';
}

// Fold one parsed jsonl entry into the accumulating title fields. Last write
// wins, so calling this over head then tail yields the CLI's tail-preferred,
// head-fallback semantics for free.
function foldTitleFields(o: Record<string, unknown>, f: NativeTitleFields): void {
  // A custom-title record with an empty string is an explicit clear tombstone
  // (macaron's blank rename): reset the override so it falls back to ai-title.
  if (o.type === 'custom-title' && typeof o.customTitle === 'string') f.customTitle = o.customTitle.trim() || undefined;
  else if (o.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle.trim()) f.aiTitle = o.aiTitle.trim();
  if (typeof o.lastPrompt === 'string' && o.lastPrompt.trim()) f.lastPrompt = o.lastPrompt.trim();
  if (o.type === 'summary' && typeof o.summary === 'string' && o.summary.trim()) f.summary = o.summary.trim();
}

type CacheEntry = { mtimeMs: number; size: number; summary: SessionSummary };

// File-keyed mtime cache so we only re-parse jsonl when claude appends to it.
const summaryCache = new Map<string, CacheEntry>();
const HEAD_BYTES = 96 * 1024;
const CWD_TAIL_BYTES = 64 * 1024;

export async function deleteSession(project: string, sid: string): Promise<void> {
  const filePath = path.join(CLAUDE_PROJECTS, project, `${sid}.jsonl`);
  await fs.unlink(filePath);
  summaryCache.delete(filePath);
}

// Rename a Claude session the native way: append a `custom-title` record to the
// jsonl, exactly like the CLI's `/rename` does. Because resolveNativeTitle reads
// customTitle first and foldTitleFields is last-write-wins, this both surfaces
// in macaron's sidebar and is what `claude --resume` shows — the two stay in
// sync instead of diverging into a separate label sidecar. A blank name appends
// an empty customTitle, which clears the override (falling back to ai-title /
// preview). Returns the trimmed title.
export async function renameSession(project: string, sid: string, name: string): Promise<string> {
  const base = path.resolve(CLAUDE_PROJECTS);
  const filePath = path.resolve(base, project, `${sid}.jsonl`);
  if (!(filePath + path.sep).startsWith(base + path.sep)) throw new Error('invalid session path');
  const st = await fs.stat(filePath);
  if (!st.isFile()) throw new Error('session is not a file');
  const trimmed = name.trim();
  const record = JSON.stringify({ type: 'custom-title', customTitle: trimmed, sessionId: sid, timestamp: new Date().toISOString() }) + '\n';
  await fs.appendFile(filePath, record, 'utf8');
  summaryCache.delete(filePath);
  // Older Macaron releases stored labels in a sidecar. Remove that legacy
  // override once the user renames natively, otherwise it would keep winning
  // in the UI even though Claude now has a newer custom-title record.
  await deleteLabel(sid);
  return trimmed;
}

// Duplicate a claude session as a brand-new sid so both can be resumed
// independently. We rewrite every `sessionId` field inside the jsonl to the
// new uuid — otherwise `claude --resume` would still find the original when
// scanning by embedded sessionId.
export async function duplicateSession(
  project: string,
  sid: string,
): Promise<{ newSid: string }> {
  const srcPath = path.join(CLAUDE_PROJECTS, project, `${sid}.jsonl`);
  const raw = await fs.readFile(srcPath, 'utf8');
  const newSid = randomUUID();
  const destPath = path.join(CLAUDE_PROJECTS, project, `${newSid}.jsonl`);
  const outLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      outLines.push(line);
      continue;
    }
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (typeof o.sessionId === 'string') o.sessionId = newSid;
      outLines.push(JSON.stringify(o));
    } catch {
      outLines.push(line);
    }
  }
  let next = outLines.join('\n');
  if (!next.endsWith('\n')) next += '\n';
  // wx = fail if a file with this uuid already exists (astronomically rare)
  await fs.writeFile(destPath, next, { encoding: 'utf8', flag: 'wx' });
  return { newSid };
}

// Truncate a session at the message identified by `uuid` — the picked entry
// and everything after it are removed. The dropped tail is copied to a
// timestamped `.rewind-<ts>.jsonl.bak` sibling so users can recover it if
// they change their mind. Returns count of jsonl lines dropped.
export async function rewindSession(
  project: string,
  sid: string,
  uuid: string,
): Promise<{ dropped: number; backupPath: string }> {
  const filePath = path.join(CLAUDE_PROJECTS, project, `${sid}.jsonl`);
  const raw = await fs.readFile(filePath, 'utf8');
  const lines = raw.split('\n');
  let cutIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (o.uuid === uuid) {
        cutIdx = i;
        break;
      }
    } catch {
      /* skip malformed */
    }
  }
  if (cutIdx < 0) {
    throw new Error(`uuid ${uuid} not found in session`);
  }
  const keptRaw = lines.slice(0, cutIdx).join('\n');
  const droppedRaw = lines.slice(cutIdx).join('\n');
  const ts = Date.now();
  const backupPath = filePath.replace(/\.jsonl$/, `.rewind-${ts}.jsonl.bak`);
  await fs.writeFile(backupPath, droppedRaw, 'utf8');
  const keptFinal = keptRaw.endsWith('\n') ? keptRaw : keptRaw + '\n';
  await fs.writeFile(filePath, keptFinal, 'utf8');
  summaryCache.delete(filePath);
  const dropped = droppedRaw.split('\n').filter((l) => l.trim()).length;
  return { dropped, backupPath };
}

// Fork = the non-destructive twin of rewind. Copy every line *before* the
// picked message (identified by `uuid`) into a brand-new sid, rewriting the
// embedded `sessionId` the way duplicateSession does so `claude --resume
// <newSid>` replays only that prefix. The original session is left untouched,
// so the user keeps the old branch and gets a fresh one to explore a different
// path from that point. Cut is exclusive: the picked message is not copied, so
// the fork opens ready for a new alternative to that turn.
export async function forkSession(
  project: string,
  sid: string,
  uuid: string,
): Promise<{ newSid: string; kept: number }> {
  const srcPath = path.join(CLAUDE_PROJECTS, project, `${sid}.jsonl`);
  const raw = await fs.readFile(srcPath, 'utf8');
  const lines = raw.split('\n');
  let cutIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      if (JSON.parse(line).uuid === uuid) {
        cutIdx = i;
        break;
      }
    } catch {
      /* skip malformed */
    }
  }
  if (cutIdx < 0) {
    throw new Error(`uuid ${uuid} not found in session`);
  }
  const newSid = randomUUID();
  const destPath = path.join(CLAUDE_PROJECTS, project, `${newSid}.jsonl`);
  const outLines: string[] = [];
  for (const line of lines.slice(0, cutIdx)) {
    if (!line.trim()) {
      outLines.push(line);
      continue;
    }
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (typeof o.sessionId === 'string') o.sessionId = newSid;
      outLines.push(JSON.stringify(o));
    } catch {
      outLines.push(line);
    }
  }
  if (!outLines.some((l) => l.trim())) {
    throw new Error('nothing to fork before the first message');
  }
  let next = outLines.join('\n');
  if (next && !next.endsWith('\n')) next += '\n';
  // wx = fail if a file with this uuid already exists (astronomically rare)
  await fs.writeFile(destPath, next, { encoding: 'utf8', flag: 'wx' });
  return { newSid, kept: outLines.filter((l) => l.trim()).length };
}

// Compact = replace the transcript up to now with a single `type: "summary"`
// line generated by an LLM. The original jsonl is backed up to
// `.pre-compact-<ts>.jsonl.bak`. Metadata lines (anything before the first
// user/assistant message) are preserved so cwd/gitBranch still resolves.
export async function writeCompactedSession(
  project: string,
  sid: string,
  summary: string,
): Promise<{ backupPath: string; kept: number }> {
  const filePath = path.join(CLAUDE_PROJECTS, project, `${sid}.jsonl`);
  const raw = await fs.readFile(filePath, 'utf8');
  const lines = raw.split('\n');
  const preamble: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      preamble.push(line);
      continue;
    }
    try {
      const o = JSON.parse(t);
      if (o.type === 'user' || o.type === 'assistant' || o.type === 'summary') break;
      preamble.push(line);
    } catch {
      preamble.push(line);
    }
  }
  const ts = Date.now();
  const backupPath = filePath.replace(/\.jsonl$/, `.pre-compact-${ts}.jsonl.bak`);
  await fs.writeFile(backupPath, raw, 'utf8');
  const summaryLine =
    JSON.stringify({
      type: 'summary',
      summary,
      timestamp: new Date().toISOString(),
      uuid: `compact-${ts}`,
    }) + '\n';
  const nextRaw =
    (preamble.length > 0 ? preamble.join('\n').replace(/\n+$/, '') + '\n' : '') + summaryLine;
  await fs.writeFile(filePath, nextRaw, 'utf8');
  summaryCache.delete(filePath);
  return { backupPath, kept: preamble.filter((l) => l.trim()).length };
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function readSessionSummary(filePath: string): Promise<SessionSummary | null> {
  let st;
  try {
    st = await fs.stat(filePath);
  } catch {
    return null;
  }

  const cached = summaryCache.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.summary;
  }

  const summary: SessionSummary = {
    firstUserText: '',
    title: '',
    cwd: '',
    gitBranch: '',
    headLines: 0,
    truncated: st.size > HEAD_BYTES,
    mtime: st.mtimeMs,
    size: st.size,
  };

  // Native title fields, folded head-first then tail-last so the tail's
  // freshest ai-title/custom-title/lastPrompt win over any head occurrence.
  const titleFields: NativeTitleFields = {};

  try {
    const fh = await fs.open(filePath, 'r');
    try {
      const len = Math.min(st.size, HEAD_BYTES);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, 0);
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      const upto = summary.truncated ? lines.length - 1 : lines.length;
      for (let i = 0; i < upto; i++) {
        const line = lines[i]!;
        if (!line.trim()) continue;
        summary.headLines++;
        try {
          const o = JSON.parse(line);
          foldTitleFields(o, titleFields);
          if (summary.firstUserText && summary.cwd) continue;
          if (!summary.cwd && o.cwd) summary.cwd = o.cwd;
          if (!summary.gitBranch && o.gitBranch) summary.gitBranch = o.gitBranch;
          if (!summary.firstUserText && o.type === 'user' && o.message?.content) {
            const c = o.message.content;
            const t =
              typeof c === 'string'
                ? c
                : Array.isArray(c)
                  ? c.map((b: { text?: string }) => b.text || '').join(' ')
                  : '';
            if (t && !t.startsWith('<') && !t.includes('tool_result')) summary.firstUserText = t;
          }
        } catch {
          /* skip malformed line */
        }
      }
    } finally {
      await fh.close();
    }
  } catch {
    /* swallow */
  }

  // cwd sits at the END of each jsonl line (after `message`), so a huge first
  // paste can push the head's only cwd-bearing line past HEAD_BYTES, truncating
  // it unparseably. The same cwd repeats on every later line, and trailing lines
  // are usually small — so on a truncated file, tail-scan to recover cwd and to
  // pick up the native title records (ai-title / custom-title / lastPrompt) the
  // CLI appends near the end, which live past HEAD_BYTES.
  if (summary.truncated) {
    try {
      const fh = await fs.open(filePath, 'r');
      try {
        const len = Math.min(st.size, CWD_TAIL_BYTES);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, st.size - len);
        const text = buf.toString('utf8');
        const lines = text.split('\n');
        // Drop the first slice — it's a partial line cut by the seek offset.
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i]!;
          if (!line.trim()) continue;
          try {
            const o = JSON.parse(line);
            foldTitleFields(o, titleFields);
            // Only backfill cwd from the tail when the head didn't find one.
            // The head's cwd is the session's REAL working directory. Later
            // lines can carry other cwds (a nested subagent / cwd-changing
            // hook), and overwriting on those was corrupting the workspace's
            // canonical cwd — resolveProjectCwd would then pick a sibling
            // subdirectory as the whole workspace's cwd on new-session POSTs.
            if (!summary.cwd && o.cwd) summary.cwd = o.cwd;
            if (!summary.gitBranch && o.gitBranch) summary.gitBranch = o.gitBranch;
          } catch {
            /* skip malformed line */
          }
        }
      } finally {
        await fh.close();
      }
    } catch {
      /* swallow — fall back to decoded project name upstream */
    }
  }

  summary.title = resolveNativeTitle(titleFields);
  summaryCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, summary });
  return summary;
}

// Directories never worth walking for an @-mention: build output, vendored
// deps, caches. Mirrors fafawlf/claude-code-web's skip-list. Applied on top
// of the repo's own `.gitignore` (loaded per root below).
const FILE_SEARCH_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.venv', 'venv',
  '__pycache__', '.pytest_cache', 'target', '.cache', '.turbo', '.parcel-cache',
  'coverage', '.idea', '.vscode',
]);
const FILE_SEARCH_MAX_DEPTH = 8;
const FILE_SEARCH_MAX_ENTRIES_PER_DIR = 2000;

// Best-effort `.gitignore` matcher for the repo root. Returns null when the
// file is absent/unreadable so the walk falls back to the skip-list alone.
// Only the root `.gitignore` is honoured (nested ones are ignored) — enough to
// keep top-level secrets like `.env` / `*.local` out of the picker per issue #20.
async function loadGitignore(root: string): Promise<ReturnType<typeof ignore> | null> {
  try {
    const raw = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    return ignore().add(raw);
  } catch {
    return null;
  }
}

async function walkFiles(root: string, dir: string, needle: string, out: string[], limit: number, depth: number, ig: ReturnType<typeof ignore> | null): Promise<void> {
  if (out.length >= limit || depth > FILE_SEARCH_MAX_DEPTH) return;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  if (entries.length > FILE_SEARCH_MAX_ENTRIES_PER_DIR) entries = entries.slice(0, FILE_SEARCH_MAX_ENTRIES_PER_DIR);
  for (const e of entries) {
    if (out.length >= limit) return;
    if (e.name.startsWith('.')) continue;
    if (FILE_SEARCH_SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (e.isDirectory()) {
      // `ignore` does no fs.stat — a trailing slash tells it `rel` is a dir, so
      // a `foo/` rule matches. Skipping here also prunes the whole subtree.
      if (ig?.ignores(rel + '/')) continue;
      await walkFiles(root, full, needle, out, limit, depth + 1, ig);
    } else if (e.isFile()) {
      if (ig?.ignores(rel)) continue;
      if (!needle || rel.toLowerCase().includes(needle)) out.push(rel);
    }
  }
}

// Recursively list files under a project's cwd, substring-matched on the
// repo-relative path. Skips build/vendor/cache dirs, dotfiles, and anything the
// repo's root `.gitignore` excludes; bounded by depth, per-dir entry count, and
// a hard result cap. Powers the composer's @-mention autocomplete.
export async function searchProjectFiles(project: string, needle: string, limit: number): Promise<{ cwd: string; results: string[] }> {
  const cwd = await resolveProjectCwd(project);
  if (!cwd) throw new Error('project not found');
  const results: string[] = [];
  const ig = await loadGitignore(cwd);
  await walkFiles(cwd, cwd, needle.toLowerCase(), results, Math.min(Math.max(limit, 1), 200), 0, ig);
  return { cwd, results };
}

// Resolve a session's working directory. The URL's `project` param might not
// match where the sid actually lives — claude-cli writes each session's jsonl
// under a project dir derived from the run's cwd, and a session started inside
// a subdirectory (e.g. `.../macaron-plugin/server`) lands in a different
// project dir than the workspace the WebUI thinks it's in. So: try the URL
// project first, then scan every project dir for `<sid>.jsonl`. Only fall back
// to the lossy decode of the URL project when nothing on disk matches — that
// decode turns each `-` into `/` and blows up any real path with a hyphen in
// it (`macaron-plugin` → `/macaron/plugin`), which spawn then rejects.
export async function resolveSessionCwd(project: string, sid: string): Promise<string> {
  const target = `${sid}.jsonl`;
  try {
    const primary = await readSessionSummary(path.join(CLAUDE_PROJECTS, project, target));
    if (primary?.cwd) return primary.cwd;
  } catch { /* fall through to cross-project scan */ }
  try {
    const projectDirs = await fs.readdir(CLAUDE_PROJECTS);
    for (const dir of projectDirs) {
      if (dir === project) continue; // already tried
      try {
        const meta = await readSessionSummary(path.join(CLAUDE_PROJECTS, dir, target));
        if (meta?.cwd) return meta.cwd;
      } catch { /* keep looking */ }
    }
  } catch { /* CLAUDE_PROJECTS unreadable — fall through */ }
  return decodeClaudeProjectName(project) || HOME || '/tmp';
}

// Resolve a claude project name to its working directory. Prefer the cwd
// embedded in an actual jsonl (a big first-line paste can push `cwd` past
// HEAD_BYTES, so decoding the name is the fallback). We only fall back to
// decodeClaudeProjectName when the project is actually registered under
// CLAUDE_PROJECTS: that decode (`-` -> `/`) is attacker-controllable, and
// callers that hand the result to the filesystem as a *root* (routes/files.ts)
// would otherwise turn the `:project` route param into an arbitrary-root
// traversal (e.g. `-etc` -> `/etc`). A trusted fallback lets callers preserve
// an exact cwd from the persisted New-Project registry instead of using the
// lossy decoded name when the project has no live session. Returns null for an
// unregistered project; callers must treat null as "unknown project" (404),
// never as a servable root.
export async function resolveProjectCwd(
  project: string,
  trustedFallback?: string,
): Promise<string | null> {
  let files: string[];
  const projDir = path.join(CLAUDE_PROJECTS, project);
  try {
    files = await fs.readdir(projDir);
  } catch {
    return null; // no such project dir — reject rather than decode a root
  }
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const meta = await readSessionSummary(path.join(projDir, f));
    if (!meta?.cwd) continue;
    // A worktree session records cwd = <repo>/.claude/worktrees/<name>; once
    // torn down the path is gone and spawning a shell / `git` there fails
    // (Node misreports a missing cwd as `spawn git ENOENT`). Skip stale cwds
    // and keep scanning for one that still exists.
    try {
      const st = await fs.stat(meta.cwd);
      if (st.isDirectory()) return meta.cwd;
    } catch { /* stale — keep scanning */ }
  }
  // Registered project whose cwd we couldn't recover from any jsonl: fall back
  // to the decoded name (the original big-paste behavior), now gated on the dir
  // existing above so an unregistered `-etc` can never reach this.
  return trustedFallback ?? decodeClaudeProjectName(project);
}

export async function listAllSessions(): Promise<SessionListItem[]> {
  let projects;
  try {
    projects = await fs.readdir(CLAUDE_PROJECTS, { withFileTypes: true });
  } catch {
    return [];
  }

  type Target = { project: string; file: string; sid: string };
  const targets: Target[] = [];
  await mapPool(
    projects.filter((p) => p.isDirectory()),
    16,
    async (p) => {
      const projDir = path.join(CLAUDE_PROJECTS, p.name);
      let files;
      try {
        files = await fs.readdir(projDir);
      } catch {
        return;
      }
      for (const f of files) {
        if (f.endsWith('.jsonl')) {
          targets.push({ project: p.name, file: path.join(projDir, f), sid: f.slice(0, -6) });
        }
      }
    },
  );

  const labels = await getLabels();
  const summaries = await mapPool(targets, 32, async (t): Promise<SessionListItem | null> => {
    const meta = await readSessionSummary(t.file);
    if (!meta) return null;
    const item: SessionListItem = {
      kind: 'claude',
      project: t.project,
      cwd: meta.cwd || decodeClaudeProjectName(t.project),
      gitBranch: meta.gitBranch || undefined,
      sessionId: t.sid,
      preview: (meta.firstUserText || '').slice(0, 220),
      label: labels[t.sid],
      title: meta.title || undefined,
      messageCount: meta.headLines,
      messageCountSuffix: meta.truncated ? '+' : '',
      mtime: meta.mtime,
      size: meta.size,
      resumeCommand: `claude --resume ${t.sid}`,
    };
    return item;
  });

  const out = summaries.filter((s): s is SessionListItem => s !== null);
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export function groupWorkspaces(sessions: SessionListItem[]): Workspace[] {
  // Group by `project` (the encoded repo root), not cwd: a session running in a
  // worktree has cwd = <repo>/.claude/worktrees/<name>, but its `project` is the
  // repo root — grouping by cwd would split one repo into N sidebar entries that
  // share a project id and collide on React keys.
  const byProject = new Map<string, Workspace>();
  for (const s of sessions) {
    const key = s.project;
    if (!byProject.has(key)) {
      byProject.set(key, {
        cwd: s.cwd,
        project: s.project,
        name: basename(s.cwd) || s.project,
        sessionCount: 0,
        lastActivity: 0,
        lastSessionId: '',
        lastPreview: '',
      });
    }
    const w = byProject.get(key)!;
    w.sessionCount++;
    if (s.mtime > w.lastActivity) {
      w.lastActivity = s.mtime;
      w.lastSessionId = s.sessionId;
      w.lastPreview = s.preview;
      w.project = s.project;
    }
  }
  const arr = Array.from(byProject.values());
  arr.sort((a, b) => b.lastActivity - a.lastActivity);
  return arr;
}

const SESSION_TAIL_BYTES = 8 * 1024 * 1024;

// Read a transcript file (tail-truncated if huge) and parse each jsonl line
// into the shared Message[] shape. Shared by the parent session reader and the
// subagent (child-session) reader — both persist the same block structure.
async function parseTranscriptFile(filePath: string): Promise<{
  messages: Message[];
  cwd: string;
  gitBranch: string;
  truncated: boolean;
  totalBytes: number;
  latestUsage: UsageSnapshot | undefined;
  msgChars: number;
  thinkChars: number;
  toolCallChars: number;
  toolResultChars: number;
}> {
  const st = await fs.stat(filePath);
  let raw: string;
  let truncated = false;
  if (st.size > SESSION_TAIL_BYTES) {
    truncated = true;
    const fh = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(SESSION_TAIL_BYTES);
      await fh.read(buf, 0, SESSION_TAIL_BYTES, st.size - SESSION_TAIL_BYTES);
      raw = buf.toString('utf8');
      const nl = raw.indexOf('\n');
      if (nl !== -1) raw = raw.slice(nl + 1);
    } finally {
      await fh.close();
    }
  } else {
    raw = await fs.readFile(filePath, 'utf8');
  }
  const messages: Message[] = [];
  let cwd = '';
  let gitBranch = '';
  // Track the most recent assistant message's usage — the WebUI's Context
  // bar shows this / model window. Cache tokens are counted toward the
  // window fill because they take up real slots.
  let latestUsage: UsageSnapshot | undefined;
  // Char tallies for the estimated context breakdown. Accumulated here (not
  // client-side) because tool_result text is truncated to 4000 chars below
  // before it ships — a big file read would otherwise be misattributed to
  // system overhead. char/4 ≈ tokens; only the ratios between segments matter.
  let msgChars = 0;
  let thinkChars = 0;
  let toolCallChars = 0;
  let toolResultChars = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (!cwd && o.cwd) cwd = o.cwd;
      if (!gitBranch && o.gitBranch) gitBranch = o.gitBranch;
      // Post-`/compact` recap the CLI writes as its own line. Show it as a
      // dim `※ recap: …` marker so users see where the conversation was
      // summarized instead of a silent gap.
      if (o.type === 'summary' && typeof o.summary === 'string') {
        messages.push({
          role: 'system',
          blocks: [{ kind: 'system_event', eventType: 'summary', text: o.summary }],
          timestamp: o.timestamp,
          uuid: o.uuid,
        });
        continue;
      }
      if (o.type === 'user' || o.type === 'assistant') {
        if (o.isMeta) {
          // Show the "Continue from where you left off." resume marker as a
          // dim `※` line — but *only* that. Other isMeta entries (image
          // cache pointers, tool_result echoes) are noise and stay hidden.
          if (o.type === 'user') {
            const c = o.message?.content;
            const t =
              typeof c === 'string'
                ? c
                : Array.isArray(c)
                  ? c
                      .map((b: { text?: string; type?: string }) =>
                        b.type === 'text' ? b.text || '' : '',
                      )
                      .join('')
                      .trim()
                  : '';
            if (/^Continue from where you left off/i.test(t)) {
              messages.push({
                role: 'system',
                blocks: [{ kind: 'system_event', eventType: 'resume', text: t }],
                timestamp: o.timestamp,
                uuid: o.uuid,
              });
            }
          }
          continue;
        }
        const blocks: Block[] = [];
        const c = o.message?.content;
        if (typeof c === 'string') {
          blocks.push({ kind: 'text', text: c });
          msgChars += c.length;
        } else if (Array.isArray(c)) {
          for (const b of c) {
            if (b.type === 'text' && b.text) { blocks.push({ kind: 'text', text: b.text }); msgChars += b.text.length; }
            else if (b.type === 'thinking' && b.thinking) {
              blocks.push({ kind: 'thinking', text: b.thinking });
              thinkChars += b.thinking.length;
            }
            else if (b.type === 'tool_use') {
              blocks.push({ kind: 'tool_use', id: b.id, name: b.name, input: b.input });
              toolCallChars += (b.name?.length || 0) + JSON.stringify(b.input ?? '').length;
            }
            else if (b.type === 'image' && b.source?.type === 'base64' && b.source?.data) {
              // The CLI persists user-attached images as base64 in the
              // jsonl. Ship them through so the WebUI can render inline
              // where they appear (preserving interleaved order with text).
              blocks.push({
                kind: 'image',
                mimeType: String(b.source.media_type || 'image/png'),
                data: String(b.source.data),
              });
            }
            else if (b.type === 'tool_result') {
              const t =
                typeof b.content === 'string'
                  ? b.content
                  : Array.isArray(b.content)
                    ? b.content.map((x: { text?: string }) => x.text || '').join('\n')
                    : '';
              blocks.push({ kind: 'tool_result', toolUseId: b.tool_use_id, text: t.slice(0, 4000), isError: b.is_error === true });
              toolResultChars += t.length;
            }
          }
        }
        messages.push({
          role: o.type,
          blocks,
          model: o.message?.model,
          timestamp: o.timestamp,
          uuid: o.uuid,
        });
        if (o.type === 'assistant' && o.message?.usage) {
          const u = o.message.usage;
          latestUsage = {
            inputTokens: Number(u.input_tokens) || 0,
            cacheCreationInputTokens: Number(u.cache_creation_input_tokens) || 0,
            cacheReadInputTokens: Number(u.cache_read_input_tokens) || 0,
            outputTokens: Number(u.output_tokens) || 0,
            model: o.message?.model,
          };
        }
      }
    } catch {
      /* skip malformed */
    }
  }
  return {
    messages,
    cwd,
    gitBranch,
    truncated,
    totalBytes: st.size,
    latestUsage,
    msgChars,
    thinkChars,
    toolCallChars,
    toolResultChars,
  };
}

export async function readSessionMessages(project: string, sid: string): Promise<SessionDetail> {
  const base = path.resolve(CLAUDE_PROJECTS);
  const filePath = path.resolve(base, project, `${sid}.jsonl`);
  // project/sid reach this sink from a JSON body via the share route, where a
  // `..` segment passes freely; assert the resolved path stays inside the
  // projects dir so a traversal can't read an arbitrary *.jsonl off disk.
  if (!(filePath + path.sep).startsWith(base + path.sep)) throw new Error('invalid session path');
  const {
    messages,
    cwd,
    gitBranch,
    truncated,
    totalBytes,
    latestUsage,
    msgChars,
    thinkChars,
    toolCallChars,
    toolResultChars,
  } =
    await parseTranscriptFile(filePath);

  const [claudeMdCount, mcpCount, labels] = await Promise.all([
    countClaudeMd(cwd),
    countMcpServers(),
    getLabels(),
  ]);

  // Reuse the (cached) head/tail scan for the native title so the session
  // header names the session the same way the sidebar does.
  const title = (await readSessionSummary(filePath))?.title || undefined;

  // Tail reads intentionally drop the oldest bytes, so the measured visible
  // transcript can no longer explain the aggregate usage. Keep the accurate
  // flat Context bar instead of showing a misleading all-system residual.
  const contextBreakdown = truncated ? undefined : buildContextBreakdown(latestUsage, {
    msgChars,
    thinkChars,
    toolCallChars,
    toolResultChars,
  });

  return {
    kind: 'claude',
    sessionId: sid,
    project,
    cwd,
    gitBranch,
    label: labels[sid],
    title,
    messages,
    truncated,
    totalBytes,
    latestUsage,
    contextBreakdown,
    claudeMdCount,
    mcpCount,
  };
}

// Extract plain text from a jsonl user/assistant line's message content,
// ignoring tool_use / tool_result / image blocks — noise for a text search.
function lineText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content as Array<{ type?: string; text?: string }>) {
    if (b?.type === 'text' && b.text) parts.push(b.text);
  }
  return parts.join(' ');
}

// Synthetic USER lines the session view hides (mirrors isNoisyUserText in
// web/src/views/Session.tsx): slash-command wrappers (`<command-name>`…),
// tool acknowledgements, and failure notices. Search must agree with the
// view on what a message is, or a hit deep-links to a line that is never
// rendered. Only applied to user lines — the view shows assistant text as-is.
function isNoisyUserText(t: string): boolean {
  if (!t) return true;
  if (t.startsWith('<')) return true;
  if (/^The file .* (has been (updated|created) successfully|file state is current)/.test(t)) return true;
  if (/^Tool .* failed/.test(t)) return true;
  return false;
}

// Whitespace-collapsed window around the first match so the palette row
// shows context, not the whole message.
function snippetAround(text: string, q: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const idx = flat.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return flat.slice(0, 180);
  const start = Math.max(0, idx - 60);
  const end = Math.min(flat.length, idx + q.length + 120);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

// Grep the claude transcripts for a substring, newest-first, stopping once
// `limit` hits accumulate. Recency-biased on purpose: a palette wants the
// last thing you touched, and bounding the scan to ~limit sessions keeps the
// cost sane over a large ~/.claude/projects tree.
export async function searchMessages(query: string, limit = 30): Promise<MessageSearchHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const ql = q.toLowerCase();
  const sessions = await listAllSessions(); // sorted mtime desc
  const hits: MessageSearchHit[] = [];
  for (const s of sessions) {
    if (hits.length >= limit) break;
    const filePath = path.join(CLAUDE_PROJECTS, s.project, `${s.sessionId}.jsonl`);
    let raw: string;
    try {
      const st = await fs.stat(filePath);
      if (st.size > SESSION_TAIL_BYTES) {
        const fh = await fs.open(filePath, 'r');
        try {
          const buf = Buffer.alloc(SESSION_TAIL_BYTES);
          await fh.read(buf, 0, SESSION_TAIL_BYTES, st.size - SESSION_TAIL_BYTES);
          raw = buf.toString('utf8');
          const nl = raw.indexOf('\n');
          if (nl !== -1) raw = raw.slice(nl + 1);
        } finally {
          await fh.close();
        }
      } else {
        raw = await fs.readFile(filePath, 'utf8');
      }
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if ((o.type !== 'user' && o.type !== 'assistant') || o.isMeta) continue;
        const text = lineText(o.message?.content);
        // Agree with the session view: it hides synthetic user lines
        // (isNoisyUserText). Without this, queries like `command` return
        // `<command-name>` hits that deep-link to a line the view never
        // renders — a dead link.
        if (o.type === 'user' && isNoisyUserText(text)) continue;
        // Match the DECODED text, not the escaped JSON bytes. A raw-byte grep
        // (the old pre-filter) silently dropped real matches: `C:\\Users`
        // (stored `C:\\\\Users`), any query containing a quote, and phrases
        // spanning two text blocks (joined by a space only after decode).
        if (!text || text.toLowerCase().indexOf(ql) < 0) continue;
        hits.push({
          project: s.project,
          sessionId: s.sessionId,
          uuid: typeof o.uuid === 'string' ? o.uuid : undefined,
          role: o.type,
          snippet: snippetAround(text, q),
          preview: s.preview,
          mtime: s.mtime,
        });
        // One hit per session: scroll-to-message is deferred, so `go()` drops
        // `uuid` and every hit from this file deep-links to the SAME place.
        // Extra rows would just crowd out other sessions. Revisit when the
        // message-level anchor lands and uuid is actually consumed.
        break;
      } catch {
        /* skip malformed */
      }
    }
  }
  return hits;
}

// Subagent (child session) transcripts live next to the parent as
// `<sid>/subagents/agent-<agentId>.jsonl`, each with an `agent-*.meta.json`
// sidecar linking it back to the parent's `Agent` tool_use via `toolUseId`.
export async function listSubagents(project: string, sid: string): Promise<SubagentInfo[]> {
  const dir = path.join(CLAUDE_PROJECTS, project, sid, 'subagents');
  let files;
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: SubagentInfo[] = [];
  for (const f of files) {
    if (!f.endsWith('.meta.json')) continue;
    try {
      const meta = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as Partial<SubagentInfo>;
      out.push({
        agentId: f.replace(/^agent-/, '').replace(/\.meta\.json$/, ''),
        agentType: meta.agentType || '',
        description: meta.description || '',
        toolUseId: meta.toolUseId || '',
      });
    } catch {
      /* skip malformed sidecar */
    }
  }
  return out;
}

export async function readSubagentMessages(
  project: string,
  sid: string,
  agentId: string,
): Promise<SessionDetail> {
  if (!/^[A-Za-z0-9_-]+$/.test(agentId)) throw new Error('invalid subagent id');
  const filePath = path.join(CLAUDE_PROJECTS, project, sid, 'subagents', `agent-${agentId}.jsonl`);
  const { messages, cwd, gitBranch, truncated, totalBytes, latestUsage } =
    await parseTranscriptFile(filePath);
  return {
    kind: 'claude',
    sessionId: agentId,
    project,
    cwd,
    gitBranch,
    messages,
    truncated,
    totalBytes,
    latestUsage,
  };
}

// Estimate the used-context split from transcript char tallies. `total` is the
// exact usage sum the Context bar shows; measured segments (~chars/4) are
// clamped to fit under it, and whatever's left is the un-itemizable system +
// tool-def + MCP + CLAUDE.md overhead. Returns undefined without a usage sample.
function buildContextBreakdown(
  usage: UsageSnapshot | undefined,
  chars: { msgChars: number; thinkChars: number; toolCallChars: number; toolResultChars: number },
): ContextBreakdown | undefined {
  if (!usage) return undefined;
  const total = usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens + usage.outputTokens;
  if (total <= 0) return undefined;
  const tok = (c: number) => Math.ceil(c / 4);
  let messages = tok(chars.msgChars);
  let thinking = tok(chars.thinkChars);
  let toolCalls = tok(chars.toolCallChars);
  let toolResults = tok(chars.toolResultChars);
  const measured = messages + thinking + toolCalls + toolResults;
  // Overshoot (rare: tail-truncated head, char/4 drift) → scale segments to fit.
  if (measured > total && measured > 0) {
    const k = total / measured;
    messages = Math.floor(messages * k);
    thinking = Math.floor(thinking * k);
    toolCalls = Math.floor(toolCalls * k);
    toolResults = Math.floor(toolResults * k);
  }
  const system = Math.max(0, total - (messages + thinking + toolCalls + toolResults));
  return { system, messages, toolCalls, toolResults, thinking, total };
}

async function countClaudeMd(cwd: string): Promise<number> {
  const candidates = [
    cwd ? path.join(cwd, 'CLAUDE.md') : '',
    cwd ? path.join(cwd, '.claude', 'CLAUDE.md') : '',
    path.join(HOME, '.claude', 'CLAUDE.md'),
  ].filter(Boolean);
  let n = 0;
  await Promise.all(
    candidates.map(async (p) => {
      try {
        await fs.access(p);
        n++;
      } catch {
        /* not present */
      }
    }),
  );
  return n;
}

async function countMcpServers(): Promise<number> {
  const paths = [
    path.join(HOME, '.claude', 'settings.json'),
    path.join(HOME, '.claude.json'),
  ];
  for (const p of paths) {
    try {
      const raw = await fs.readFile(p, 'utf8');
      const j = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      if (j.mcpServers && typeof j.mcpServers === 'object') {
        return Object.keys(j.mcpServers).length;
      }
    } catch {
      /* file missing or malformed — try next */
    }
  }
  return 0;
}
