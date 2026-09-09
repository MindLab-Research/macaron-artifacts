import { describe, expect, test } from 'bun:test';
import { toolOutput } from './tool-output';

describe('tool output selection', () => {
  test('a final pi result replaces the stale streamed prefix after native truncation', () => {
    const output = { content: [{ type: 'text', text: 'last lines\n[Output truncated]' }], details: { truncated: true } };
    expect(toolOutput({ state: 'output-available', output }, 'first lines\n')).toBe('last lines\n[Output truncated]');
    expect(toolOutput({ state: 'input-available', output }, 'first lines\n')).toBe('first lines\n');
  });
  test('structured text blocks retain boundaries and an empty final result clears old output', () => {
    expect(toolOutput({ state: 'output-available', output: { content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] } })).toBe('one\ntwo');
    expect(toolOutput({ state: 'output-available', output: { content: [] } }, 'stale')).toBe('');
  });
  test('Codex string results and Claude content arrays retain their existing formatting', () => {
    expect(toolOutput({ state: 'output-available', output: 'final string' }, 'streamed output')).toBe('streamed output');
    expect(toolOutput({ state: 'output-available', output: 'final string' })).toBe('final string');
    const output = [{ type: 'text', text: 'Claude result' }];
    expect(toolOutput({ state: 'output-available', output })).toBe(JSON.stringify(output, null, 2));
  });
  test('mixed content and other objects keep the complete JSON fallback', () => {
    for (const output of [{ content: [{ type: 'text', text: 'caption' }, { type: 'image', data: 'image-data' }] }, { content: [null] }, { exitCode: 0, result: 'done' }]) {
      expect(toolOutput({ state: 'output-available', output })).toBe(JSON.stringify(output, null, 2));
    }
  });
});
