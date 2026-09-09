import { memo, useCallback, useSyncExternalStore } from 'react';
import { useChat, type Chat } from '@ai-sdk/react';
import type { ChatMessage, SessionSummary } from '../../../shared/types';
import type { WorkspaceStore } from '../../chat/store';
import { useStickToBottom } from './useStickToBottom';
import { MessageBody } from './MessageBody';
import { ToolCall } from './ToolCall';
import { ApprovalCard } from './ApprovalCard';
import { Composer } from './Composer';
import { Collapsible } from '../code/Collapsible';
import { Button } from '../ui4a-ui';
import { Icon } from '../Icon';

export function Conversation({ instance, session, store }: { instance: Chat<ChatMessage>; session: SessionSummary; store: WorkspaceStore }) {
  const chat = useChat<ChatMessage>({ chat: instance });
  const { viewport, content, stuck, scrollToBottom } = useStickToBottom<HTMLDivElement, HTMLDivElement>();
  const streaming = chat.status === 'submitted' || chat.status === 'streaming';
  const send = useCallback((text: string) => { store.send(session.id, text); scrollToBottom(); }, [scrollToBottom, session.id, store]);
  const openArtifact = useCallback((path: string) => store.openArtifact(session.id, path), [session.id, store]);
  const approve = useCallback((id: string, approved: boolean) => store.approve(session.id, id, approved), [session.id, store]);
  const last = chat.messages.at(-1);
  const suggestions = session.suggestions;
  const queued = store.queue(session.id);
  return <div className="@container relative flex h-full min-w-0 flex-1 flex-col">
    <div ref={viewport} data-chat-column className="min-h-0 flex-1 overflow-y-auto"><div ref={content} className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      {chat.messages.map(message => <Message key={message.id} message={message} streaming={streaming && message.id === last?.id} cwd={session.cwd} sessionId={session.id} onSend={send} onArtifact={openArtifact} onApprove={approve} />)}
      {chat.status === 'submitted' ? <p className="flex items-center gap-2 text-xs text-muted" role="status"><span className="size-1.5 animate-pulse rounded-full bg-accent" />正在连接…</p> : null}
      {chat.error || session.status === 'error' ? <div role="alert" className="flex items-center gap-3 rounded-xl border border-danger/40 px-3 py-2 text-xs text-danger"><span className="min-w-0 flex-1 break-words">{chat.error?.message ?? session.error ?? '这轮没有跑完'}</span><Button size="sm" variant="ghost" onClick={() => void store.retry(session.id)}>重试</Button></div> : null}
    </div></div>
    <button type="button" onClick={() => scrollToBottom()} inert={stuck} className={`interactive absolute bottom-24 left-1/2 z-30 -translate-x-1/2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-muted shadow-sm hover:text-fg ${stuck ? 'translate-y-1 opacity-0' : 'opacity-100'}`}>回到底部 ↓</button>
    <div className="px-3"><div className="mx-auto w-full max-w-3xl">
      {queued.length ? <div className="mb-2 flex flex-col gap-1 rounded-xl border border-border p-2">{queued.map(item => <div key={item.id} className="flex items-center gap-2 text-xs text-muted"><span className="shrink-0">排队中</span><span className="min-w-0 flex-1 truncate">{item.text}</span><button type="button" title="移除排队消息" aria-label="移除排队消息" onClick={() => store.dropQueued(session.id, item.id)} className="interactive grid size-7 place-items-center rounded-md hover:bg-surface-3"><Icon name="x" className="size-3.5" /></button></div>)}</div> : null}
      {suggestions.length ? <div className="mb-2 flex flex-wrap gap-2">{suggestions.map(item => <Button key={item} variant="ghost" size="sm" onClick={() => send(item)} className="suggestion h-auto max-w-full rounded-full border border-border py-1.5 text-left font-normal whitespace-normal break-words">{item}</Button>)}</div> : null}
    </div></div>
    <SessionComposer store={store} sessionId={session.id} busy={streaming} onSend={send} />
  </div>;
}

function SessionComposer({ store, sessionId, busy, onSend }: { store: WorkspaceStore; sessionId: string; busy: boolean; onSend: (text: string) => void }) {
  const subscribe = useCallback((listener: () => void) => store.subscribeDraft(sessionId, listener), [store, sessionId]);
  const text = useSyncExternalStore(subscribe, () => store.draft(sessionId));
  return <Composer text={text} setText={value => store.setDraft(sessionId, value)} disabled={false} busy={busy} onSend={onSend} onStop={() => void store.stop(sessionId).catch(store.fail)} />;
}

const Message = memo(function Message({ message, streaming, sessionId, cwd, onSend, onArtifact, onApprove }: { message: ChatMessage; streaming: boolean; sessionId: string; cwd: string; onSend: (text: string) => void; onArtifact: (path: string) => void; onApprove: (id: string, approved: boolean) => Promise<unknown> }) {
  // The server forwards one part per output delta; the joined text exists only here.
  const outputs = new Map<string, string>();
  const firstDelta = new Map<string, number>();
  const toolIds = new Set<string>();
  for (const [index, part] of message.parts.entries()) {
    if ('toolCallId' in part) toolIds.add(part.toolCallId);
    if (part.type !== 'data-command') continue;
    const { toolCallId, output } = part.data;
    // Older saved sessions used one cumulative part; new streams store raw deltas.
    outputs.set(toolCallId, part.id === `command:${toolCallId}` ? output : (outputs.get(toolCallId) ?? '') + output);
    if (!firstDelta.has(toolCallId)) firstDelta.set(toolCallId, index);
  }
  return <article data-message-role={message.role} className={message.role === 'user' ? 'max-w-[85%] self-end rounded-2xl bg-surface-3 px-4 py-2 text-sm' : 'flex flex-col gap-3'}>
    {message.parts.map((part, index) => {
      if (part.type === 'text') return <MessageBody key={index} text={part.text} messageId={`${message.id}:${index}`} streaming={streaming} sessionId={sessionId} onSend={onSend} allowUi={message.role === 'assistant'} />;
      if (part.type === 'reasoning') return <details key={index} className="overflow-clip rounded-lg border border-border text-xs text-muted"><summary className="cursor-pointer px-3 py-2 select-none">思考过程</summary><Collapsible className="border-t border-border"><p className="px-3 py-2 leading-relaxed whitespace-pre-wrap">{part.text}</p></Collapsible></details>;
      if (part.type.startsWith('tool-') || part.type === 'dynamic-tool') return <ToolCall key={index} cwd={cwd} part={part} commandOutput={'toolCallId' in part ? outputs.get(part.toolCallId) : undefined} onArtifact={onArtifact} />;
      if (part.type === 'data-approval') return <ApprovalCard key={part.data.id} approval={part.data} onDecide={approved => onApprove(part.data.id, approved)} />;
      // An orphan command stream renders once, at its first delta, carrying the joined output.
      if (part.type === 'data-command') return !toolIds.has(part.data.toolCallId) && firstDelta.get(part.data.toolCallId) === index ? <ToolCall key={index} part={{ type: 'tool-command', state: streaming ? 'input-available' : 'output-available', output: outputs.get(part.data.toolCallId) }} onArtifact={onArtifact} /> : null;
      if (part.type === 'file' && part.mediaType.startsWith('image/')) return <img key={index} src={part.url} alt={part.filename ?? ''} className="max-h-60 rounded-lg border border-border object-contain" />;
      return null;
    })}
  </article>;
});
