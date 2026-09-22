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
  private sources = new Map<string, Artifact>();
  private drafts = new Map<string, string>();
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
        const revision = ++this.revision, files = await listArtifacts(this.cwd, revision);
        if (this.closed) return;
        const active = new Set(this.drafts.values()), saved = new Set(files.map(file => file.path));
        for (const artifact of files) {
          // A watcher may read the previous file or a write's intermediate truncation.
          // Native input remains authoritative until its tool completes; older scans also lose to newer input.
          const draft = this.sources.get(artifact.path);
          if (!active.has(artifact.path) && (draft?.revision ?? 0) > revision) continue;
          // Invalidate relative modules on disk refresh without reading them for every source token.
          this.publish({ ...(active.has(artifact.path) && draft ? draft : artifact), revision: ++this.revision, importsRevision: revision });
        }
        for (const artifact of this.sources.values()) {
          // An aborted first write may never reach disk. Keep the captured preview,
          // but stop its loading state; the corresponding tool still reports its failure.
          if (artifact.streaming && (active.has(artifact.path) || artifact.revision <= revision) && !saved.has(artifact.path)) this.publish({ ...artifact, streaming: active.has(artifact.path), revision: ++this.revision, importsRevision: revision });
        }
      }
    })().finally(() => { this.scanning = undefined; });
    return this.scanning;
  }
  private publish(artifact: Artifact) { this.sources.set(artifact.path, artifact); this.emit({ type: 'data-artifact', id: artifact.path, data: artifact }); }
  private settle(toolCallId: string) {
    const path = this.drafts.get(toolCallId);
    this.drafts.delete(toolCallId); this.inputs.delete(toolCallId); this.names.delete(toolCallId);
    if (!path) return false;
    const source = this.sources.get(path);
    if (source) this.sources.set(path, { ...source, revision: ++this.revision });
    return true;
  }
  accept(chunk: ChatChunk) {
    if (this.closed) return;
    if (chunk.type === 'tool-input-start') { this.names.set(chunk.toolCallId, chunk.toolName); return; }
    if (chunk.type === 'tool-input-error' || chunk.type === 'tool-output-error' || chunk.type === 'tool-output-denied' || (chunk.type === 'tool-output-available' && !chunk.preliminary)) {
      if (this.settle(chunk.toolCallId)) void this.refresh().catch(() => {});
      return;
    }
    if (chunk.type !== 'tool-input-delta' && chunk.type !== 'tool-input-available') return;
    // Only full-file writes produce speculative frames. An edit's new_string is not a whole module.
    // Checked before accumulating: every other tool's input would be parsed once per delta and thrown away.
    if (!/write|create/i.test(chunk.type === 'tool-input-available' ? chunk.toolName : this.names.get(chunk.toolCallId) ?? '')) return;
    try {
      let input: Record<string, unknown>;
      if (chunk.type === 'tool-input-delta') {
        const json = (this.inputs.get(chunk.toolCallId) ?? '') + chunk.inputTextDelta;
        this.inputs.set(chunk.toolCallId, json); input = parse(json) as Record<string, unknown>;
      } else input = chunk.input as Record<string, unknown>;
      const path = input?.file_path ?? input?.path ?? input?.filePath;
      if (typeof path !== 'string' || typeof input.content !== 'string') return;
      const rel = relative(this.cwd, ui4aPath(this.cwd, path)).split(sep).join('/');
      if (!isArtifactEntry(rel)) return;
      this.drafts.set(chunk.toolCallId, rel);
      if (this.sources.get(rel)?.source === input.content && this.sources.get(rel)?.streaming) return;
      this.publish({ path: rel, source: input.content, streaming: true, revision: ++this.revision, importsRevision: this.sources.get(rel)?.importsRevision });
    } catch { /* Partial JSON and paths are expected while the native tool input is streaming. */ }
  }
  async finish() {
    // Stop new scan producers before taking the final disk snapshot. Otherwise an
    // already queued watcher can emit after finish and reopen a supposedly settled artifact.
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    for (const toolCallId of this.drafts.keys()) this.settle(toolCallId);
    await this.refresh();
    this.closed = true;
  }
  async close() { this.closed = true; for (const watcher of this.watchers) watcher.close(); this.watchers = []; this.drafts.clear(); this.inputs.clear(); this.names.clear(); await this.scanning?.catch(() => {}); }
}
