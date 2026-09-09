import { Chat } from '@ai-sdk/react';
import { DefaultChatTransport, type DataUIPart } from 'ai';
import type { Artifact, ChatMessage, HarnessId, HarnessInfo, MessageData, Session, SessionSummary } from '../../shared/types';
import { consumeMetadata } from './metadata';
import { artifactEntryPath } from '../../shared/artifact-path';
import { apiUrl, connectionHeaders } from './connection';

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), { ...init, headers: connectionHeaders({ 'content-type': 'application/json', ...init?.headers }) });
  if (!response.ok) { const body = await response.text(); let detail = body; try { detail = JSON.parse(body).error ?? body; } catch { /* Some failures are plain text. */ } throw new Error(detail || `请求失败 (${response.status})`); }
  return response.status === 204 ? undefined as T : await response.json() as T;
}

export interface QueueItem { id: string; text: string }
export interface WorkspaceSnapshot { sessions: SessionSummary[]; harnesses: HarnessInfo[]; activeId: string | null; ready: boolean; loading: boolean; error?: string; revision: number }
const ACTIVE_KEY = 'macaron-artifacts:active-session';
const LAST_CWD = 'macaron-artifacts:last-cwd';
const stored = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Preferences are optional. */ } };

/** The connections belong to sessions, not mounted components. Switching the visible session only changes the subscription. */
export class WorkspaceStore {
  private snapshot: WorkspaceSnapshot = { sessions: [], harnesses: [], activeId: null, ready: false, loading: false, revision: 0 };
  private listeners = new Set<() => void>();
  private initialization?: Promise<void>;
  private loads = new Map<string, Promise<Chat<ChatMessage>>>();
  private chats = new Map<string, Chat<ChatMessage>>();
  private files = new Map<string, Map<string, Artifact>>();
  private liveRevisions = new Map<string, Map<string, number>>();
  private queues = new Map<string, QueueItem[]>();
  private drafts = new Map<string, string>();
  private draftListeners = new Map<string, Set<() => void>>();
  private inflight = new Set<string>();
  private metadata = new Map<string, AbortController>();
  private turns = new Map<string, number>();
  private configurationRevisions = new Map<string, number>();
  private selectedArtifacts = new Map<string, string>();
  private dismissed = new Map<string, string>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private publish(patch: Partial<WorkspaceSnapshot> = {}) { this.snapshot = { ...this.snapshot, ...patch, revision: this.snapshot.revision + 1 }; for (const listener of this.listeners) listener(); }
  private update(id: string, patch: Partial<SessionSummary>) { this.publish({ sessions: this.snapshot.sessions.map(session => session.id === id ? { ...session, ...patch } : session) }); }
  clearError = () => this.publish({ error: undefined });
  fail = (error: unknown) => this.publish({ error: error instanceof Error ? error.message : String(error) });
  active = () => this.snapshot.sessions.find(session => session.id === this.snapshot.activeId);
  defaultCwd = () => this.active()?.cwd ?? stored(LAST_CWD) ?? '.';
  chat = (id: string) => this.chats.get(id);
  artifacts = (id: string) => [...(this.files.get(id)?.values() ?? [])];
  queue = (id: string) => this.queues.get(id) ?? [];
  draft = (id: string) => this.drafts.get(id) ?? '';
  subscribeDraft = (id: string, listener: () => void) => { let listeners = this.draftListeners.get(id); if (!listeners) this.draftListeners.set(id, listeners = new Set()); listeners.add(listener); return () => { listeners.delete(listener); if (!listeners.size) this.draftListeners.delete(id); }; };
  setDraft = (id: string, text: string) => {
    if (this.draft(id) === text) return;
    text ? this.drafts.set(id, text) : this.drafts.delete(id);
    // Keystrokes only notify this composer; streaming history and the application shell need not render again.
    for (const listener of this.draftListeners.get(id) ?? []) listener();
  };
  selectedArtifact = (id: string) => this.selectedArtifacts.get(id);

