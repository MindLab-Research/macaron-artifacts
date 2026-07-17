// Thin wrapper around the `git` CLI for the WebUI git panel and Create-PR
// action. Every call uses execFile argv arrays with shell:false.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  CreatePrResult,
  GitBranches,
  GitFileStatus,
  GitStatus,
  PrContext,
} from '@macaron/shared';

const pExecFile = promisify(execFile);

export class GitError extends Error {
  constructor(message: string, readonly code: number | null) {
    super(message);
  }
}

// Run `git <args>` in cwd. `okExitCodes` accepts git's "difference found"
// exit 1 for diff --no-index while preserving real failures.
async function git(
  cwd: string,
  args: string[],
  okExitCodes: number[] = [0],
): Promise<string> {
  try {
    const { stdout } = await pExecFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string; message?: string };
    if (typeof err.code === 'number' && okExitCodes.includes(err.code)) {
      const out = err.stdout || '';
      if (out || !(err.stderr || '').trim()) return out;
    }
    throw new GitError((err.stderr || err.stdout || err.message || 'git failed').trim(), err.code ?? null);
  }
}

async function gh(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await pExecFile('gh', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

// Repo-relative porcelain paths and pathspecs must run from the repo root.
async function gitRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

function safeRelPath(cwd: string, rel: string): string {
  const abs = path.resolve(cwd, rel);
  const root = path.resolve(cwd);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new GitError(`path escapes workspace: ${rel}`, null);
  }
  return abs;
}

function parseStatus(z: string): GitFileStatus[] {
  const parts = z.split('\0');
  const files: GitFileStatus[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const x = rec[0]!;
    const y = rec[1]!;
    const rest = rec.slice(3);
    let renamedFrom: string | undefined;
    const filePath = rest;
    if (x === 'R' || x === 'C') {
      renamedFrom = parts[++i] || undefined;
    }
    const untracked = x === '?' && y === '?';
    files.push({
      path: filePath,
      x,
      y,
      staged: !untracked && x !== ' ',
      unstaged: y !== ' ' && y !== '?',
      untracked,
      renamedFrom,
    });
  }
  return files;
}

export async function status(cwd: string): Promise<GitStatus> {
  let root = '';
  try {
    root = await gitRoot(cwd);
  } catch {
    return {
      isRepo: false,
      branch: '',
      detached: false,
      hasCommits: false,
      ahead: 0,
      behind: 0,
      files: [],
    };
  }

  const hasCommits = await git(cwd, ['rev-parse', '--verify', 'HEAD'])
    .then(() => true)
    .catch(() => false);
  const onBranch = (await git(cwd, ['symbolic-ref', '--short', 'HEAD']).catch(() => '')).trim();
  const detached = !onBranch;
  let branch = onBranch;
  if (detached) {
    branch = hasCommits
      ? (await git(cwd, ['rev-parse', '--short', 'HEAD']).catch(() => 'HEAD')).trim()
      : 'HEAD';
  }

  let ahead = 0;
  let behind = 0;
  let upstream: string | undefined;
  if (hasCommits && !detached) {
    upstream = (await git(cwd, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}',
    ]).catch(() => '')).trim() || undefined;
    if (upstream) {
      const counts = (await git(cwd, [
        'rev-list',
        '--count',
        '--left-right',
        `${upstream}...HEAD`,
      ]).catch(() => '')).trim();
      const values = counts.split(/\s+/);
      behind = Number(values[0]) || 0;
      ahead = Number(values[1]) || 0;
    }
  }

  const z = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  return {
    isRepo: true,
    branch,
    detached,
    hasCommits,
    ahead,
    behind,
    upstream,
    files: parseStatus(z),
  };
}

export async function diff(
  cwd: string,
  file: string,
  opts: { staged?: boolean; untracked?: boolean } = {},
): Promise<string> {
  const root = await gitRoot(cwd);
  if (opts.untracked) {
    const abs = safeRelPath(root, file);
    return git(root, ['diff', '--no-index', '--', '/dev/null', abs], [0, 1]);
  }
  const args = ['diff', '--no-color'];
  if (opts.staged) args.push('--cached');
  args.push('--', file);
  return git(root, args);
}

export async function stage(cwd: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  await git(await gitRoot(cwd), ['add', '--', ...files]);
}

export async function unstage(cwd: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  const root = await gitRoot(cwd);
  const hasCommits = await git(root, ['rev-parse', '--verify', 'HEAD'])
    .then(() => true)
    .catch(() => false);
  if (hasCommits) await git(root, ['restore', '--staged', '--', ...files]);
  else await git(root, ['rm', '--cached', '-r', '--', ...files]);
}

