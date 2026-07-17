// The scheduler tick. One setInterval scans warmed schedules; any active one
// whose nextRunAt has arrived (and isn't already in-flight) fires a fresh
// session — the same spawn "+ New Session" does, minus the client SSE reply.

import { promises as fs } from 'node:fs';
import { runClaude } from './claude-runner.js';
import { runCodex } from './codex-runner.js';
import { runKimi } from './kimi-runner.js';
import { getActiveProviderEnv } from './settings-store.js';
import { liveStart, livePush, liveEnd } from './live-registry.js';
import { registerRun, endRun } from './active-runs.js';
import { listSchedules, recordRun } from './schedule-store.js';
import type { RunnerEvent } from './claude-runner.js';
import type { Schedule } from '@macaron/shared';

const TICK_MS = 30_000;

// Schedules mid-fire — guards against a slow session still running when the
// next tick arrives (and against run-now racing the tick).
const inFlight = new Set<string>();

type FireResult = { ok: boolean; sessionId: string | null; error?: string };

// Drain a runner stream to completion. For claude, mirror the live-registry
// wiring from routes/workspaces.ts so an open Session tile streams the fired
// run live and it lands where the WebUI reads sessions. Returns the sid plus
// whether the runner actually completed cleanly.
async function drain(schedule: Schedule, stream: AsyncGenerator<RunnerEvent>): Promise<FireResult> {
  const isClaude = schedule.engine === 'claude';
  // Capture before starting the async iterator. A cold runner can take long
  // enough to emit its session id that Date.now() at liveStart would be newer
  // than the JSONL user record and make snapshot reconciliation impossible.
  const startedAt = Date.now();
  let sid = '';
  let ok = true;
  let sawDone = false;
  try {
    for await (const ev of stream) {
      if (ev.kind === 'session' && !sid) {
        sid = ev.sessionId;
        if (isClaude) {
          liveStart(sid, { cwd: schedule.cwd, startedAt });
          livePush(sid, { type: 'user-text', text: schedule.prompt });
        }
      } else if (!isClaude) {
        if (ev.kind === 'error') ok = false;
        else if (ev.kind === 'done') {
          sawDone = true;
          if (ev.exitCode !== 0) ok = false;
          if (sid) endRun(sid);
        }
        continue; // codex rollout file is picked up on refresh — no live wiring
      } else if (ev.kind === 'delta') {
        if (sid) livePush(sid, { type: 'delta', text: ev.text });
      } else if (ev.kind === 'tool_use') {
        if (sid) livePush(sid, { type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
      } else if (ev.kind === 'tool_input_delta') {
        if (sid) livePush(sid, { type: 'tool_input_delta', id: ev.id, name: ev.name, partial_json: ev.partial_json, accumulated: ev.accumulated });
      } else if (ev.kind === 'tool_input_done') {
        if (sid) livePush(sid, { type: 'tool_input_done', id: ev.id, name: ev.name, final_json: ev.final_json });
      } else if (ev.kind === 'tool_result') {
        if (sid) livePush(sid, { type: 'tool_result', tool_use_id: ev.tool_use_id, text: ev.text, isError: ev.isError });
      } else if (ev.kind === 'usage') {
        if (sid) livePush(sid, { type: 'usage', outputTokens: ev.outputTokens, thinkingTokens: ev.thinkingTokens });
      } else if (ev.kind === 'message') {
        if (sid) livePush(sid, { type: 'event', event: 'system', subtype: ev.subtype });
      } else if (ev.kind === 'error') {
        ok = false;
        if (sid) livePush(sid, { type: 'error', error: ev.error });
      } else if (ev.kind === 'done') {
        sawDone = true;
        if (ev.exitCode !== 0) ok = false;
        if (sid) { liveEnd(sid, { type: 'done', exitCode: ev.exitCode }); endRun(sid); }
      }
    }
  } finally {
    if (sid && !sawDone) {
      if (isClaude) liveEnd(sid, { type: 'done', exitCode: -1 });
      endRun(sid);
    }
  }
  return { ok, sessionId: sid || null };
}

// Fire a schedule now. Shared by the tick and the run-now route. Never throws —
// records lastStatus and advances nextRunAt via recordRun.
export async function fireSchedule(schedule: Schedule, advance = true): Promise<FireResult> {
  if (inFlight.has(schedule.id)) return { ok: false, sessionId: null, error: 'schedule already running' };
  inFlight.add(schedule.id);
  try {
    // cwd may have been deleted/renamed since the schedule was created.
    const st = await fs.stat(schedule.cwd).catch(() => null);
    if (!st?.isDirectory()) {
      await recordRun(schedule.id, { sessionId: null, ok: false }, advance);
      return { ok: false, sessionId: null, error: 'working directory not found' };
    }
    const abortController = new AbortController();
    let stream: AsyncGenerator<RunnerEvent>;
    if (schedule.engine === 'codex') {
      stream = runCodex({ prompt: schedule.prompt, cwd: schedule.cwd, abortController });
    } else if (schedule.engine === 'kimi') {
      // Headless like codex: `kimi -p` runs with auto permission and writes
      // its own wire.jsonl, which the store picks up on the next refresh.
      stream = runKimi({ prompt: schedule.prompt, cwd: schedule.cwd, abortController });
    } else {
      const { model, env } = getActiveProviderEnv();
      // A scheduled fire is headless — no client is attached to answer the
      // canUseTool permission prompts a 'default'-mode run raises, so it would
      // park forever on the first tool call. Force bypassPermissions so tools
      // auto-approve (claude-runner wires allowDangerouslySkipPermissions off
      // this). Matches unattended semantics; codex already runs with approval
      // policy 'never'.
      stream = runClaude({ prompt: schedule.prompt, cwd: schedule.cwd, model, envOverrides: env, abortController, permissionMode: 'bypassPermissions' });
    }
    // Register the run under the sid as soon as we learn it so /stop can abort.
    const wrapped = (async function* () {
      for await (const ev of stream) {
        if (ev.kind === 'session') registerRun(ev.sessionId, abortController);
        yield ev;
      }
    })();
    const result = await drain(schedule, wrapped);
    await recordRun(schedule.id, { sessionId: result.sessionId, ok: result.ok }, advance);
    return result;
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[scheduler] fire failed for ${schedule.id}:`, msg);
    // recordRun can itself throw (e.g. computeNextRun on a corrupt stored
    // pattern). The tick calls this as `void fireSchedule(s)`, so a throw here
    // would be an unhandled rejection and, with no process-level handler, exit
    // the server. Swallow it so fireSchedule honours its "never throws" contract.
    await recordRun(schedule.id, { sessionId: null, ok: false }, advance).catch((e) =>
      console.error(`[scheduler] recordRun failed for ${schedule.id}:`, (e as Error).message),
    );
    return { ok: false, sessionId: null, error: msg };
  } finally {
    inFlight.delete(schedule.id);
  }
}

function tick(): void {
  const now = Date.now();
  for (const s of listSchedules()) {
    if (s.status !== 'active' || s.nextRunAt === null || s.nextRunAt > now) continue;
    if (inFlight.has(s.id)) continue;
    void fireSchedule(s); // fire-and-forget; never blocks the tick
  }
}

export function startScheduler(): void {
  setInterval(tick, TICK_MS).unref(); // unref so the timer never keeps the process alive on its own
}
