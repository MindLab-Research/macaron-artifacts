import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { createUIMessageStream, readUIMessageStream } from 'ai';
import type { Approval, ChatChunk, ChatMessage, ConnectionState, ProviderReview, Session } from '../shared/types.js';
import { parseQuestionResponse, type QuestionRequest, type QuestionResponse } from '../shared/questions.js';
import type { ConnectionControls, HarnessAdapter, ResolvedProfile } from './harnesses/types.js';
import { redactConnection } from './connections.js';
import { safeProfileError } from './harnesses/common.js';
import { ArtifactObserver } from './artifacts.js';
import { MetadataTasks } from './enrichment.js';
import { SessionStore } from './store.js';

/**
 * A saved transcript keeps what happened, never a replayable authorization link or credential default,
 * and never controls: the native process that owned them is gone by the time this is read back.
 */
const savedMessage = (message: ChatMessage): ChatMessage => ({
  ...message,
  parts: message.parts.map(part => part.type === 'data-connection' ? { ...part, data: { ...redactConnection(part.data), actionable: false } } : part),
});

export class ActiveConversation {
  readonly controller = new AbortController();
  readonly journal: ChatChunk[] = [];
  readonly approvals = new Map<string, (approved: boolean) => void>();
  readonly questions = new Map<string, { request: QuestionRequest; resolve: (response: QuestionResponse) => void }>();
  /** Opaque browser request id -> the controls the adapter captured for that one operation. */
  readonly connections = new Map<string, { state: ConnectionState; controls: ConnectionControls }>();
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
    // A stopped turn keeps its visible summary but can no longer reach the native operation.
    this.connections.clear();
  }
  answerQuestion(id: string, value: unknown): 'missing' | 'invalid' | undefined {
    const pending = this.questions.get(id);
    if (!pending) return 'missing';
    const response = parseQuestionResponse(pending.request, value);
    if (!response) return 'invalid';
    pending.resolve(response);
  }
  /** The published snapshot the API validates a browser answer against. */
  connection(id: string) {
    const pending = this.connections.get(id);
    if (!pending || this.mainSettled || this.controller.signal.aborted) return undefined;
    return pending;
  }
  private cancelQuestions() { for (const pending of this.questions.values()) pending.resolve({ cancelled: true }); }
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
        const ask = (input: Omit<QuestionRequest, 'id'>, signal?: AbortSignal): Promise<QuestionResponse> => {
          const activeSignal = signal ? AbortSignal.any([this.controller.signal, signal]) : this.controller.signal;
          if (activeSignal.aborted || this.mainSettled) return Promise.resolve({ cancelled: true });
          // Native request IDs can repeat on retry; a fresh ID prevents old cards from answering a new request.
          const request: QuestionRequest = { ...input, id: crypto.randomUUID() };
          emit({ type: 'data-question', id: request.id, data: request });
          return new Promise(resolve => {
            const decide = (response: QuestionResponse) => {
              if (!this.questions.delete(request.id)) return;
              activeSignal.removeEventListener('abort', abort);
              const visible = 'answers' in response ? { answers: Object.fromEntries(request.questions.map(question => [question.id, question.secret ? ['••••••'] : response.answers[question.id]])) } : response;
              emit({ type: 'data-question', id: request.id, data: { ...request, response: visible } });
              resolve(response);
            };
            const abort = () => decide({ cancelled: true });
            this.questions.set(request.id, { request, resolve: decide });
            activeSignal.addEventListener('abort', abort, { once: true });
          });
        };
        // Native op ids repeat across retries; a fresh browser id keeps an old card from steering a new operation.
        const connection = (id: string, state: ConnectionState, controls: ConnectionControls, actionable: boolean) => {
          if (actionable && !this.controller.signal.aborted && !this.mainSettled) this.connections.set(id, { state, controls });
          else this.connections.delete(id);

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
          }, providerReview: session.providerReview, onProviderReview: (review: ProviderReview) => {
            session.providerReview = review;
            emit({ type: 'data-providerReview', data: review, transient: true });
            nativeCheckpoint = this.store.save(session);
            void nativeCheckpoint.catch(error => { failure = error; this.controller.abort(); });
          }, approve, ask, connection };
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
          this.cancelQuestions();
          this.connections.clear();
          writer.write({ type: 'finish-step' });
          writer.write({ type: 'finish', finishReason: 'stop' });
        } catch (error) {
          failure = error; this.mainSettled = true;
          this.cancelQuestions();
          this.connections.clear();
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
          // Live subscribers get the real authorization link; disk keeps only the safe historical summary.
          if (!diskError) disk.write(`${JSON.stringify(value.type === 'data-connection' ? { ...value, data: { ...redactConnection(value.data), actionable: false } } : value)}\n`);
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
        const latest = savedMessage(this.latest);
        const previousAssistant = this.retry ? before.findLast(message => message.role === 'assistant') : undefined;
        if (previousAssistant && latest.role === 'assistant' && latest.id === previousAssistant.id) {
          const index = before.lastIndexOf(previousAssistant);
          session.messages = [...before.slice(0, index), { ...latest, parts: [...previousAssistant.parts, ...latest.parts] }];
        } else session.messages = [...before, latest];
      }
      session.status = failure || diskError ? 'error' : 'idle';
      session.error = diskError || failure ? safeProfileError(diskError || failure, this.profile) : undefined;
      session.updatedAt = Date.now();
      await this.store.save(session);
      if (!diskError) await rm(this.store.journalPath(session.id), { force: true });
      // A profile edit affects the next user turn, never this turn's cache-friendly metadata fork.
      if (!failure && !diskError && !session.providerReview && session.nativeId && !this.controller.signal.aborted) this.metadata.start(session, this.adapter, this.instructions, this.profile, this.model);
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