export async function commit(cwd: string, message: string, all: boolean): Promise<string> {
  const args = ['commit'];
  if (all) args.push('-a');
  args.push('-m', message);
  return git(await gitRoot(cwd), args);
}

export async function branches(cwd: string): Promise<GitBranches> {
  const current = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  const out = await git(cwd, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
  ]).catch(() => '');
  const list = out.split('\n').map((line) => line.trim()).filter(Boolean);
  return { current, branches: list };
}

export async function checkout(cwd: string, branch: string, create: boolean): Promise<string> {
  if (branch.startsWith('-')) throw new GitError(`invalid branch name: ${branch}`, null);
  const args = create ? ['switch', '-c', branch] : ['switch', branch];
  return git(await gitRoot(cwd), args);
}

async function resolveDefaultBranch(cwd: string): Promise<string> {
  try {
    const ref = (await git(cwd, [
      'symbolic-ref',
      '--short',
      'refs/remotes/origin/HEAD',
    ])).trim();
    const name = ref.replace(/^origin\//, '').trim();
    if (name) return name;
  } catch {
    /* origin/HEAD not set - try gh */
  }
  try {
    const name = await gh(cwd, [
      'repo',
      'view',
      '--json',
      'defaultBranchRef',
      '--jq',
      '.defaultBranchRef.name',
    ]);
    if (name) return name;
  } catch {
    /* gh unavailable - fall back */
  }
  return 'main';
}

async function existingPrUrl(cwd: string, branch: string): Promise<string | undefined> {
  try {
    const out = await gh(cwd, [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'open',
      '--json',
      'url',
      '--jq',
      '.[0].url',
    ]);
    return out || undefined;
  } catch {
    return undefined;
  }
}

export async function getPrContext(cwd: string): Promise<PrContext> {
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const defaultBranch = await resolveDefaultBranch(cwd);
  const dirty = (await git(cwd, ['status', '--porcelain'])).trim().length > 0;

  let hasRemote = false;
  try {
    await git(cwd, ['remote', 'get-url', 'origin']);
    hasRemote = true;
  } catch {
    /* no origin remote */
  }

  let ahead: number | null = null;
  for (const base of [`origin/${defaultBranch}`, defaultBranch]) {
    try {
      const out = await git(cwd, ['rev-list', '--count', `${base}..HEAD`]);
      ahead = parseInt(out, 10) || 0;
      break;
    } catch {
      /* base ref missing - try next */
    }
  }

  const existing = branch !== defaultBranch && branch !== 'HEAD'
    ? await existingPrUrl(cwd, branch)
    : undefined;
  return { branch, defaultBranch, ahead, dirty, hasRemote, existingPrUrl: existing };
}

export async function createPr(
  cwd: string,
  input: { title: string; body: string; draft: boolean },
): Promise<CreatePrResult> {
  const ctx = await getPrContext(cwd);
  if (ctx.branch === 'HEAD') {
    throw new GitError("can't open a PR from a detached HEAD - check out a branch first", null);
  }
  if (ctx.branch === ctx.defaultBranch) {
    throw new GitError(`can't open a PR from the default branch (${ctx.defaultBranch})`, null);
  }
  if (ctx.ahead === null) {
    throw new GitError(`couldn't resolve the base branch (${ctx.defaultBranch})`, null);
  }
  if (ctx.ahead === 0) {
    throw new GitError(`branch ${ctx.branch} has no commits ahead of ${ctx.defaultBranch}`, null);
  }
  if (ctx.existingPrUrl) return { url: ctx.existingPrUrl, created: false };

  await git(cwd, ['push', '-u', 'origin', ctx.branch]);

  const dir = await fs.mkdtemp(path.join(tmpdir(), 'mcc-pr-'));
  const bodyFile = path.join(dir, 'body.md');
  try {
    await fs.writeFile(bodyFile, input.body ?? '', 'utf8');
    const args = [
      'pr',
      'create',
      '--head',
      ctx.branch,
      '--base',
      ctx.defaultBranch,
      '--title',
      input.title,
      '--body-file',
      bodyFile,
    ];
    if (input.draft) args.push('--draft');
    const url = (await gh(cwd, args))
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('http')) || '';
    if (!url) throw new GitError('gh pr create returned no URL', null);
    return { url, created: true };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