  initialize = () => this.initialization ??= this.loadInitial();
  private async loadInitial() {
    try {
      const [sessions, harnesses] = await Promise.all([api<SessionSummary[]>('/api/sessions'), api<HarnessInfo[]>('/api/harnesses')]);
      const remembered = stored(ACTIVE_KEY);
      const activeId = sessions.find(session => session.id === remembered)?.id ?? sessions[0]?.id ?? null;
      this.publish({ sessions, harnesses, ready: true, activeId });
      if (activeId) await this.select(activeId);
    } catch (error) { this.publish({ ready: true }); this.fail(error); }
  }

  select = async (id: string) => {
    remember(ACTIVE_KEY, id);
    this.publish({ activeId: id, loading: !this.chats.has(id), error: undefined });
    try { await this.load(id); } catch (error) { this.fail(error); }
    finally { if (this.snapshot.activeId === id) this.publish({ loading: false }); }
  };

  private load(id: string): Promise<Chat<ChatMessage>> {
    const existing = this.chats.get(id);
    if (existing) return Promise.resolve(existing);
    const pending = this.loads.get(id);
    if (pending) return pending;
    const configuration = this.configurationRevisions.get(id);
    const task = Promise.all([api<Session>(`/api/sessions/${id}`), api<Artifact[]>(`/api/sessions/${id}/artifacts`)]).then(([session, artifacts]) => {
      this.files.set(id, new Map(artifacts.map(artifact => [artifact.path, artifact])));
      const chat = new Chat<ChatMessage>({
        id, messages: session.messages,
        transport: new DefaultChatTransport<ChatMessage>({ api: apiUrl('/api/chat'), headers: connectionHeaders(), prepareSendMessagesRequest: ({ id, messages }) => ({ body: { id, messages }, headers: connectionHeaders() }) }),
        onData: part => this.onData(id, part),
        onError: error => this.update(id, { status: 'error', error: error.message }),
        onFinish: ({ isError, isDisconnect }) => {
          if (!isError && !isDisconnect) this.update(id, { status: 'idle', error: undefined });
          const turn = this.turns.get(id);
          void this.refresh(id, turn, isError || isDisconnect).then(() => { if (!isError && !isDisconnect && this.turns.get(id) === turn) void this.subscribeMetadata(id); });
        },
      });
      this.chats.set(id, chat);
      const { messages: _messages, ...summary } = session;
      // Settings can be saved from the session-list summary while the full transcript is still loading.
      if (this.configurationRevisions.get(id) === configuration) this.update(id, { ...summary, model: summary.model, profileId: summary.profileId });
      const current = this.snapshot.sessions.find(item => item.id === id) ?? summary;
      if (current.status === 'running') void this.resume(id);
      else void this.subscribeMetadata(id);
      return chat;
    }).finally(() => this.loads.delete(id));
    this.loads.set(id, task);
    return task;
  }

  private onData(id: string, part: DataUIPart<MessageData>) {
    if (part.type === 'data-artifact') {
      let files = this.files.get(id);
      if (!files) this.files.set(id, files = new Map());
      let revisions = this.liveRevisions.get(id);
      if (!revisions) this.liveRevisions.set(id, revisions = new Map());
      // Disk listings use wall-clock snapshot versions; a native turn has its own counter. Only compare revisions from the same stream.
      const current = revisions.get(part.data.path);
      if (current !== undefined && current > part.data.revision) return;
      revisions.set(part.data.path, part.data.revision);
      files.set(part.data.path, part.data);
      // A new file opens the panel. Closing the panel during its stream remains respected.
      if (!this.selectedArtifacts.has(id) && this.dismissed.get(id) !== part.data.path) this.selectedArtifacts.set(id, part.data.path);
      this.publish();
    }
    if (part.type === 'data-recap') this.update(id, { ...(part.data.title ? { title: part.data.title } : {}), suggestions: part.data.suggestions });
  }

