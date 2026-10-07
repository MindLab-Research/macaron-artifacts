import { expect, test } from 'bun:test';
import { ShikiStreamTokenizer } from '@shikijs/stream';
import { highlighter } from '../../theme/themes';
import { codeView, highlightedSnapshot, type HighlightedCode } from './highlighted-code';

const text = (source: string, key: string, snapshot?: HighlightedCode) => { const view = codeView(source, key, snapshot); return view.tokens.map(token => token.content).join('') + view.tail; };

test('late highlighting preserves every newly streamed line before and after the old prefix completes', async () => {
  const key = 'tsx:vitesse-light', prefix = 'const title = "原文";\n', source = prefix + Array.from({ length: 80 }, (_, index) => `const line${index} = ${index};\n`).join('');
  const tokenizer = new ShikiStreamTokenizer({ highlighter: await highlighter('tsx', 'vitesse-light'), lang: 'tsx', theme: 'vitesse-light' });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = gate.then(async () => { const { stable, unstable } = await tokenizer.enqueue(prefix); return { key, source: prefix, tokens: [...stable, ...unstable] }; });
  expect(text(source, key)).toBe(source);
  release(); const highlighted = await pending;
  expect(highlighted.tokens.length).toBeGreaterThan(0);
  expect(text(source, key, highlighted)).toBe(source);
  const { recall, stable, unstable } = await tokenizer.enqueue(source.slice(prefix.length));
  expect(text(source, key, { key, source, tokens: [...highlighted.tokens.slice(0, highlighted.tokens.length - recall), ...stable, ...unstable] })).toBe(source);
});

test('replaced source or a new theme never displays a stale highlighted snapshot', async () => {
  const source = 'const previous = 1;\n', key = 'tsx:vitesse-light', tokenizer = new ShikiStreamTokenizer({ highlighter: await highlighter('tsx', 'vitesse-light'), lang: 'tsx', theme: 'vitesse-light' });
  const { stable, unstable } = await tokenizer.enqueue(source), highlighted = { key, source, tokens: [...stable, ...unstable] };
  expect(text('const next = 2;\n', key, highlighted)).toBe('const next = 2;\n');
  expect(text('const pre', key, highlighted)).toBe('const pre');
  const growth = source + 'const newest = "完整尾部";\n', themed = codeView(growth, 'tsx:github-dark', highlighted);
  expect(themed.tokens).toHaveLength(0); expect(themed.tail).toBe(growth);
  expect(text(growth, key, highlighted)).toBe(growth);
});

test('tokens following a lost chunk cannot claim or hide the complete source', async () => {
  const key = 'tsx:vitesse-light', missing = 'const missing = 1;\n', delta = 'const next = 2;\n', source = missing + delta;
  const tokenizer = new ShikiStreamTokenizer({ highlighter: await highlighter('tsx', 'vitesse-light'), lang: 'tsx', theme: 'vitesse-light' });
  const { stable, unstable } = await tokenizer.enqueue(delta), tokens = [...stable, ...unstable];
  const incomplete = highlightedSnapshot(key, source, tokens);
  expect(incomplete).toBeUndefined(); expect(text(source, key, incomplete)).toBe(source);
  const rebuilt = new ShikiStreamTokenizer({ highlighter: await highlighter('tsx', 'vitesse-light'), lang: 'tsx', theme: 'vitesse-light' });
  const complete = await rebuilt.enqueue(source), recovered = highlightedSnapshot(key, source, [...complete.stable, ...complete.unstable]);
  expect(recovered).toBeDefined(); expect(text(source, key, recovered)).toBe(source);
});
