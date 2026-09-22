import { expect, spyOn, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Chat } from '@ai-sdk/react';
import type { ChatChunk, ChatMessage, SessionSummary } from '../../../shared/types';
import { WorkspaceStore } from '../../chat/store';
import { Conversation } from './Conversation';

test('submitted user prompts stay fully visible while assistant deltas keep their fade-in', async () => {
  const session: SessionSummary = { id: 'animation', harness: 'claude-code', cwd: '/workspace', title: 'Animation', suggestions: [], createdAt: 1, updatedAt: 1, status: 'running' };
  const store = new WorkspaceStore();
  let started!: () => void, open!: (stream: ReadableStream<ChatChunk>) => void, output!: ReadableStreamDefaultController<ChatChunk>;
  const submitted = new Promise<void>(resolve => { started = resolve; });
  const chat = new Chat<ChatMessage>({ transport: { sendMessages: () => new Promise(resolve => { open = resolve; started(); }), reconnectToStream: async () => null } });
  const prompt = 'Explain the difference between streaming and complete messages.';
  const sending = chat.sendMessage({ text: prompt });
  await submitted;
  // The client-only draft subscription has no server snapshot. Preserve the real hook and supply its existing snapshot for this SSR probe.
  const useSyncExternalStore = React.useSyncExternalStore;
  const snapshot = spyOn(React, 'useSyncExternalStore').mockImplementation((subscribe, getSnapshot, getServerSnapshot) => useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot ?? getSnapshot));
  const render = () => renderToStaticMarkup(<Conversation instance={chat} session={session} store={store} />);
  const article = (html: string, role: string) => html.match(new RegExp(`<article data-message-role="${role}"[^>]*>([\\s\\S]*?)</article>`))?.[1] ?? '';
  try {
    expect(chat.status).toBe('submitted');
    const user = article(render(), 'user');
    expect(user).toContain(prompt);
    expect(user).not.toContain('data-sd-animate');

    open(new ReadableStream({ start(controller) { output = controller; } }));
    output.enqueue({ type: 'start', messageId: 'answer' });
    output.enqueue({ type: 'text-start', id: 'answer-text' });
    output.enqueue({ type: 'text-delta', id: 'answer-text', delta: 'An assistant response' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(chat.status).toBe('streaming');
    const streaming = render();
    expect(article(streaming, 'user')).toContain(prompt);
    expect(article(streaming, 'user')).not.toContain('data-sd-animate');
    expect(article(streaming, 'assistant')).toContain('data-sd-animate');

    output.enqueue({ type: 'text-end', id: 'answer-text' });
    output.enqueue({ type: 'finish' });
    output.close();
    await sending;
    expect(chat.status).toBe('ready');
    expect(render()).not.toContain('data-sd-animate');
  } finally { snapshot.mockRestore(); store.dispose(); await chat.stop(); }
});
