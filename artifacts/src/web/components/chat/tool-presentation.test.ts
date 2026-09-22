import { expect, test } from 'bun:test';
import type { ChatMessage } from '../../../shared/types';
import { editDiff, isReadTool, readRunAt } from './tool-presentation';
const read = { type: 'dynamic-tool', toolName: 'Read', state: 'output-available', input: { path: 'README.md' } };
test('groups only consecutive successful reads without crossing prose, errors, or mutations', () => {
  const parts = [read, read, { type: 'text', text: 'Analysis' }, read, { ...read, state: 'output-error' }, read] as ChatMessage['parts'];
  expect(readRunAt(parts, 0)).toHaveLength(2); expect(readRunAt(parts, 1)).toBeNull(); expect(readRunAt(parts, 3)).toBeNull();
  for (const toolName of ['shell', 'Bash', 'Edit', 'delete_file', 'custom_read']) expect(isReadTool({ ...read, toolName })).toBe(false);
  expect(isReadTool({ ...read, state: 'input-available' })).toBe(false);
});
test('reports actual changed lines rather than the size of the replacement', () => {
  const result = editDiff({ ...read, toolName: 'Edit', input: { file_path: 'a.ts', old_string: 'same\nold\ntail\n', new_string: 'same\nnew\nextra\ntail\n' } });
  expect(result).toMatchObject({ added: 2, removed: 1 }); expect(result?.code).toContain('-old\n+new\n+extra');
  expect(editDiff({ ...read, toolName: 'write_file', input: { path: 'a.ts', content: 'hello' } })).toBeUndefined();
});
test('supports pi edits and multi-edits, rejects partial or oversized inputs', () => {
  expect(editDiff({ ...read, toolName: 'edit', input: { path: 'a', oldText: '', newText: 'one\ntwo\n' } })).toMatchObject({ added: 2, removed: 0 });
  expect(editDiff({ ...read, toolName: 'MultiEdit', input: { path: 'a', edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'z', new_string: '' }] } })).toMatchObject({ added: 1, removed: 2 });
  expect(editDiff({ ...read, toolName: 'Edit', input: { old_string: 'x'.repeat(100_001), new_string: 'y' } })).toBeUndefined();
  expect(editDiff({ ...read, toolName: 'Edit', state: 'input-streaming' })).toBeUndefined();
});
