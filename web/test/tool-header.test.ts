import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolHeader, bashCommand, isToolExpandable } from '../src/lib/toolHeader';

const PREVIEW = 2;

test('Bash header prefers description over the raw command', () => {
  assert.equal(toolHeader('Bash', { command: 'ls -la', description: 'List files' }), 'List files');
});

test('Bash header falls back to the command when description is missing', () => {
  assert.equal(toolHeader('Bash', { command: 'ls -la' }), 'ls -la');
});

test('Bash header falls back to the command when description is empty', () => {
  assert.equal(toolHeader('Bash', { command: 'ls -la', description: '' }), 'ls -la');
});

test('bashCommand returns the raw script verbatim (multiline preserved)', () => {
  const command = 'set -e\ncd /tmp\nls -la';
  assert.equal(bashCommand('Bash', { command, description: 'List files' }), command);
});

test('bashCommand is empty for non-Bash tools', () => {
  assert.equal(bashCommand('Read', { file_path: '/a/b.ts' }), '');
});

test('bashCommand is empty when the Bash call has no command', () => {
  assert.equal(bashCommand('Bash', { description: 'noop' }), '');
});

test('a Bash script that overflows the preview is expandable even with no output', () => {
  const command = 'set -e\ncd /tmp\nls -la'; // 3 lines > preview
  assert.equal(isToolExpandable(command.split('\n').length, 0, PREVIEW), true);
});

test('a Bash script within the preview adds no expand affordance', () => {
  // 1 output line + 1 command line, both ≤ preview → no pointless toggle.
  assert.equal(isToolExpandable(1, 1, PREVIEW), false);
});

test('input and output each independently drive expandability', () => {
  assert.equal(isToolExpandable(3, 0, PREVIEW), true);  // long script, no output
  assert.equal(isToolExpandable(0, 3, PREVIEW), true);  // long output, no script
  assert.equal(isToolExpandable(2, 2, PREVIEW), false); // both fit exactly
  assert.equal(isToolExpandable(0, 0, PREVIEW), false); // nothing to reveal
});