  private async refresh(id: string, turn = this.turns.get(id), restoreMessages = false) {
    const configuration = this.configurationRevisions.get(id);
    try {
      const { messages, ...summary } = await api<Session>(`/api/sessions/${id}`);
      if (this.turns.get(id) !== turn || this.configurationRevisions.get(id) !== configuration) return;
      const chat = this.chats.get(id);
      const streaming = chat?.status === 'streaming' || chat?.status === 'submitted';
      const lastUser = chat?.messages.findLast(message => message.role === 'user');
      const unacknowledged = lastUser && !messages.some(message => message.id === lastUser.id);
      // A completed server turn has no resumable journal. Reconcile the durable transcript after a disconnect or a 204 resume.
      if (restoreMessages && chat && !streaming && summary.status !== 'running' && !unacknowledged) {
        chat.messages = messages;
        if (summary.status === 'idle') chat.clearError();
      }
      this.update(id, { ...summary, model: summary.model, profileId: summary.profileId, ...(streaming ? { status: 'running' } : unacknowledged ? { status: 'error', error: chat?.error?.message ?? '这条消息尚未发送成功。' } : {}) });
    } catch (error) { if (this.turns.get(id) === turn) this.fail(error); }
  }

  private cancelMetadata(id: string) { this.metadata.get(id)?.abort(); this.metadata.delete(id); }
  private async subscribeMetadata(id: string) {
    this.cancelMetadata(id);
    const controller = new AbortController();
    this.metadata.set(id, controller);
    try {
      const response = await fetch(apiUrl(`/api/sessions/${id}/metadata`), { signal: controller.signal, headers: connectionHeaders({ accept: 'text/event-stream' }) });
      if (!response.ok || !response.body) return;
      await consumeMetadata(response.body, recap => {
        // Cancellation can race with a decoded frame; the ownership check prevents an old turn from renaming the new one.
        if (this.metadata.get(id) !== controller || controller.signal.aborted) return;
        this.update(id, { ...(recap.title ? { title: recap.title } : {}), suggestions: recap.suggestions });
      });
    } catch (error) { if (!controller.signal.aborted) console.warn('[artifacts] metadata stream failed', error); }
    finally { if (this.metadata.get(id) === controller) this.metadata.delete(id); }
  }

