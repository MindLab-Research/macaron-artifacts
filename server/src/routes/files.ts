import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import ignore from 'ignore';
import type { FileEntry, FileListResponse, FileReadResponse } from '@macaron/shared';
import { resolveProjectCwd } from '../lib/session-store.js';

// Files this API never lists, regardless of .gitignore. .git/node_modules are
// noise; everything else the project's own .gitignore decides.
const ALWAYS_HIDE = ['.git', 'node_modules'];

// Reads capped at 1 MB — the editor is for source, not blobs. Writes ride the
// server's global 2 MB bodyLimit.
const MAX_READ_BYTES = 1024 * 1024;

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

// Confine a client-supplied relative path to the project root. Returns the
// absolute path, or null if it escapes (symlinks resolved via realpath). The
// root itself is realpath'd so a symlinked cwd still matches its children.
async function confine(root: string, rel: string, mode: 'target' | 'parent' = 'target'): Promise<string | null> {
  const realRoot = await fs.realpath(root).catch(() => path.resolve(root));
  const abs = path.resolve(realRoot, rel);
  if (!isInside(realRoot, abs)) return null;
  const realTarget = mode === 'parent'
    ? await fs.realpath(abs).catch(async (e) => (e?.code === 'ENOENT' ? fs.realpath(path.dirname(abs)).catch(() => null) : null))
    : await fs.realpath(abs).catch(() => abs);
  if (!realTarget || !isInside(realRoot, realTarget)) return null;
  return abs;
}

// Build a gitignore matcher from <root>/.gitignore and each nested
// .gitignore above the listed directory. Always augmented with ALWAYS_HIDE.
async function loadIgnore(root: string, rel: string): Promise<ReturnType<typeof ignore>> {
  const ig = ignore().add(ALWAYS_HIDE);
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  for (let i = 0; i <= parts.length; i++) {
    const dirRel = parts.slice(0, i).join('/');
    try {
      const body = await fs.readFile(path.join(root, dirRel, '.gitignore'), 'utf8');
      ig.add(body.split(/\r?\n/).map((line) => {
        if (!dirRel || !line || line.startsWith('#')) return line;
        const negated = line.startsWith('!');
        const pattern = negated ? line.slice(1) : line;
        const anchored = pattern.startsWith('/');
        const prefixed = `${dirRel}/${anchored ? pattern.slice(1) : pattern}`;
        return `${negated ? '!' : ''}${prefixed}`;
      }).join('\n'));
    } catch {
      /* no .gitignore at this level */
    }
  }
  return ig;
}

