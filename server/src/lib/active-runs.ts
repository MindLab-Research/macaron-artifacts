// In-memory registry of the AbortController for each in-flight SDK stream,
// keyed by sessionId. The /stop route looks up the controller and fires
// `.abort()`, which the SDK subprocess honours by killing the child and
// throwing on the async iterator — the surrounding SSE handler then closes.

const runs = new Map<string, AbortController>();

export function registerRun(sid: string, ac: AbortController): void {
  runs.set(sid, ac);
}

export function claimRun(sid: string, ac: AbortController): boolean {
  if (runs.has(sid)) return false;
  runs.set(sid, ac);
  return true;
}

export function abortRun(sid: string): boolean {
  const ac = runs.get(sid);
  if (!ac || ac.signal.aborted) return false;
  // Abort requests cancellation but deliberately keeps the claim. Releasing
  // it before the SDK iterator settles could let a second resume start while
  // the old runner is still unwinding and able to write to the same transcript
  // or live entry. The owning route releases the claim at terminal cleanup.
  ac.abort();
  return true;
}

export function endRun(sid: string, owner?: AbortController): boolean {
  if (owner && runs.get(sid) !== owner) return false;
  return runs.delete(sid);
}
