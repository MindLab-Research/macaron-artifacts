import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMarkdownCodeFenceIncomplete } from '../src/components/MarkdownCode';
import { resolveChatCodeLanguage } from '../src/lib/chatCodeHighlighter';
import { nextScrollStickiness } from '../src/lib/chatCodeScroll';

// Build a positioned node whose offsets frame `fence` inside the full markdown,
// mirroring what react-markdown/mdast hands the <pre> renderer.
function nodeFor(markdown: string, fence: string) {
  const start = markdown.indexOf(fence);
  return { position: { start: { offset: start }, end: { offset: start + fence.length } } };
}

test('an unclosed trailing fence is incomplete (should stream)', () => {
  const md = '```tsx\nconst value =';
  assert.equal(isMarkdownCodeFenceIncomplete(md, nodeFor(md, md)), true);
});

test('a closed fence is complete (should not stream)', () => {
  const md = '```tsx\nconst value = 42;\n```';
  assert.equal(isMarkdownCodeFenceIncomplete(md, nodeFor(md, md)), false);
});

test('a closed fence with trailing prose is complete', () => {
  const fence = '```tsx\nconst value = 42;\n```';
  const md = `${fence}\n\nmore text`;
  assert.equal(isMarkdownCodeFenceIncomplete(md, nodeFor(md, fence)), false);
});

test('a non-trailing (earlier) fence never streams even if it looks open', () => {
  const fence = '```js\nconst stable = 1;';
  const md = `${fence}\n\nsibling paragraph`;
  assert.equal(isMarkdownCodeFenceIncomplete(md, nodeFor(md, fence)), false);
});

test('blockquote-prefixed fences are recognized', () => {
  const md = '> ```ts\n> const active =';
  assert.equal(isMarkdownCodeFenceIncomplete(md, nodeFor(md, md)), true);
});

test('missing node position is treated as complete', () => {
  assert.equal(isMarkdownCodeFenceIncomplete('```ts\nx', undefined), false);
});

test('language aliases resolve to canonical ids, unknown falls back to text', () => {
  assert.equal(resolveChatCodeLanguage('js'), 'javascript');
  assert.equal(resolveChatCodeLanguage('TSX'), 'tsx');
  assert.equal(resolveChatCodeLanguage('not-a-language'), 'text');
  assert.equal(resolveChatCodeLanguage(undefined), 'text');
});

test('loose fence hints map onto the shipped allowlist', () => {
  // Aliases models commonly emit should reach a grammar we actually bundle.
  assert.equal(resolveChatCodeLanguage('shell'), 'bash');
  assert.equal(resolveChatCodeLanguage('c++'), 'cpp');
  assert.equal(resolveChatCodeLanguage('py'), 'python');
  assert.equal(resolveChatCodeLanguage('golang'), 'go');
});

test('languages outside the curated allowlist fall back to text', () => {
  // These are real Shiki grammars but intentionally not shipped — must degrade, not throw.
  assert.equal(resolveChatCodeLanguage('cobol'), 'text');
  assert.equal(resolveChatCodeLanguage('fortran'), 'text');
});

// A viewport 300 tall showing the bottom of 1000 of content; `visible` frames it so the
// bottom-threshold (72) check reads as "at bottom" only when scrollTop is near the end.
const CLIENT = 300;
const CONTENT = 1000;
function at(scrollTop: number, lastScrollTop: number) {
  return { scrollTop, lastScrollTop, scrollHeight: CONTENT, clientHeight: CLIENT };
}

test('reading upward during a fast stream immediately takes scroll ownership', () => {
  // Auto-follow only scrolls down, so any upward delta is the user — hand over at once,
  // no timed suppression window that a rapid next-token scroll could hide behind.
  assert.equal(nextScrollStickiness(true, at(400, 700)), false);
});

test('auto-follow own downward scroll keeps stickiness', () => {
  // Downward movement that lands at the bottom stays stuck (follow continues)...
  assert.equal(nextScrollStickiness(true, at(700, 400)), true);
  // ...and a tiny sub-pixel jitter downward must not be misread as an upward user scroll.
  assert.equal(nextScrollStickiness(true, at(699.6, 700)), true);
});

test('scrolling back to the bottom re-arms auto-follow', () => {
  // User had ownership (previous=false); once they return to within threshold of the
  // bottom, following resumes without waiting on any timer.
  assert.equal(nextScrollStickiness(false, at(700, 300)), true);
});

test('staying scrolled up preserves user ownership as new tokens arrive', () => {
  // previous=false, no further movement (scrollTop === lastScrollTop) and still far from
  // the bottom → ownership stays with the user across token mutations.
  assert.equal(nextScrollStickiness(false, at(200, 200)), false);
});
