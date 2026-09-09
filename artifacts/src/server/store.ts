import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readUIMessageStream } from 'ai';
import type { ChatChunk, ChatMessage, Session, SessionSummary } from '../shared/types.js';

export class SessionStore {
  readonly sessions = new Map<string, Session>();
  private writes = new Map<string, Promise<void>>();
  constructor(readonly directory: string) {}
  path(id: string) { return join(this.directory, `${id}.json`); }
  journalPath(id: string) { return join(this.directory, `${id}.jsonl`); }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const names = (await readdir(this.directory)).filter(name => /^[\w-]+\.json$/.test(name));
    // Recovery per session is independent, and the server cannot bind its port until this resolves.
    await Promise.all(names.map(name => this.restore(name)));
  }
  private async restore(name: string) {
    const session = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as Session;
    if (session.status === 'running') {
      // The journal has no lossy ring limit. Recover complete prefixes even after a process crash.
      const raw = await readFile(this.journalPath(session.id), 'utf8').catch(() => '');
      const chunks: ChatChunk[] = [];
      for (const line of raw.split('\n')) { if (!line) continue; try { chunks.push(JSON.parse(line) as ChatChunk); } catch { break; } }
      const terminal = chunks.findLast(chunk => chunk.type === 'finish');
      const interrupted = terminal?.type !== 'finish' || terminal.finishReason !== 'stop';
      if (chunks.length) {
        let last: ChatMessage | undefined;
        const stream = new ReadableStream<ChatChunk>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
        try { for await (const message of readUIMessageStream<ChatMessage>({ stream })) last = message; } catch { /* Keep the last complete parsed prefix if a final event was torn. */ }
        if (last?.id) {
          const recovered = { ...last, ...(interrupted ? { metadata: { ...last.metadata, interrupted: true } } : {}) };
          session.messages = [...session.messages.filter(message => message.id !== recovered.id), recovered];
        }
      }
      session.status = interrupted ? 'error' : 'idle';
      session.error = interrupted ? 'The server stopped during this turn. The partial response was recovered.' : undefined;
      await this.save(session);
      await rm(this.journalPath(session.id), { force: true });
    }
    this.sessions.set(session.id, session);
  }
  list(): SessionSummary[] { return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(({ messages: _, ...summary }) => summary); }
  async save(session: Session) {
    // Metadata and the next user turn can save the same object concurrently; serialize
    // atomic replacements per session so a slower write cannot resurrect stale state.
    const previous = this.writes.get(session.id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const path = this.path(session.id), tmp = `${path}.${crypto.randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(session), { mode: 0o600 });
      await rename(tmp, path);
      this.sessions.set(session.id, session);
    });
    this.writes.set(session.id, current);
    void current.finally(() => { if (this.writes.get(session.id) === current) this.writes.delete(session.id); }).catch(() => {});
    return current;
  }
  async delete(id: string) {
    await this.writes.get(id)?.catch(() => {});
    await rm(this.path(id), { force: true }); await rm(this.journalPath(id), { force: true }); this.sessions.delete(id); this.writes.delete(id);
  }
}
