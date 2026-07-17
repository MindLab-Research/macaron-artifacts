import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcc-title-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { CLAUDE_PROJECTS } = await import('../config.js');
const { getLabels, setLabel } = await import('./label-store.js');
const { resolveNativeTitle, readSessionMessages, readSessionSummary, renameSession } = await import('./session-store.js');

const project = 'mac-title-test';
const projDir = path.join(CLAUDE_PROJECTS, project);
await fs.mkdir(projDir, { recursive: true });
after(() => fs.rm(tmpHome, { recursive: true, force: true }));

// resolveNativeTitle mirrors the official Agent SDK's list priority:
// customTitle > aiTitle > lastPrompt > summary.
test('resolveNativeTitle honors customTitle > aiTitle > lastPrompt > summary', () => {
  assert.equal(resolveNativeTitle({ customTitle: 'c', aiTitle: 'a', lastPrompt: 'l', summary: 's' }), 'c');
  assert.equal(resolveNativeTitle({ aiTitle: 'a', lastPrompt: 'l', summary: 's' }), 'a');
  assert.equal(resolveNativeTitle({ lastPrompt: 'l', summary: 's' }), 'l');
  assert.equal(resolveNativeTitle({ summary: 's' }), 's');
  assert.equal(resolveNativeTitle({}), '');
});

// End-to-end over a real jsonl: readSessionSummary must surface the native
// title and renameSession's custom-title append must win over an ai-title.
test('readSessionSummary + renameSession round-trip native titles', async () => {
  const sid = 'sess';
  const file = path.join(projDir, `${sid}.jsonl`);
  const lines = [
    { type: 'user', cwd: '/repo', gitBranch: 'main', message: { content: 'first prompt' } },
    { type: 'assistant', message: { content: 'hi' } },
    { type: 'ai-title', aiTitle: 'Old AI Title' },
    { type: 'ai-title', aiTitle: 'Fresh AI Title' },
  ];
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

  const s = await readSessionSummary(file);
  assert.ok(s);
  assert.equal(s.title, 'Fresh AI Title');
  assert.equal(s.firstUserText, 'first prompt');

  // A custom-title (native /rename) wins over any ai-title and reaches detail.
  await renameSession(project, sid, 'My Custom Name');
  assert.equal((await readSessionSummary(file))?.title, 'My Custom Name');
  assert.equal((await readSessionMessages(project, sid)).title, 'My Custom Name');

  // Macaron treats a blank custom-title record as a clear tombstone.
  await renameSession(project, sid, '   ');
  assert.equal((await readSessionSummary(file))?.title, 'Fresh AI Title');
});

test('rename removes a legacy sidecar label so the native title can win', async () => {
  const sid = 'legacy';
  const file = path.join(projDir, `${sid}.jsonl`);
  await fs.writeFile(file, `${JSON.stringify({ type: 'user', cwd: '/repo', message: { content: 'prompt' } })}\n`, 'utf8');
  await setLabel(sid, 'Legacy Label');

  assert.equal((await readSessionMessages(project, sid)).label, 'Legacy Label');
  await renameSession(project, sid, 'Native Name');
  assert.equal((await getLabels())[sid], undefined);
  const detail = await readSessionMessages(project, sid);
  assert.equal(detail.label, undefined);
  assert.equal(detail.title, 'Native Name');
});

test('tail scan finds titles beyond the head read limit', async () => {
  const sid = 'tail';
  const file = path.join(projDir, `${sid}.jsonl`);
  const lines = [
    { type: 'user', cwd: '/repo', message: { content: 'x'.repeat(100 * 1024) } },
    { type: 'ai-title', aiTitle: 'Tail Title' },
  ];
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  assert.equal((await readSessionSummary(file))?.title, 'Tail Title');
});

test('rename rejects paths outside the Claude projects directory', async () => {
  await assert.rejects(renameSession('..', 'escape', 'Nope'), /invalid session path/);
});
