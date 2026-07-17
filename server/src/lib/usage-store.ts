import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  AnalyticsResponse,
  UsageTotals,
  UsageDaily,
  UsageByModel,
  UsageBySession,
} from '@macaron/shared';
import { CLAUDE_PROJECTS } from '../config.js';
import { rateFor, costOf } from './pricing.js';
import { readSessionSummary } from './session-store.js';

// One parsed assistant-message usage row. `ts` is epoch ms (from the jsonl's
// ISO timestamp); everything downstream buckets on it.
type UsageRow = {
  ts: number;
  model: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  ephemeral5m: number;
  ephemeral1h: number;
};

type FileUsage = { project: string; sessionId: string; rows: UsageRow[] };
type CacheEntry = { mtimeMs: number; size: number; usage: FileUsage };

// File-keyed (mtime,size) cache — same pattern session-store uses for
// summaries. A full cold scan of thousands of transcripts is disk-bound and
// slow; caching means we only re-parse a jsonl when Claude appends to it.
const usageCache = new Map<string, CacheEntry>();

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

async function parseFileUsage(filePath: string, project: string, sessionId: string): Promise<FileUsage> {
  const raw = await fs.readFile(filePath, 'utf8');
  const rows: UsageRow[] = [];
  const seenMessageIds = new Set<string>();
  for (const line of raw.split('\n')) {
    // Cheap pre-filter — most lines have no usage; skip the JSON.parse.
    if (!line.includes('"usage"')) continue;
    try {
      const o = JSON.parse(line);
      if (o.type !== 'assistant') continue;
      const u = o.message?.usage;
      if (!u) continue;
      const messageId = typeof o.message?.id === 'string' ? o.message.id : '';
      if (messageId) {
        // Claude CLI writes one jsonl row per content block but repeats the same turn-level usage and message.id on each row.
        if (seenMessageIds.has(messageId)) continue;
        seenMessageIds.add(messageId);
      }
      const cc = u.cache_creation || {};
      rows.push({
        ts: o.timestamp ? Date.parse(o.timestamp) : 0,
        model: o.message?.model || '',
        input: Number(u.input_tokens) || 0,
        output: Number(u.output_tokens) || 0,
        cacheWrite: Number(u.cache_creation_input_tokens) || 0,
        cacheRead: Number(u.cache_read_input_tokens) || 0,
        ephemeral5m: Number(cc.ephemeral_5m_input_tokens) || 0,
        ephemeral1h: Number(cc.ephemeral_1h_input_tokens) || 0,
      });
    } catch {
      /* skip malformed line */
    }
  }
  return { project, sessionId, rows };
}

async function readFileUsage(filePath: string, project: string, sessionId: string): Promise<FileUsage | null> {
  let st;
  try {
    st = await fs.stat(filePath);
  } catch {
    return null;
  }
  const cached = usageCache.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.usage;
  let usage;
  try {
    usage = await parseFileUsage(filePath, project, sessionId);
  } catch {
    return null;
  }
  usageCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, usage });
  return usage;
}

function localDateKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const emptyTotals = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  costUsd: 0,
  messageCount: 0,
  sessionCount: 0,
});

