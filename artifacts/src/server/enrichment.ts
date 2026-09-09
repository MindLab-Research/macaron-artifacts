import { Allow, parse } from 'partial-json';
import type { Session } from '../shared/types.js';
import type { HarnessAdapter, ResolvedProfile } from './harnesses/types.js';
import type { SessionStore } from './store.js';
import { safeProfileError } from './harnesses/common.js';

export const ENRICHMENT_PROMPT = '[ui4a-metadata] Return only JSON: {"suggestions":["next useful question","another useful next question"],"title":"short conversation title in the user’s language"}. Suggest at most three short follow-ups the user could send. Do not call tools or change files. Do not repeat answered questions.';
export function parseRecap(text: string): { title?: string; suggestions: string[] } {
  const start = text.indexOf('{');
  if (start < 0) return { suggestions: [] };
  try {
    // Partial containers are useful; incomplete strings must never become clickable suggestions.
    const value = parse(text.slice(start), Allow.OBJ | Allow.ARR) as { title?: unknown; suggestions?: unknown };
    return { title: typeof value.title === 'string' ? value.title.slice(0, 100) : undefined, suggestions: Array.isArray(value.suggestions) ? value.suggestions.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, 3) : [] };
  } catch { return { suggestions: [] }; }
}

export type Recap = ReturnType<typeof parseRecap>;
type Subscriber = { update: (recap: Recap) => void; close: () => void };
type MetadataTask = { controller: AbortController; subscribers: Set<Subscriber>; done: Promise<void> };

/** Enrichment has its own cancellation and transport; it never owns the main conversation. */
export class MetadataTasks {
  private tasks = new Map<string, MetadataTask>();
  private pending = new Set<Promise<void>>();
  constructor(private store: SessionStore) {}
  start(session: Session, adapter: HarnessAdapter, instructions: string, profile?: ResolvedProfile, model = session.model) {
    this.cancel(session.id);
    const controller = new AbortController(), subscribers = new Set<Subscriber>();
    const nativeId = session.nativeId, task: MetadataTask = { controller, subscribers, done: Promise.resolve() };
    this.tasks.set(session.id, task);
    task.done = (async () => {
      let text = '', previous = '';
      const startedAt = Date.now();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]);
      try {
        for await (const chunk of adapter.run({ nativeId, cwd: session.cwd, prompt: ENRICHMENT_PROMPT, model, profile, instructions, enrichment: true, signal, onNativeSession: () => {}, approve: async () => false })) {
          if (signal.aborted || this.tasks.get(session.id) !== task) break;
          if (chunk.type !== 'text-delta') continue;
          text += chunk.delta;
          const recap = parseRecap(text), serialized = JSON.stringify(recap);
          if (serialized === previous) continue;
          previous = serialized;
          if (recap.title) session.title = recap.title;
          session.suggestions = recap.suggestions;
          // Only complete strings reach this branch. Persist them before display so a
          // cancelled or timed-out fork cannot erase already visible metadata on restart.
          await this.store.save(session);
          if (signal.aborted || this.tasks.get(session.id) !== task) break;
          for (const subscriber of subscribers) { try { subscriber.update({ title: session.title, suggestions: session.suggestions }); } catch { subscribers.delete(subscriber); } }
        }
        if (!signal.aborted && this.tasks.get(session.id) === task) {
          const recap = parseRecap(text);
          if (!recap.title && !recap.suggestions.length) console.warn('[metadata]', { sessionId: session.id, harness: adapter.id, durationMs: Date.now() - startedAt, error: 'Metadata response contained no title or suggestions', outputChars: text.length });
        }
      } catch (error) {
        // Metadata remains optional, but a swallowed fork/transport error made production
        // failures indistinguishable from a model returning no suggestions. Never log its prompt or response.
        if (!controller.signal.aborted) console.warn('[metadata]', { sessionId: session.id, harness: adapter.id, durationMs: Date.now() - startedAt, error: signal.aborted ? 'Metadata generation timed out' : safeProfileError(error, profile) });
      }
      finally {
        for (const subscriber of subscribers) { try { subscriber.close(); } catch { /* Browser detached. */ } }
        subscribers.clear();
        if (this.tasks.get(session.id) === task) this.tasks.delete(session.id);
      }
    })();
    this.pending.add(task.done);
    void task.done.finally(() => this.pending.delete(task.done));
  }
  cancel(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) return Promise.resolve();
    this.tasks.delete(id); task.controller.abort();
    for (const subscriber of task.subscribers) { try { subscriber.close(); } catch { /* Browser detached. */ } }
    task.subscribers.clear();
    return task.done;
  }
  subscribe(session: Session, subscriber: Subscriber): () => void {
    subscriber.update({ title: session.title, suggestions: session.suggestions });
    const task = this.tasks.get(session.id);
    if (!task) { subscriber.close(); return () => {}; }
    task.subscribers.add(subscriber);
    return () => task.subscribers.delete(subscriber);
  }
  async close() { for (const id of [...this.tasks.keys()]) void this.cancel(id); await Promise.allSettled([...this.pending]); }
}
