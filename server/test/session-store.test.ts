import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `CLAUDE_PROJECTS` is derived from `os.homedir()` at config load time, so we
// point HOME at a throwaway dir *before* importing the module and reuse it for
// every case (a second HOME swap would not take — ESM evaluates config once).
// This exercises the real jsonl parsing path in `readSessionMessages`.
const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcc-sess-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { CLAUDE_PROJECTS } = await import('../src/config.js');
const { readSessionMessages, resolveProjectCwd, searchProjectFiles } = await import('../src/lib/session-store.js');

const PROJECT = 'mcc-test';
const projectDir = path.join(CLAUDE_PROJECTS, PROJECT);
await fs.mkdir(projectDir, { recursive: true });
after(() => fs.rm(tmpHome, { recursive: true, force: true }));

async function writeSession(sid: string, lines: unknown[]): Promise<void> {
  await fs.writeFile(path.join(projectDir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

const userText = 'Hello from the user side — this is a plain string-form content entry.';
const replyText = 'And here is the assistant reply carried as an array text block.';

// One assistant `usage` sample gives the breakdown a non-zero total to split.
const assistantLine = {
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: replyText }], usage: { input_tokens: 1000, output_tokens: 10 } },
  timestamp: '2026-07-07T00:00:01Z',
  uuid: 'a1',
};
const stringUserLine = { type: 'user', message: { role: 'user', content: userText }, timestamp: '2026-07-07T00:00:00Z', uuid: 'u1' };
const arrayUserLine = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: userText }] }, timestamp: '2026-07-07T00:00:00Z', uuid: 'u1' };

test('string-form message content counts toward the messages segment', async () => {
  await writeSession('str', [stringUserLine, assistantLine]);
  const cb = (await readSessionMessages(PROJECT, 'str')).contextBreakdown;
  assert.ok(cb, 'expected a contextBreakdown');
  // Regression guard: the string user turn must land in `messages`, not fold
  // into the residual `system` bucket. Before the fix cb.messages ignored it.
  const expected = Math.ceil((userText.length + replyText.length) / 4);
  assert.equal(cb.messages, expected);
  assert.ok(cb.messages > 0);
  assert.equal(cb.system, cb.total - cb.messages);
});

test('string-form and array text-block content are tallied identically', async () => {
  await writeSession('str', [stringUserLine, assistantLine]);
  await writeSession('arr', [arrayUserLine, assistantLine]);
  const strCb = (await readSessionMessages(PROJECT, 'str')).contextBreakdown;
  const arrCb = (await readSessionMessages(PROJECT, 'arr')).contextBreakdown;
  assert.ok(strCb && arrCb);
  assert.equal(strCb.messages, arrCb.messages);
  assert.equal(strCb.system, arrCb.system);
});

test('tail-truncated sessions keep the flat context bar instead of estimating a stale split', async () => {
  const hugeHead = { type: 'user', message: { role: 'user', content: 'x'.repeat(9 * 1024 * 1024) }, timestamp: '2026-07-07T00:00:00Z', uuid: 'huge' };
  await writeSession('trunc', [hugeHead, assistantLine]);
  const detail = await readSessionMessages(PROJECT, 'trunc');
  assert.equal(detail.truncated, true);
  assert.ok(detail.latestUsage, 'usage should still drive the flat Context bar');
  assert.equal(detail.contextBreakdown, undefined);
});

test('project cwd resolution prefers a live session and otherwise uses the trusted registry fallback', async () => {
  const cwdProject = 'cwd-resolution';
  const cwdProjectDir = path.join(CLAUDE_PROJECTS, cwdProject);
  const staleCwd = path.join(tmpHome, 'removed-worktree');
  const liveCwd = path.join(tmpHome, 'live-worktree');
  const registryCwd = path.join(tmpHome, 'registered-project');
  await fs.mkdir(cwdProjectDir, { recursive: true });
  await fs.mkdir(liveCwd, { recursive: true });
  await fs.writeFile(
    path.join(cwdProjectDir, 'stale.jsonl'),
    `${JSON.stringify({ type: 'user', cwd: staleCwd, message: { role: 'user', content: 'stale' } })}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(cwdProjectDir, 'live.jsonl'),
    `${JSON.stringify({ type: 'user', cwd: liveCwd, message: { role: 'user', content: 'live' } })}\n`,
    'utf8',
  );

  assert.equal(await resolveProjectCwd(cwdProject, registryCwd), liveCwd);
  await fs.rm(liveCwd, { recursive: true, force: true });
  assert.equal(await resolveProjectCwd(cwdProject, registryCwd), registryCwd);
});

test('mention search skips a stale session cwd and uses the live project root', async () => {
  const liveRoot = path.join('/tmp', `mccsearch${process.pid}${Date.now()}`);
  const searchProject = liveRoot.replace(/[^a-zA-Z0-9]/g, '-');
  const searchProjectDir = path.join(CLAUDE_PROJECTS, searchProject);
  const staleCwd = path.join(tmpHome, 'removed-worktree');
  await fs.mkdir(path.join(liveRoot, 'src'), { recursive: true });
  await fs.mkdir(searchProjectDir, { recursive: true });
  await fs.writeFile(path.join(liveRoot, 'src', 'needle.ts'), 'export {};\n', 'utf8');
  await fs.writeFile(
    path.join(searchProjectDir, 'stale.jsonl'),
    `${JSON.stringify({ type: 'user', cwd: staleCwd, message: { role: 'user', content: 'stale' } })}\n`,
    'utf8',
  );

  try {
    const result = await searchProjectFiles(searchProject, 'needle', 50);
    assert.equal(result.cwd, liveRoot);
    assert.deepEqual(result.results, ['src/needle.ts']);
  } finally {
    await fs.rm(liveRoot, { recursive: true, force: true });
  }
});