export async function collectUsage(sinceMs: number, untilMs: number): Promise<AnalyticsResponse> {
  let projects;
  try {
    projects = await fs.readdir(CLAUDE_PROJECTS, { withFileTypes: true });
  } catch {
    return { window: '', since: sinceMs, until: untilMs, sinceDate: localDateKey(sinceMs), untilDate: localDateKey(untilMs), totals: emptyTotals(), daily: [], byModel: [], bySession: [] };
  }

  // Enumerate every transcript, but prune files whose mtime predates the
  // window: since every message is older than its file's mtime, a file last
  // touched before `since` cannot contain any in-window rows. This is what
  // bounds a cold scan to the recent slice instead of the whole history.
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
        if (!f.endsWith('.jsonl')) continue;
        const file = path.join(projDir, f);
        try {
          const st = await fs.stat(file);
          if (st.mtimeMs < sinceMs) continue;
        } catch {
          continue;
        }
        targets.push({ project: p.name, file, sid: f.slice(0, -6) });
      }
    },
  );

  const files = await mapPool(targets, 32, (t) => readFileUsage(t.file, t.project, t.sid));

  const totals = emptyTotals();
  const daily = new Map<string, UsageDaily>();
  const byModel = new Map<string, UsageByModel>();
  const bySession = new Map<string, UsageBySession>();

  for (const fu of files) {
    if (!fu) continue;
    for (const r of fu.rows) {
      if (!Number.isFinite(r.ts) || r.ts <= 0 || r.ts < sinceMs || r.ts > untilMs) continue;
      const { rates, known } = rateFor(r.model);
      const cost = costOf(
        { input: r.input, output: r.output, cacheWrite: r.cacheWrite, cacheRead: r.cacheRead, ephemeral5m: r.ephemeral5m, ephemeral1h: r.ephemeral1h },
        rates,
      );

      totals.inputTokens += r.input;
      totals.outputTokens += r.output;
      totals.cacheWriteTokens += r.cacheWrite;
      totals.cacheReadTokens += r.cacheRead;
      totals.costUsd += cost;
      totals.messageCount += 1;

      const day = localDateKey(r.ts);
      let d = daily.get(day);
      if (!d) {
        d = { date: day, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: 0, messageCount: 0 };
        daily.set(day, d);
      }
      d.inputTokens += r.input; d.outputTokens += r.output; d.cacheWriteTokens += r.cacheWrite; d.cacheReadTokens += r.cacheRead; d.costUsd += cost; d.messageCount += 1;

      const mKey = r.model || 'unknown';
      let m = byModel.get(mKey);
      if (!m) {
        m = { model: mKey, known, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: 0, messageCount: 0 };
        byModel.set(mKey, m);
      }
      m.inputTokens += r.input; m.outputTokens += r.output; m.cacheWriteTokens += r.cacheWrite; m.cacheReadTokens += r.cacheRead; m.costUsd += cost; m.messageCount += 1;

      const sKey = `${fu.project}/${fu.sessionId}`;
      let s = bySession.get(sKey);
      if (!s) {
        s = { project: fu.project, sessionId: fu.sessionId, preview: '', model: r.model, lastActivity: r.ts, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, messageCount: 0 };
        bySession.set(sKey, s);
      }
      s.inputTokens += r.input; s.outputTokens += r.output; s.cacheWriteTokens += r.cacheWrite; s.cacheReadTokens += r.cacheRead; s.costUsd += cost; s.messageCount += 1;
      if (r.ts > s.lastActivity) { s.lastActivity = r.ts; if (r.model) s.model = r.model; }
    }
  }
  totals.sessionCount = bySession.size;

  // Attach a first-user-text preview to each session via the summary cache
  // session-store already warms (cheap — reads only the file head, cached).
  const sessionArr = Array.from(bySession.values());
  await mapPool(sessionArr, 32, async (s) => {
    try {
      const meta = await readSessionSummary(path.join(CLAUDE_PROJECTS, s.project, `${s.sessionId}.jsonl`));
      if (meta?.firstUserText) s.preview = meta.firstUserText.slice(0, 160);
    } catch {
      /* preview is best-effort */
    }
  });

  const dailyArr = Array.from(daily.values()).sort((a, b) => a.date.localeCompare(b.date));
  const byModelArr = Array.from(byModel.values()).sort((a, b) => b.costUsd - a.costUsd);
  sessionArr.sort((a, b) => b.costUsd - a.costUsd);

  return { window: '', since: sinceMs, until: untilMs, sinceDate: localDateKey(sinceMs), untilDate: localDateKey(untilMs), totals, daily: dailyArr, byModel: byModelArr, bySession: sessionArr };
}
