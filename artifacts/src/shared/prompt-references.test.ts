import { expect, test } from 'bun:test';
import { referenceQuery, selectReference } from './prompt-references';
test('only the active mention query is replaced, preserving the rest of the draft', () => {
  expect(referenceQuery('email@example.com')).toBeNull();
  expect(referenceQuery('check @主题.ts later', 12)).toEqual({ query: '主题.ts', start: 6, end: 12 });
  expect(selectReference('check @theme later', 12)).toEqual({ text: 'check  later', caret: 6 });
  expect(selectReference('no mention', 3)).toEqual({ text: 'no mention', caret: 3 });
});
