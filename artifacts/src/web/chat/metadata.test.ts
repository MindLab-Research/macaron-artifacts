import { expect, test } from 'bun:test';
import { consumeMetadata } from './metadata';

test('metadata arrives independently in UTF-8 fragments and completes at EOF', async () => {
  const bytes = new TextEncoder().encode('data: {"title":"标题","suggestions":[]}\r\n\r\ndata: {"title":"标题","suggestions":["继续"]}\n\n');
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  const snapshots: unknown[] = [];
  await consumeMetadata(stream, snapshot => snapshots.push(snapshot));
  expect(snapshots).toEqual([{ title: '标题', suggestions: [] }, { title: '标题', suggestions: ['继续'] }]);
});
