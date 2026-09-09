import { watch, type FSWatcher } from 'node:fs';
import { lstat, mkdir, readFile, realpath, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'partial-json';
import type { Artifact, ChatChunk } from '../shared/types.js';
import { isArtifactEntry } from '../shared/artifact-path.js';
export { isArtifactEntry } from '../shared/artifact-path.js';

const MAX_BYTES = 2 * 1024 * 1024;
export function ui4aPath(cwd: string, path: string) {
  const target = resolve(cwd, path), rel = relative(resolve(cwd), target);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !rel.startsWith(`.artifacts${sep}`)) throw new Error('Files must be inside this workspace’s .artifacts directory.');
  return target;
}
export async function checkedPath(cwd: string, path: string, writing = false): Promise<string> {
  const target = ui4aPath(cwd, path), base = join(await realpath(cwd), '.artifacts');
  try {
    if ((await lstat(base)).isSymbolicLink()) throw new Error('Symlinks cannot replace the .artifacts root.');
  } catch (error) {
    // A missing root has no descendants that could redirect the first write.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && writing) return target;
    throw error;
  }
  let existing = target;
  while (true) {
    try {
      const actual = await realpath(existing), rel = relative(base, actual);
      if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('Symlinks must stay inside .artifacts.');
      return resolve(actual, relative(existing, target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !writing) throw error;
      // realpath cannot resolve a dangling link, but writeFile would still follow it
      // and create its target. Do not mistake that link for a missing path segment.
      if ((await lstat(existing).catch(() => undefined))?.isSymbolicLink()) throw new Error('Symlinks must resolve inside .artifacts.');
      existing = dirname(existing);
    }
  }
}
export async function readUi4aFile(cwd: string, path: string) {
  const target = await checkedPath(cwd, path);
  if ((await stat(target)).size > MAX_BYTES) throw new Error('UI4A files are limited to 2 MB.');
  return readFile(target, 'utf8');
}
export async function writeUi4aFile(cwd: string, path: string, content: string) {
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('UI4A files are limited to 2 MB.');
  const target = await checkedPath(cwd, path, true);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}
export async function listArtifacts(cwd: string, revision = Date.now()): Promise<Artifact[]> {
  const paths: string[] = [];
  for (const dir of ['.artifacts', '.artifacts/canvases']) {
    for (const item of await readdir(join(cwd, dir), { withFileTypes: true }).catch(() => [])) {
      const path = `${dir}/${item.name}`;
      if (item.isFile() && isArtifactEntry(path)) paths.push(path);
    }
  }
  const files = await Promise.all(paths.map(async path => {
    try { return { path, source: await readUi4aFile(cwd, path), streaming: false, revision }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }));
  return files.filter((file): file is Artifact => file !== undefined);
}

export class ArtifactObserver {
  private inputs = new Map<string, string>();
  private names = new Map<string, string>();
  private sources = new Map<string, string>();
  private watchers: FSWatcher[] = [];
  private revision = Date.now();
  private closed = false;
  private scanning?: Promise<void>;
  private dirty = false;
  constructor(private cwd: string, private emit: (chunk: ChatChunk) => void) {}
  async start() {
    const observe = () => {
      if (this.watchers.length > 1 || this.closed) return;
      try { this.watchers.push(watch(join(this.cwd, '.artifacts'), { recursive: true }, () => this.refresh())); } catch { /* A workspace may not have artifacts yet. */ }
    };
    this.watchers.push(watch(this.cwd, (_, name) => { if (name === '.artifacts') { observe(); this.refresh(); } }));
    observe();
    await this.refresh();
  }
  refresh() {
    if (this.closed) return Promise.resolve();
    this.dirty = true;
    if (this.scanning) return this.scanning;
    // Coalesce filesystem notifications into another scan, not an unbounded queue
    // of stale snapshots. Tool-input deltas still pass through accept immediately.
    this.scanning = (async () => {
      while (this.dirty && !this.closed) {
        this.dirty = false;
        const files = await listArtifacts(this.cwd, ++this.revision);
        if (this.closed) return;
        for (const artifact of files) {
          this.sources.set(artifact.path, artifact.source);
          this.emit({ type: 'data-artifact', id: artifact.path, data: artifact });
        }
      }
    })().finally(() => { this.scanning = undefined; });
    return this.scanning;
  }
  accept(chunk: ChatChunk) {
    if (chunk.type === 'tool-input-start') this.names.set(chunk.toolCallId, chunk.toolName);
    if (chunk.type !== 'tool-input-delta') return;
    // Only full-file writes produce speculative frames. An edit's new_string is not a whole module.
    // Checked before accumulating: every other tool's input would be parsed once per delta and thrown away.
    if (!/write|create/i.test(this.names.get(chunk.toolCallId) ?? '')) return;
    const json = (this.inputs.get(chunk.toolCallId) ?? '') + chunk.inputTextDelta;
    this.inputs.set(chunk.toolCallId, json);
    try {
      const input = parse(json) as Record<string, unknown>;
      const path = input.file_path ?? input.path;
      if (typeof path !== 'string' || typeof input.content !== 'string') return;
      const rel = relative(this.cwd, ui4aPath(this.cwd, path)).split(sep).join('/');
      if (!isArtifactEntry(rel) || this.sources.get(rel) === input.content) return;
      this.sources.set(rel, input.content);
      this.emit({ type: 'data-artifact', id: rel, data: { path: rel, source: input.content, streaming: true, revision: ++this.revision } });
    } catch { /* Partial JSON and paths are expected while the native tool input is streaming. */ }
  }
  async finish() {
    // Stop new scan producers before taking the final disk snapshot. Otherwise an
    // already queued watcher can emit after finish and reopen a supposedly settled artifact.
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    await this.refresh();
    this.closed = true;
  }
  async close() { this.closed = true; for (const watcher of this.watchers) watcher.close(); this.watchers = []; await this.scanning?.catch(() => {}); }
}