// True if a relative path is hidden by .gitignore or ALWAYS_HIDE. Used to keep
// read/write consistent with list — otherwise the tree hides .env / .git while
// read still serves them by name and write can clobber them (#23 asks for a
// .gitignore-aware explorer, not just a .gitignore-aware *listing*).
async function isIgnored(root: string, rel: string): Promise<boolean> {
  const dir = path.dirname(rel);
  const ig = await loadIgnore(root, dir === '.' ? '' : dir);
  return ig.ignores(rel.split(path.sep).join('/'));
}

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  // List one directory (lazy — the tree fetches children on expand). `path`
  // is relative to the project cwd; '' or omitted = root.
  app.get<{ Params: { project: string }; Querystring: { path?: string } }>(
    '/api/files/:project/list',
    async (req, reply) => {
      const root = await resolveProjectCwd(req.params.project);
      if (!root) return reply.status(404).send({ error: 'unknown project' });
      const rel = req.query.path || '';
      const abs = await confine(root, rel);
      if (!abs) return reply.status(403).send({ error: 'path escapes project root' });

      let dirents;
      try {
        dirents = await fs.readdir(abs, { withFileTypes: true });
      } catch (e) {
        return reply.status(404).send({ error: (e as Error).message });
      }

      const ig = await loadIgnore(root, rel);
      const entries: FileEntry[] = [];
      for (const d of dirents) {
        const childRel = path.join(rel, d.name);
        const isDir = d.isDirectory();
        // ignore matches on posix-style relative paths; dirs need a trailing
        // slash for directory-only patterns to catch.
        const test = childRel.split(path.sep).join('/') + (isDir ? '/' : '');
        if (ig.ignores(test)) continue;
        const entry: FileEntry = { name: d.name, path: childRel, type: isDir ? 'dir' : 'file' };
        if (!isDir) {
          try {
            const st = await fs.stat(abs + path.sep + d.name);
            entry.size = st.size;
            entry.mtime = st.mtimeMs;
          } catch {
            /* stat may race a delete — list it without size */
          }
        }
        entries.push(entry);
      }
      // Directories first, then case-insensitive name order.
      entries.sort((a, b) =>
        a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name),
      );
      return { root, path: rel, entries } satisfies FileListResponse;
    },
  );

  // Read a file as utf8 text. Rejects oversized (413) and binary (415) files —
  // the editor only handles text.
  app.get<{ Params: { project: string }; Querystring: { path?: string } }>(
    '/api/files/:project/read',
    async (req, reply) => {
      const root = await resolveProjectCwd(req.params.project);
      if (!root) return reply.status(404).send({ error: 'unknown project' });
      const rel = req.query.path || '';
      if (!rel) return reply.status(400).send({ error: 'path required' });
      const abs = await confine(root, rel);
      if (!abs) return reply.status(403).send({ error: 'path escapes project root' });
      // Hidden in the tree must mean hidden by name too — don't serve .env / .git.
      if (await isIgnored(root, rel)) return reply.status(403).send({ error: 'path is ignored' });

      let st;
      try {
        st = await fs.stat(abs);
      } catch (e) {
        return reply.status(404).send({ error: (e as Error).message });
      }
      if (!st.isFile()) return reply.status(400).send({ error: 'not a file' });
      if (st.size > MAX_READ_BYTES) {
        return reply.status(413).send({ error: `file too large (${st.size} bytes, max ${MAX_READ_BYTES})` });
      }

      const buf = await fs.readFile(abs);
      // NUL byte in the head → treat as binary (same heuristic git uses).
      if (buf.subarray(0, 8000).includes(0)) {
        return reply.status(415).send({ error: 'binary file', binary: true });
      }
      return { path: rel, content: buf.toString('utf8'), size: st.size } satisfies FileReadResponse;
    },
  );

  // Serve a file's raw bytes with a best-effort Content-Type — used by
  // <FileTile>'s image preview. Same confinement + ignore gate as /read.
  app.get<{ Params: { project: string }; Querystring: { path?: string } }>(
    '/api/files/:project/raw',
    async (req, reply) => {
      const root = await resolveProjectCwd(req.params.project);
      if (!root) return reply.status(404).send({ error: 'unknown project' });
      const rel = req.query.path || '';
      if (!rel) return reply.status(400).send({ error: 'path required' });
      const abs = await confine(root, rel);
      if (!abs) return reply.status(403).send({ error: 'path escapes project root' });
      if (await isIgnored(root, rel)) return reply.status(403).send({ error: 'path is ignored' });

      let st;
      try { st = await fs.stat(abs); }
      catch (e) { return reply.status(404).send({ error: (e as Error).message }); }
      if (!st.isFile()) return reply.status(400).send({ error: 'not a file' });
      if (st.size > MAX_READ_BYTES) {
        return reply.status(413).send({ error: `file too large (${st.size} bytes, max ${MAX_READ_BYTES})` });
      }

      const ext = rel.toLowerCase().split('.').pop() || '';
      const ct: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
      };
      const buf = await fs.readFile(abs);
      reply
        .header('Content-Type', ct[ext] || 'application/octet-stream')
        .header('Cache-Control', 'no-cache')
        .send(buf);
    },
  );

  // Overwrite an existing-or-new file under the project root. The parent
  // directory must already exist (no recursive mkdir — keep writes boring).
  app.put<{ Params: { project: string }; Body: { path?: string; content?: string } }>(
    '/api/files/:project/write',
    async (req, reply) => {
      const root = await resolveProjectCwd(req.params.project);
      if (!root) return reply.status(404).send({ error: 'unknown project' });
      const rel = String(req.body?.path || '');
      if (!rel) return reply.status(400).send({ error: 'path required' });
      if (typeof req.body?.content !== 'string') {
        return reply.status(400).send({ error: 'content required' });
      }
      const abs = await confine(root, rel, 'parent');
      if (!abs) return reply.status(403).send({ error: 'path escapes project root' });
      // Refuse writes to ignored paths (.git internals, node_modules, gitignored
      // secrets) — same gate as read, so the tree's hidden set is enforced.
      if (await isIgnored(root, rel)) return reply.status(403).send({ error: 'path is ignored' });

      try {
        const parent = await fs.stat(path.dirname(abs));
        if (!parent.isDirectory()) throw new Error('parent is not a directory');
      } catch (e) {
        return reply.status(400).send({ error: `parent directory unusable: ${(e as Error).message}` });
      }
      try {
        await fs.writeFile(abs, req.body.content, 'utf8');
      } catch (e) {
        return reply.status(500).send({ error: (e as Error).message });
      }
      return { ok: true, bytes: Buffer.byteLength(req.body.content, 'utf8') };
    },
  );
}
