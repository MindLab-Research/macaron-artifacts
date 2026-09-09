import type { MessageData } from '../../shared/types';

/** This stream ends independently from the assistant response. EOF is completion, never a reason to reconnect. */
export async function consumeMetadata(body: ReadableStream<Uint8Array>, onRecap: (recap: MessageData['recap']) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const emit = (event: string) => {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    const value = JSON.parse(data) as Partial<MessageData['recap']>;
    if (!Array.isArray(value.suggestions) || value.suggestions.some(item => typeof item !== 'string')) return;
    onRecap({ ...(typeof value.title === 'string' && value.title ? { title: value.title } : {}), suggestions: value.suggestions });
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { buffer += decoder.decode(); if (buffer.trim()) emit(buffer); break; }
      buffer += decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) { emit(buffer.slice(0, boundary.index)); buffer = buffer.slice(boundary.index + boundary[0].length); }
    }
  } finally { reader.releaseLock(); }
}
