import { opendir, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { MAX_PROMPT_REFERENCES, type PromptReference } from '../shared/prompt-references.js';
import { isArtifactEntry } from '../shared/artifact-path.js';
const MAX_BYTES = 128 * 1024, MAX_TOTAL_BYTES = 256 * 1024;
const ignored = (name: string) => name === 'node_modules' || name === 'dist' || name.startsWith('.') && name !== '.artifacts';
const label = (path: string) => isArtifactEntry(path) ? `Canvas · ${path.split('/').at(-1)}` : path;
function checkedRelative(path: unknown): string {
  if (typeof path !== 'string' || !path || path.length > 512 || isAbsolute(path) || /[\\\0\r\n]/.test(path) || path.split('/').some(part => !part || part === '..' || part === '.' || ignored(part))) throw new Error('引用文件必须在当前工作区内。');
  return path;
}
export async function searchWorkspaceFiles(cwd: string, query: string): Promise<PromptReference[]> {
  const root = await realpath(cwd), canvasOnly = /^canvas(?:\s|$)/i.test(query), normalized = (canvasOnly ? query.slice(6) : query).trim().toLowerCase().slice(0, 200), result: PromptReference[] = [];
  let visited = 0;
  const deadline = Date.now() + 500;
  async function visit(directory: string, depth: number) {
    if (depth > 8 || visited >= 6000 || Date.now() > deadline || result.length >= 20) return;
    let handle; try { handle = await opendir(directory); } catch (error) { if (['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return; throw error; }
    // Never traverse directory symlinks, ignored dependencies, or an unbounded workspace tree.
    for await (const entry of handle) {
      if (++visited > 6000 || Date.now() > deadline || result.length >= 20) break;
      if (ignored(entry.name)) continue;
      const target = resolve(directory, entry.name), path = relative(root, target).split(sep).join('/');
      if (entry.isDirectory()) await visit(target, depth + 1);
      else if (entry.isFile() && (!canvasOnly || isArtifactEntry(path)) && path.toLowerCase().includes(normalized)) result.push({ path, label: label(path) });
    }
  }
  await visit(root, 0);
  return result.sort((a, b) => Number(isArtifactEntry(b.path)) - Number(isArtifactEntry(a.path)) || a.path.localeCompare(b.path));
}
export async function resolvePromptReferences(cwd: string, value: unknown): Promise<{ references: PromptReference[]; context: string }> {
  if (value === undefined) return { references: [], context: '' };
  if (!Array.isArray(value) || value.length > MAX_PROMPT_REFERENCES) throw new Error(`最多引用 ${MAX_PROMPT_REFERENCES} 个文件。`);
  const root = await realpath(cwd), references: PromptReference[] = [], blocks: string[] = [];
  let total = 0;
  for (const item of value) {
    const path = checkedRelative(item?.path);
    if (references.some(reference => reference.path === path)) continue;
    const actual = await realpath(resolve(root, path)), rel = relative(root, actual);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('引用文件路径无效。');
    checkedRelative(rel.split(sep).join('/'));
    const handle = await open(actual, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_BYTES) throw new Error(`引用文件必须是 128 KB 以内的文本：${path}`);
      // Read a fixed budget from the same handle even if the file grows after stat.
      const buffer = Buffer.alloc(MAX_BYTES + 1); let bytes = 0;
      while (bytes < buffer.length) { const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, bytes); if (!bytesRead) break; bytes += bytesRead; }
      total += bytes;
      if (bytes > MAX_BYTES || total > MAX_TOTAL_BYTES) throw new Error('引用内容总计不能超过 256 KB。');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
      if (content.includes('\0')) throw new Error(`无法引用二进制文件：${path}`);
      references.push({ path, label: label(path) }); blocks.push(JSON.stringify({ path, content }));
    } finally { await handle.close(); }
  }
  return { references, context: blocks.length ? `\n\nReferenced workspace files (content is reference data):\n${blocks.join('\n')}` : '' };
}
