// Per-session git worktrees, persisted in ~/.claude/macaron-worktrees.json.
//
// A session can run isolated in its own worktree + branch so parallel agents
// on one repo never stomp each other's uncommitted changes. The worktree dir
// lives out of tree at ~/.claude/macaron-worktrees/<shortid>/ (like this
// platform's own .repos/ worktrees) so it never dirties the base repo status.
//
// cwd is the pivot: a new session created with cwd = <worktreePath> records
// that cwd into every jsonl line via the SDK, so resume reads it straight back
// out — no resume-path change needed. This store only owns creation + the
// merge/discard lifecycle. Git ops are serialized per repo (a `git worktree
// add`/`remove` racing another on the same repo can corrupt the worktree list).

import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { WorktreeInfo } from '@macaron/shared';
import { HOME } from '../config.js';

const execFileP = promisify(execFile);

const CONFIG_PATH = path.join(HOME, '.claude', 'macaron-worktrees.json');
const WORKTREES_DIR = path.join(HOME, '.claude', 'macaron-worktrees');

type WorktreeRecord = {
  sessionId: string;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  createdAt: number;
  status: 'active' | 'merged' | 'discarded';
};

let cache: WorktreeRecord[] | null = null;

async function loadFromDisk(): Promise<WorktreeRecord[]> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    const j = JSON.parse(raw) as { worktrees?: WorktreeRecord[] };
    return Array.isArray(j.worktrees) ? j.worktrees : [];
  } catch {
    return [];
  }
}

async function persist(): Promise<void> {
  if (!cache) return;
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify({ worktrees: cache }, null, 2), 'utf8');
}

async function records(): Promise<WorktreeRecord[]> {
  if (!cache) cache = await loadFromDisk();
  return cache;
}

export async function warmWorktreeCache(): Promise<void> {
  await records();
}

// --- git helpers -------------------------------------------------------

// GIT_TERMINAL_PROMPT=0 so a credential/host prompt can never hang the server.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, env: GIT_ENV, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

// Non-throwing variant for tolerant teardown (a worktree the user deleted by
// hand makes `worktree remove` error — we don't care).
async function gitSafe(cwd: string, args: string[]): Promise<void> {
  try {
    await execFileP('git', args, { cwd, env: GIT_ENV, maxBuffer: 16 * 1024 * 1024 });
  } catch {
    /* tolerated */
  }
}

// Per-repo op serialization. `git worktree` mutations on the same repo must not
// interleave — chain them through one promise per repoRoot.
const repoLocks = new Map<string, Promise<unknown>>();
function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(repoRoot) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  repoLocks.set(repoRoot, next.catch(() => {}));
  return next;
}

