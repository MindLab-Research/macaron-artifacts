import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { PROJECTS_ROOT } from '../config.js';
import { encodeClaudeProjectName, registerProjectCwd } from '../lib/project-registry.js';

type CreateBody = { name?: string; gitUrl?: string; parent?: string };

// A project name that's safe as a single path segment: no separators, no
// traversal, no leading dot/dash. Mirrors the slug git itself derives from a
// clone URL, so a cloned repo and a hand-typed name validate the same way.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_NAME_LENGTH = 100;
const CLONE_TIMEOUT_MS = 10 * 60_000;

// Accept the URL forms `git clone` handles over the network. Local-path and
// `file://` clones are rejected — this endpoint is for pulling remote repos
// into the workspace root, not copying arbitrary local dirs.
function isAllowedGitUrl(url: string): boolean {
  if (url.startsWith('-')) return false; // never let the URL be read as a flag
  return /^https:\/\/[^\s]+$/.test(url) || /^git@[^\s]+:[^\s]+$/.test(url) || /^ssh:\/\/[^\s]+$/.test(url);
}

// `https://github.com/owner/repo(.git)` → `repo`. Undefined if no usable slug.
function repoNameFromUrl(url: string): string | undefined {
  const normalized = url.replace(/[/]+$/, '').replace(/\.git$/, '');
  try {
    const u = new URL(normalized);
    const parts = u.pathname.split('/').filter(Boolean);
    const slug = parts.at(-1);
    if (slug && NAME_RE.test(slug)) return slug;
  } catch {
    /* scp-style git@host:owner/repo falls through */
  }
  const tail = normalized.split(/[/:]/).pop() || '';
  return NAME_RE.test(tail) ? tail : undefined;
}