  create = async (input: { harness: HarnessId; cwd: string; model?: string; profileId?: string | null }) => {
    const session = await api<Session>('/api/sessions', { method: 'POST', body: JSON.stringify(input) });
    remember(LAST_CWD, session.cwd);
    const { messages: _messages, ...summary } = session;
    this.publish({ sessions: [summary, ...this.snapshot.sessions] });
    await this.select(session.id);
  };
  configure = async (id: string, input: { profileId: string | null; model: string | null }) => {
    const { messages: _messages, ...summary } = await api<Session>(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
    // A GET begun before PATCH must not restore stale settings after the confirmed write.
    this.configurationRevisions.set(id, (this.configurationRevisions.get(id) ?? 0) + 1);
    this.cancelMetadata(id); this.update(id, { ...summary, model: summary.model, profileId: summary.profileId });
  };
  remove = async (id: string) => {
    await api(`/api/sessions/${id}`, { method: 'DELETE' });
    this.cancelMetadata(id); this.turns.delete(id); this.configurationRevisions.delete(id); this.setDraft(id, '');
    this.chats.delete(id); this.files.delete(id); this.liveRevisions.delete(id); this.queues.delete(id); this.selectedArtifacts.delete(id); this.dismissed.delete(id);
    const sessions = this.snapshot.sessions.filter(session => session.id !== id);
    this.publish({ sessions, activeId: this.snapshot.activeId === id ? sessions[0]?.id ?? null : this.snapshot.activeId });
    if (this.snapshot.activeId) await this.select(this.snapshot.activeId);
  };

  send = (id: string, text: string) => {
    if (!text.trim()) return;
    this.cancelMetadata(id);
    const queue = this.queue(id);
    this.queues.set(id, [...queue, { id: crypto.randomUUID(), text }]);
    this.publish();
    void this.drain(id);
  };
  dropQueued = (id: string, itemId: string) => { this.queues.set(id, this.queue(id).filter(item => item.id !== itemId)); this.publish(); };
  private async drain(id: string) {
    const chat = this.chats.get(id);
    if (!chat || this.inflight.has(id) || chat.status === 'streaming' || chat.status === 'submitted') return;
    const [item, ...rest] = this.queue(id);
    if (!item) return;
    this.queues.set(id, rest);
    this.inflight.add(id);
    const turn = (this.turns.get(id) ?? 0) + 1;
    this.turns.set(id, turn);
    this.liveRevisions.delete(id);
    this.dismissed.delete(id);
    this.update(id, { status: 'running', suggestions: [], error: undefined });
    try { chat.clearError(); await chat.sendMessage({ text: item.text }); }
    catch (error) { this.fail(error); }
    finally { if (this.turns.get(id) === turn) { this.inflight.delete(id); this.publish(); if (chat.status !== 'error') void this.drain(id); } }
  }
  resume = async (id: string) => {
    const chat = this.chats.get(id);
    if (!chat || this.inflight.has(id)) return;
    const turn = this.turns.get(id);
    this.inflight.add(id);
    this.liveRevisions.delete(id);
    try { chat.clearError(); await chat.resumeStream(); } catch (error) { this.fail(error); }
    finally { if (this.turns.get(id) === turn) { this.inflight.delete(id); await this.refresh(id, turn, true); void this.drain(id); } }
  };
  retry = async (id: string) => {
    const chat = this.chats.get(id);
    if (!chat || this.inflight.has(id) || chat.status === 'streaming' || chat.status === 'submitted') return;
    this.inflight.add(id);
    this.cancelMetadata(id);
    const turn = (this.turns.get(id) ?? 0) + 1;
    this.turns.set(id, turn);
    this.liveRevisions.delete(id);
    try {
      const remote = await api<Session>(`/api/sessions/${id}`);
      if (this.turns.get(id) !== turn) return;
      const lastUser = chat.messages.findLast(message => message.role === 'user');
      if (lastUser && !remote.messages.some(message => message.id === lastUser.id)) {
        if (remote.status === 'running') throw new Error('这个会话仍有一轮正在生成，请稍后重试。');
        this.update(id, { status: 'running', suggestions: [], error: undefined });
        chat.clearError();
        // No argument replays the same message id and intent; appending "continue" would lose a request the server never received.
        await chat.sendMessage();
      } else if (remote.status === 'running') {
        chat.clearError(); await chat.resumeStream(); await this.refresh(id, turn, true);
      } else {
        chat.messages = remote.messages; chat.clearError();
        if (remote.status === 'error') { this.update(id, { status: 'running', suggestions: [], error: undefined }); await chat.sendMessage(); }
        else { const { messages: _messages, ...summary } = remote; this.update(id, summary); void this.subscribeMetadata(id); }
      }
    } catch (error) { if (this.turns.get(id) === turn) this.fail(error); }
    finally { if (this.turns.get(id) === turn) { this.inflight.delete(id); this.publish(); if (chat.status !== 'error') void this.drain(id); } }
  };
  stop = async (id: string) => {
    // Cancellation is an explicit server action. Aborting a browser stream alone must never kill the harness.
    this.queues.delete(id);
    this.cancelMetadata(id);
    const previousTurn = this.turns.get(id), stopTurn = (previousTurn ?? 0) + 1;
    this.turns.set(id, stopTurn);
    try { await api(`/api/sessions/${id}/stop`, { method: 'POST' }); }
    catch (error) {
      if (this.turns.get(id) === stopTurn) previousTurn === undefined ? this.turns.delete(id) : this.turns.set(id, previousTurn);
      const status = this.chats.get(id)?.status;
      if (status !== 'streaming' && status !== 'submitted') { this.inflight.delete(id); void this.drain(id); }
      throw error;
    }
    await this.chats.get(id)?.stop();
    this.inflight.delete(id);
    this.update(id, { status: 'idle' });
    void this.drain(id);
  };
  approve = (id: string, approvalId: string, approved: boolean) => api(`/api/sessions/${id}/approvals/${encodeURIComponent(approvalId)}`, { method: 'POST', body: JSON.stringify({ approved }) });
  openArtifact = (id: string, path: string) => { const session = this.snapshot.sessions.find(session => session.id === id), entry = session && artifactEntryPath(path, session.cwd); if (!entry) return; this.selectedArtifacts.set(id, entry); this.dismissed.delete(id); this.publish(); };
  closeArtifact = (id: string) => { const path = this.selectedArtifacts.get(id); if (path) this.dismissed.set(id, path); this.selectedArtifacts.delete(id); this.publish(); };
}
