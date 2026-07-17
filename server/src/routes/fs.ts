import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DirListing } from '@macaron/shared';

// Expand a leading `~` against the user's home, then resolve to an absolute
// path. Empty input defaults to home so the picker opens somewhere useful.
function resolveDir(input: string): string {
  const home = os.homedir();
  const raw = input.trim();
  if (!raw) return home;
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return path.join(home, raw.slice(2));
  return path.resolve(raw);
}

export async function registerFsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { path?: string | string[] } }>('/api/fs/dirs', async ({ query }): Promise<DirListing> => {
    const home = os.homedir();
    // A repeated `?path=` makes Fastify hand us an array; take the first so a
    // malformed request still degrades to an empty listing instead of throwing
    // inside resolveDir (which would 500, breaking the never-500 contract).
    const raw = Array.isArray(query.path) ? query.path[0] ?? '' : query.path ?? '';
    const resolved = resolveDir(raw);
    const parent = path.dirname(resolved);
    const base = { path: resolved, parent: parent === resolved ? null : parent, home };
    try {
      const dirents = await fs.readdir(resolved, { withFileTypes: true });
      const entries = dirents
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => ({ name: d.name, path: path.join(resolved, d.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      return { ...base, entries };
    } catch {
      // Unreadable/nonexistent path (EACCES/ENOENT) — degrade to empty rather
      // than 500, so the picker can still show breadcrumbs and back-nav.
      return { ...base, entries: [] };
    }
  });
}
