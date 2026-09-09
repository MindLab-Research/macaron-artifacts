import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { createUIMessageStream, readUIMessageStream } from 'ai';
import type { Approval, ChatChunk, ChatMessage, Session } from '../shared/types.js';
import type { HarnessAdapter, ResolvedProfile } from './harnesses/types.js';
import { safeProfileError } from './harnesses/common.js';
import { ArtifactObserver } from './artifacts.js';
import { MetadataTasks } from './enrichment.js';
import { SessionStore } from './store.js';

export class ActiveConversation {
  readonly controller = new AbortController();
  readonly journal: ChatChunk[] = [];
  readonly approvals = new Map<string, (approved: boolean) => void>();
  private listeners = new Set<ReadableStreamDefaultController<ChatChunk>>();
  private ended = false;
  private mainSettled = false;
  latest?: ChatMessage;
  readonly done: Promise<void>;
  constructor(private store: SessionStore, readonly session: Session, private adapter: HarnessAdapter, private instructions: string, prompt: string, private metadata: MetadataTasks, private retry = false, private profile?: ResolvedProfile, private model = session.model) {
    this.done = this.execute(prompt);
  }
  stream(): ReadableStream<ChatChunk> {
    let subscriber: ReadableStreamDefaultController<ChatChunk>;
    return new ReadableStream({
      start: controller => {
        subscriber = controller;
        for (const chunk of this.journal) controller.enqueue(chunk);
        if (this.ended) controller.close(); else this.listeners.add(controller);
      },
      // Detaching a browser never cancels the native harness.
      cancel: () => { this.listeners.delete(subscriber); },
    });
  }
  stop() {
    if (this.mainSettled) { void this.metadata.cancel(this.session.id); return; }
    this.controller.abort();
    for (const decide of this.approvals.values()) decide(false);
    this.approvals.clear();
  }
  private publish(chunk: ChatChunk) {
    this.journal.push(chunk);
    for (const listener of this.listeners) { try { listener.enqueue(chunk); } catch { this.listeners.delete(listener); } }
  }
  private async execute(prompt: string) {
    const session = this.session, before = [...session.messages];
    const disk = createWriteStream(this.store.journalPath(session.id), { mode: 0o600 });
    let diskError: Error | undefined, failure: unknown, nativeCheckpoint: Promise<void> | undefined;
    disk.on('error', error => { diskError = error; this.controller.abort(); });
    // Attach the completion handler before an open/write error can occur.
    const diskDone = finished(disk).catch(error => { diskError = error instanceof Error ? error : new Error(String(error)); });
    const stream = createUIMessageStream<ChatMessage>({
      execute: async ({ writer }) => {
        // Command output stays a per-delta part. Rewriting one accumulated part instead would
        // re-send, re-journal and re-store the whole output on every chunk of a noisy build.
        const emit = (chunk: ChatChunk) => writer.write('errorText' in chunk && typeof chunk.errorText === 'string' ? { ...chunk, errorText: safeProfileError(chunk.errorText, this.profile) } : chunk);
        const artifacts = new ArtifactObserver(session.cwd, emit);
        const approve = async (request: Approval) => {
          if (this.controller.signal.aborted) return false;
          emit({ type: 'data-approval', id: request.id, data: request });
          const approved = await new Promise<boolean>(resolve => {
            const decide = (answer: boolean) => { this.controller.signal.removeEventListener('abort', abort); resolve(answer); };
            const abort = () => decide(false);
            this.approvals.set(request.id, decide);
            this.controller.signal.addEventListener('abort', abort, { once: true });
          });
          this.approvals.delete(request.id);
          emit({ type: 'data-approval', id: request.id, data: { ...request, resolved: true } });
          return approved;
        };
        const previousAssistant = this.retry ? session.messages.findLast(message => message.role === 'assistant') : undefined;
        writer.write({ type: 'start', messageId: previousAssistant?.id ?? crypto.randomUUID() });
        writer.write({ type: 'start-step' });
        try {
          await artifacts.start();
          const turn = { nativeId: session.nativeId, cwd: session.cwd, prompt, messageId: session.messages.findLast(message => message.role === 'user')?.id, retry: this.retry, model: this.model, profile: this.profile, instructions: this.instructions, signal: this.controller.signal, onNativeSession: (id: string) => {
            if (session.nativeId === id) return;
            session.nativeId = id;
            // First output waits for this durable identity checkpoint. A recovered partial
            // turn must resume its native thread rather than silently starting another one.
            nativeCheckpoint = this.store.save(session);
            void nativeCheckpoint.catch(error => { failure = error; this.controller.abort(); });
          }, approve };
          for await (const chunk of this.adapter.run(turn)) {
            if (nativeCheckpoint) { await nativeCheckpoint; nativeCheckpoint = undefined; }
            artifacts.accept(chunk); emit(chunk);
            if (chunk.type === 'tool-output-available') void artifacts.refresh().catch(() => {});
          }
          if (nativeCheckpoint) await nativeCheckpoint;
          await artifacts.finish();
          if (diskError) throw diskError;
          if (this.controller.signal.aborted) throw new Error('This turn was stopped.');
          this.mainSettled = true;
          writer.write({ type: 'finish-step' });
          writer.write({ type: 'finish', finishReason: 'stop' });
        } catch (error) {
          failure = error; this.mainSettled = true;
          emit({ type: 'error', errorText: safeProfileError(error, this.profile) });
          writer.write({ type: 'finish', finishReason: 'error', messageMetadata: { interrupted: true } });
        } finally { await artifacts.close(); }
      },
    });
    const [broadcast, snapshots] = stream.tee();
    const broadcastTask = (async () => {
      const reader = broadcast.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!diskError) disk.write(`${JSON.stringify(value)}\n`);
          this.publish(value);
        }
      } finally { reader.releaseLock(); }
    })();
    const snapshotTask = (async () => { for await (const message of readUIMessageStream<ChatMessage>({ stream: snapshots })) this.latest = message; })();
    try {
      const settled = await Promise.allSettled([broadcastTask, snapshotTask]);
      for (const result of settled) if (result.status === 'rejected') failure ??= result.reason;
      disk.end(); await diskDone;
      if (this.latest) {
        const previousAssistant = this.retry ? before.findLast(message => message.role === 'assistant') : undefined;
        if (previousAssistant && this.latest.role === 'assistant' && this.latest.id === previousAssistant.id) {
          const index = before.lastIndexOf(previousAssistant);
          session.messages = [...before.slice(0, index), { ...this.latest, parts: [...previousAssistant.parts, ...this.latest.parts] }];
        } else session.messages = [...before, this.latest];
      }
      session.status = failure || diskError ? 'error' : 'idle';
      session.error = diskError || failure ? safeProfileError(diskError || failure, this.profile) : undefined;
      session.updatedAt = Date.now();
      await this.store.save(session);
      if (!diskError) await rm(this.store.journalPath(session.id), { force: true });
      // A profile edit affects the next user turn, never this turn's cache-friendly metadata fork.
      if (!failure && !diskError && session.nativeId && !this.controller.signal.aborted) this.metadata.start(session, this.adapter, this.instructions, this.profile, this.model);
    } catch (error) {
      session.status = 'error'; session.error = safeProfileError(error, this.profile);
      this.publish({ type: 'error', errorText: session.error });
      this.publish({ type: 'finish', finishReason: 'error', messageMetadata: { interrupted: true } });
      // The server logs rejected persistence promises; keep that terminal diagnostic as private as the SSE response.
      throw new Error(session.error);
    } finally {
      this.mainSettled = true;
      if (!disk.writableEnded) disk.end();
      await diskDone;
      this.ended = true;
      for (const listener of this.listeners) { try { listener.close(); } catch { /* Browser detached. */ } }
      this.listeners.clear();
    }
  }
}
