import { memo, useCallback, useState, useSyncExternalStore } from 'react';
import { useChat, type Chat } from '@ai-sdk/react';
import type { ChatMessage, ConnectionCommand, SessionSummary } from '../../../shared/types';
import type { QuestionResponse } from '../../../shared/questions';
import type { WorkspaceStore } from '../../chat/store';
import { useStickToBottom } from './useStickToBottom';
import { MessageBody } from './MessageBody';
import { ToolCall } from './ToolCall';
import { ToolGroup } from './ToolGroup';
import { isReadTool, readRunAt } from './tool-presentation';
import { ApprovalCard } from './ApprovalCard';
import { QuestionCard } from './QuestionCard';
import { ConnectionCard } from './ConnectionCard';
import { Composer } from './Composer';
import { ProviderReviewBanner } from './ProviderReviewBanner';
import { Reasoning } from './Reasoning';
import { reasoningRunAt } from './reasoning-model';
import { Button } from '../ui4a-ui';
import { Icon } from '../Icon';
import { LoadingState } from '../LoadingState';

export function Conversation({ instance, session, store }: { instance: Chat<ChatMessage>; session: SessionSummary; store: WorkspaceStore }) {
  const chat = useChat<ChatMessage>({ chat: instance });
  const { viewport, content, stuck, scrollToBottom } = useStickToBottom<HTMLDivElement, HTMLDivElement>();
  const streaming = chat.status === 'submitted' || chat.status === 'streaming';
  const send = useCallback((text: string) => { store.send(session.id, text); scrollToBottom('instant'); }, [scrollToBottom, session.id, store]);
  const openArtifact = useCallback((path: string) => store.openArtifact(session.id, path), [session.id, store]);
  const approve = useCallback((id: string, approved: boolean) => store.approve(session.id, id, approved), [session.id, store]);
  const answer = useCallback((id: string, response: QuestionResponse) => store.answer(session.id, id, response), [session.id, store]);
  const commandConnection = useCallback((id: string, command: ConnectionCommand) => store.respondConnection(session.id, id, command), [session.id, store]);
  const last = chat.messages.at(-1);
  const waiting = streaming && !(last?.role === 'assistant' && last.parts.some(part => {
    if (part.type === 'text') return Boolean(part.text.trim());
    // Active reasoning already owns a visible placeholder before its first text delta.
    if (part.type === 'reasoning') return part.state !== 'done' || Boolean(part.text.trim());
    return part.type.startsWith('tool-') || part.type === 'dynamic-tool' || part.type === 'data-approval' || part.type === 'data-question' || part.type === 'data-connection' || part.type === 'data-command' || (part.type === 'file' && part.mediaType.startsWith('image/'));
  }));
  const suggestions = session.suggestions;
  const queued = store.queue(session.id);
  return <div className="@container relative flex h-full min-w-0 flex-1 flex-col">
    <div ref={viewport} data-chat-column className="min-h-0 flex-1 overflow-y-auto"><div ref={content} data-chat-content className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      {/* While submitted, the last message is still the complete user prompt; only assistant text can stream. */}
      {chat.messages.map(message => <Message key={message.id} message={message} streaming={message.role === 'assistant' && streaming && message.id === last?.id} active={session.status === 'running'} cwd={session.cwd} sessionId={session.id} onSend={send} onArtifact={openArtifact} onApprove={approve} onAnswer={answer} onConnectionCommand={commandConnection} />)}
      {waiting ? <LoadingState label={chat.status === 'submitted' ? '正在连接…' : '正在生成…'} /> : null}
      {!session.providerReview && (chat.error || session.status === 'error') ? <div role="alert" className="flex items-center gap-3 rounded-xl border border-danger/40 px-3 py-2 text-xs text-danger"><span className="min-w-0 flex-1 break-words">{chat.error?.message ?? session.error ?? '这轮没有跑完'}</span><Button data-export-control size="sm" variant="ghost" onClick={() => void store.retry(session.id)}>重试</Button></div> : null}
    </div></div>
    <button type="button" onClick={event => scrollToBottom(event.detail === 0 ? 'instant' : 'smooth')} inert={stuck} className={`absolute bottom-24 left-1/2 z-floating-control -translate-x-1/2 theme-widget rounded-full px-3 py-1.5 text-xs text-muted hover:text-fg ${stuck ? 'opacity-0' : 'opacity-100'}`}>回到底部 ↓</button>
    <div className="px-3"><div className="mx-auto w-full max-w-3xl">
      {queued.length ? <div className="mb-2 flex flex-col gap-1 rounded-xl bg-status p-2 text-status-fg">{queued.map(item => <div key={item.id} className="flex items-center gap-2 text-xs"><span className="shrink-0">排队中</span><span className="min-w-0 flex-1 truncate">{item.text}</span><button type="button" title="移除排队消息" aria-label="移除排队消息" onClick={() => store.dropQueued(session.id, item.id)} className="interactive grid size-7 place-items-center rounded-md hover:bg-surface-3 hover:text-hover-fg"><Icon name="x" className="size-3.5" /></button></div>)}</div> : null}
      {queued.length && !streaming && !session.providerReview ? <Button size="sm" variant="ghost" onClick={() => store.sendQueued(session.id)}>发送排队消息</Button> : null}
      {!session.providerReview && suggestions.length ? <div className="mb-2 flex flex-wrap gap-2">{suggestions.map(item => <Button key={item} variant="ghost" size="sm" onClick={() => send(item)} className="suggestion h-auto max-w-full rounded-full bg-surface-2 py-1.5 text-left font-normal whitespace-normal break-words">{item}</Button>)}</div> : null}
    </div></div>
    {session.providerReview ? <ProviderReviewBanner review={session.providerReview} onRefresh={() => store.refreshProviderReview(session.id)} /> : null}
    <SessionComposer store={store} sessionId={session.id} busy={streaming} disabled={Boolean(session.providerReview)} onSend={send} />
  </div>;
}