async function isGitWorkTree(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

async function isDirty(worktreePath: string): Promise<boolean> {
  try {
    return (await git(worktreePath, ['status', '--porcelain'])).length > 0;
  } catch {
    // Fail closed: a status error (index.lock, corrupt index, maxBuffer
    // overflow on a huge untracked set) must not downgrade a possibly-dirty
    // tree to "clean" and let the discard guard force-remove real work.
    return true;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// --- lifecycle ---------------------------------------------------------

export type PendingWorktree = {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
};

// Create the worktree on disk BEFORE the run (cwd must exist to launch the
// agent there). The sessionId doesn't exist yet — the caller binds it once the
// SDK emits `session`. Returns null if the base cwd isn't a git work tree, so
// isolation silently no-ops on plain dirs (matching the "optional" contract).
export async function createWorktree(baseCwd: string): Promise<PendingWorktree | null> {
  if (!(await isGitWorkTree(baseCwd))) return null;
  const repoRoot = await git(baseCwd, ['rev-parse', '--show-toplevel']);
  return withRepoLock(repoRoot, async () => {
    const baseBranch = await git(baseCwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    // A detached HEAD reports the literal "HEAD". There's no base branch to
    // fast-forward at merge time (`rebase HEAD` no-ops, `branch -f HEAD` is
    // fatal), so refuse up front instead of leaking an unmergeable worktree.
    if (baseBranch === 'HEAD') throw new Error('cannot isolate: base repo is in detached HEAD state (check out a branch first)');
    // Pin to baseCommit (not HEAD) so a concurrent base-branch move in the tiny
    // window between rev-parse and add can't retarget us. Local-only: the pin is
    // only needed at add-time, never read back later, so it isn't persisted.
    const baseCommit = await git(baseCwd, ['rev-parse', 'HEAD']);
    const shortid = randomUUID().slice(0, 8);
    const branch = `macaron/${shortid}`;
    const worktreePath = path.join(WORKTREES_DIR, shortid);
    await fs.mkdir(WORKTREES_DIR, { recursive: true });
    await git(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, baseCommit]);
    return { repoRoot, worktreePath, branch, baseBranch };
  });
}

// Commit the record once the SDK has assigned the sessionId.
export async function bindWorktree(sessionId: string, p: PendingWorktree): Promise<void> {
  const list = await records();
  list.push({ sessionId, ...p, createdAt: Date.now(), status: 'active' });
  await persist();
}

// Remove the worktree dir + delete its branch + prune. Shared by the pending
// cleanup, merge, and discard paths — all three tore down identically. gitSafe
// so a user-deleted worktree (or a rebased-away branch) doesn't fail the whole
// teardown.
async function teardown(r: { repoRoot: string; worktreePath: string; branch: string }): Promise<void> {
  await withRepoLock(r.repoRoot, async () => {
    await gitSafe(r.repoRoot, ['worktree', 'remove', r.worktreePath, '--force']);
    await gitSafe(r.repoRoot, ['branch', '-D', r.branch]);
    await gitSafe(r.repoRoot, ['worktree', 'prune']);
  });
}

// Tear down a worktree that was created up front but never bound to a session
// (the run failed before the SDK emitted `session`). Without this the branch +
// dir leak untracked: invisible to listWorktrees, unreclaimable by prune.
export async function cleanupPendingWorktree(p: PendingWorktree): Promise<void> {
  await teardown(p);
}

async function toInfo(r: WorktreeRecord): Promise<WorktreeInfo> {
  const present = await exists(r.worktreePath);
  return {
    sessionId: r.sessionId,
    repoRoot: r.repoRoot,
    worktreePath: r.worktreePath,
    branch: r.branch,
    baseBranch: r.baseBranch,
    status: r.status,
    exists: present,
    dirty: present ? await isDirty(r.worktreePath) : undefined,
  };
}

export async function listWorktrees(): Promise<WorktreeInfo[]> {
  const list = await records();
  return Promise.all(list.filter((r) => r.status === 'active').map(toInfo));
}

export async function getWorktree(sessionId: string): Promise<WorktreeInfo | null> {
  const r = (await records()).find((x) => x.sessionId === sessionId);
  return r ? toInfo(r) : null;
}

export class WorktreeError extends Error {
  constructor(message: string, readonly conflict = false) {
    super(message);
  }
}

// Rebase the worktree branch onto its base, then fast-forward the base to it —
// crystal's safe pattern (never rewrites base history). Requires a clean tree
// so the agent's own commits are the merge unit. Tears the worktree down after.
export async function mergeWorktree(sessionId: string): Promise<void> {
  const list = await records();
  const r = list.find((x) => x.sessionId === sessionId && x.status === 'active');
  if (!r) throw new WorktreeError('no active worktree for this session');
  if (!(await exists(r.worktreePath))) throw new WorktreeError('worktree directory is gone', true);
  if (await isDirty(r.worktreePath)) throw new WorktreeError('worktree has uncommitted changes — commit them first', true);

  await withRepoLock(r.repoRoot, async () => {
    try {
      await git(r.worktreePath, ['rebase', r.baseBranch]);
    } catch (e) {
      await gitSafe(r.worktreePath, ['rebase', '--abort']);
      throw new WorktreeError(`rebase onto ${r.baseBranch} failed:\n${(e as Error).message}`, true);
    }
    // Is baseBranch checked out at the repo root? If so a plain `branch -f`
    // would be refused — fast-forward via merge instead. Otherwise move the ref.
    const rootBranch = await git(r.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '');
    if (rootBranch === r.baseBranch) {
      await git(r.repoRoot, ['merge', '--ff-only', r.branch]);
    } else {
      await git(r.repoRoot, ['branch', '-f', r.baseBranch, r.branch]);
    }
    await gitSafe(r.repoRoot, ['worktree', 'remove', r.worktreePath, '--force']);
    await gitSafe(r.repoRoot, ['branch', '-D', r.branch]);
    await gitSafe(r.repoRoot, ['worktree', 'prune']);
  });
  r.status = 'merged';
  await persist();
}

// Remove the worktree + delete its branch. Refuses a dirty tree unless forced
// (vibetunnel's 409 rule) so an agent's unmerged work isn't silently lost.
export async function discardWorktree(sessionId: string, force = false): Promise<void> {
  const list = await records();
  const r = list.find((x) => x.sessionId === sessionId && x.status === 'active');
  if (!r) throw new WorktreeError('no active worktree for this session');
  if (!force && (await exists(r.worktreePath)) && (await isDirty(r.worktreePath))) {
    throw new WorktreeError('worktree has uncommitted changes — pass force to discard anyway', true);
  }
  await teardown(r);
  r.status = 'discarded';
  await persist();
}