function runGitClone(gitUrl: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // argv form + shell:false → the URL can never be interpreted by a shell.
    // `--` stops flag parsing; GIT_TERMINAL_PROMPT=0 fails fast instead of
    // hanging on a credentials prompt for a private repo.
    const child = spawn('git', ['clone', '--', gitUrl, dest], {
      shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let stderr = '';
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve();
    };
    timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error(`git clone timed out after ${Math.round(CLONE_TIMEOUT_MS / 60_000)} minutes`));
    }, CLONE_TIMEOUT_MS);
    child.stderr.on('data', (d) => {
      stderr += String(d);
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    child.on('error', (e) => finish(e));
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(stderr.trim().split('\n').pop() || `git clone exited ${code}`));
    });
  });
}

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  // Create a new project directory (optionally by cloning a git repo) under
  // PROJECTS_ROOT, then hand back the claude project id + real cwd so the UI
  // can start a session there. The dir must not already exist.
  app.post<{ Body: CreateBody }>('/api/projects', async (req, reply) => {
    const gitUrl = String(req.body?.gitUrl || '').trim();
    let name = String(req.body?.name || '').trim();
    const parentInput = String(req.body?.parent || '').trim();

    if (gitUrl) {
      if (!isAllowedGitUrl(gitUrl)) {
        return reply.status(400).send({ error: 'gitUrl must be an https/ssh git remote' });
      }
      if (!name) name = repoNameFromUrl(gitUrl) || '';
      if (!name) return reply.status(400).send({ error: 'could not derive a name from gitUrl — pass name explicitly' });
    }

    if (!NAME_RE.test(name)) {
      return reply.status(400).send({ error: 'name must start alphanumeric and contain only letters, digits, . _ -' });
    }
    if (name.length > MAX_NAME_LENGTH) {
      return reply.status(400).send({ error: `name must be ${MAX_NAME_LENGTH} characters or fewer` });
    }

    // Parent directory: caller-supplied absolute path (from the DirPicker in
    // NewProjectModal) or the default `PROJECTS_ROOT`. Must exist and be a
    // real directory — refusing to auto-mkdir a caller-picked path avoids
    // typo-blows-away-your-home surprises.
    let parentDir = PROJECTS_ROOT;
    if (parentInput) {
      if (!path.isAbsolute(parentInput)) {
        return reply.status(400).send({ error: 'parent must be an absolute path' });
      }
      const resolvedParent = path.resolve(parentInput);
      try {
        const st = await fs.stat(resolvedParent);
        if (!st.isDirectory()) {
          return reply.status(400).send({ error: 'parent is not a directory' });
        }
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        return reply.status(400).send({ error: `parent not accessible: ${err.code || err.message}` });
      }
      parentDir = resolvedParent;
    }

    const dest = path.join(parentDir, name);
    // Defense in depth: even though NAME_RE forbids separators, confirm the
    // resolved path is still a direct child of the chosen parent.
    if (path.dirname(path.resolve(dest)) !== path.resolve(parentDir)) {
      return reply.status(400).send({ error: 'resolved path escapes the chosen parent' });
    }

    try {
      // Only auto-mkdir for the default PROJECTS_ROOT — a user-picked parent
      // was already stat'd above, so we know it exists.
      if (parentDir === PROJECTS_ROOT) await fs.mkdir(PROJECTS_ROOT, { recursive: true });
      const encodedDest = encodeClaudeProjectName(dest);
      for (const sibling of await fs.readdir(parentDir)) {
        if (sibling === name || sibling.startsWith('.')) continue;
        if (encodeClaudeProjectName(path.join(parentDir, sibling)) === encodedDest) {
          return reply.status(409).send({ error: `name collides with existing project "${sibling}" in Claude's project encoding` });
        }
      }
      // `mkdir` without recursive throws EEXIST if the dir is already there.
      // For a git-clone request, EEXIST is a hard collision (git refuses to
      // clone into non-empty). For a plain create, an already-there dir that
      // is empty is a leftover from a prior "Delete Workspace" (the sidebar
      // action drops sessions but not the disk dir) — just adopt it silently
      // instead of forcing the user to `rm -rf` behind our back. A non-empty
      // dir still errors, with a message that names the actual obstacle.
      try {
        await fs.mkdir(dest);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'EEXIST') throw err;
        if (gitUrl) throw err;                          // clone needs empty target
        let entries: string[];
        try { entries = await fs.readdir(dest); }
        catch (readErr) {
          return reply.status(409).send({
            error: `directory ${dest} exists but is unreadable (${(readErr as NodeJS.ErrnoException).code || 'unknown'}) — remove it or pick a different name`,
          });
        }
        // Ignore purely hidden metadata (a stray .DS_Store from Finder, a
        // .git shell from a prior init) so a "looks empty" folder still
        // adopts cleanly. Any other file / dir means real content.
        const meaningful = entries.filter((n) => !['.DS_Store', '.git', '.gitignore', '.gitkeep'].includes(n));
        if (meaningful.length > 0) {
          return reply.status(409).send({
            error: `directory ${dest} already exists on disk with ${meaningful.length} file${meaningful.length === 1 ? '' : 's'} inside — pick a different name, or remove it (\`rm -rf "${dest}"\`) to start fresh`,
          });
        }
        // Fall through: empty (or metadata-only) dir → we'll just register it.
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      return reply.status(500).send({ error: `mkdir failed: ${err.code || err.message}` });
    }

    if (gitUrl) {
      try {
        await runGitClone(gitUrl, dest);
      } catch (e) {
        await fs.rm(dest, { recursive: true, force: true }); // don't leave a half-cloned dir behind
        return reply.status(422).send({ error: `git clone failed: ${(e as Error).message}` });
      }
    }

    // Register the real cwd so the (lossy) project→cwd decode in the session
    // route resolves correctly for this brand-new, session-less directory.
    const project = await registerProjectCwd(dest);
    return { project, cwd: dest, name };
  });

  // Default parent dir for New Project — the UI shows this so the user can
  // see where "no parent chosen" will drop the folder.
  app.get('/api/projects/default-parent', async () => ({ path: PROJECTS_ROOT }));
}