function SessionComposer({ store, sessionId, busy, disabled, onSend }: { store: WorkspaceStore; sessionId: string; busy: boolean; disabled: boolean; onSend: (text: string) => void }) {
  const subscribe = useCallback((listener: () => void) => store.subscribeDraft(sessionId, listener), [store, sessionId]);
  const text = useSyncExternalStore(subscribe, () => store.draft(sessionId));
  return <Composer text={text} setText={value => store.setDraft(sessionId, value)} disabled={disabled} busy={busy} onSend={onSend} onStop={() => void store.stop(sessionId).catch(store.fail)} />;
}

const Message = memo(function Message({ message, streaming, active, sessionId, cwd, onSend, onArtifact, onApprove, onAnswer, onConnectionCommand }: { message: ChatMessage; streaming: boolean; active: boolean; sessionId: string; cwd: string; onSend: (text: string) => void; onArtifact: (path: string) => void; onApprove: (id: string, approved: boolean) => Promise<unknown>; onAnswer: (id: string, response: QuestionResponse) => Promise<unknown>; onConnectionCommand: (id: string, command: ConnectionCommand) => Promise<unknown> }) {
  // Do not replace live tool DOM on completion: readers may have expanded or selected its output.
  const [groupReads] = useState(!streaming);
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
  return <article data-message-role={message.role} className={message.role === 'user' ? 'theme-bubble max-w-[85%] self-end rounded-2xl px-4 py-2 text-sm' : 'flex flex-col gap-3'}>
    {message.parts.map((part, index) => {
      if (groupReads && !streaming && isReadTool(part)) {
        const group = readRunAt(message.parts, index);
        if (group) return <ToolGroup key={index} parts={group} cwd={cwd} outputs={outputs} onArtifact={onArtifact} />;
        if (index > 0 && isReadTool(message.parts[index - 1])) return null;
      }
      if (part.type === 'text') return <MessageBody key={index} text={part.text} messageId={`${message.id}:${index}`} streaming={streaming} sessionId={sessionId} onSend={onSend} allowUi={message.role === 'assistant'} />;
      if (part.type === 'reasoning') {
        const parts = reasoningRunAt(message.parts, index);
        return parts ? <Reasoning key={index} parts={parts} live={streaming && index + parts.length === message.parts.length} /> : null;
      }
      if (part.type.startsWith('tool-') || part.type === 'dynamic-tool') return <ToolCall key={index} cwd={cwd} part={part} commandOutput={'toolCallId' in part ? outputs.get(part.toolCallId) : undefined} onArtifact={onArtifact} />;
      if (part.type === 'data-approval') return <ApprovalCard key={part.data.id} approval={part.data} onDecide={approved => onApprove(part.data.id, approved)} />;
      if (part.type === 'data-question') return <QuestionCard key={part.data.id} request={part.data} active={active} sessionId={sessionId} onAnswer={response => onAnswer(part.data.id, response)} />;
      if (part.type === 'data-connection') return <ConnectionCard key={part.data.id} connection={active ? part.data : { ...part.data, actionable: false }} onCommand={command => onConnectionCommand(part.data.id, command)} />;
      // An orphan command stream renders once, at its first delta, carrying the joined output.
      if (part.type === 'data-command') return !toolIds.has(part.data.toolCallId) && firstDelta.get(part.data.toolCallId) === index ? <ToolCall key={index} part={{ type: 'tool-command', state: streaming ? 'input-available' : 'output-available', output: outputs.get(part.data.toolCallId) }} onArtifact={onArtifact} /> : null;
      if (part.type === 'file' && part.mediaType.startsWith('image/')) return <img key={index} src={part.url} alt={part.filename ?? ''} className="max-h-60 rounded-lg border border-contrast object-contain" />;
      return null;
    })}
  </article>;
});
