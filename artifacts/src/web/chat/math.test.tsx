import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Streamdown } from 'streamdown';
import { normalizeMath } from './math';
import { markdownPlugins } from './markdown';
import { exportRehypePlugins } from './export-links';
import { LaTeX, MathBlock } from '../ui4a/katex';

const render = (text: string) => renderToStaticMarkup(<Streamdown plugins={markdownPlugins} rehypePlugins={exportRehypePlugins}>{normalizeMath(text)}</Streamdown>);

test('bracket and parenthesis formulas survive Markdown escapes and render accessible math', () => {
  const html = render(String.raw`Inline \(x^2\), display \[\frac{1}{2}\].`);
  expect(html.match(/class="katex"/g)).toHaveLength(2);
  expect(html).toContain('katex-display');
  expect(html).toContain('<math');
  expect(html).toContain('annotation encoding="application/x-tex"');
});

test('ordinary brackets, prices, escaped delimiters, code and link destinations stay literal', () => {
  for (const text of [
    '[1, 2] and $5 or $10', String.raw`\\[literal\\]`, String.raw`\text`,
    '`\\[x^2\\]`', '`\\[x^2', '``\\(x\\)``', '```tex\n\\[x^2\\]\n```', '~~~tex\n\\(x\\)\n~~~', '    \\[x^2\\]',
    '[source](https://example.com/\\[x\\])', '<code>\\[x\\]</code>',
  ]) expect(normalizeMath(text)).toBe(text);
  expect(render('It costs $5 or $10.')).not.toContain('class="katex"');
});

test('display math supports line breaks, environments, and existing dollar delimiters', () => {
  const html = render(String.raw`\[
\begin{aligned}
y &= x^2 \\
z &= \frac{x}{2}
\end{aligned}
\]

$$
E = mc^2
$$`);
  expect(html.match(/class="katex"/g)).toHaveLength(2);
  expect(html).not.toContain('katex-error');
});

test('normalization preserves existing dollar math and escaped backticks', () => {
  const dollars = String.raw`$$\verb|\[|$$`;
  expect(normalizeMath(dollars)).toBe(dollars);
  expect(render(dollars)).not.toContain('katex-error');
  expect(render(String.raw`A literal \` followed by \(x^2\).`)).toContain('class="katex"');
});

test('display equations remain inside blockquotes and list items', () => {
  for (const [text, container] of [[String.raw`> \[x^2\]`, 'blockquote'], [String.raw`- \[x^2\]`, 'li'], [String.raw`1. Before \[x^2\] after.`, 'li']]) {
    const html = render(text!);
    expect(html.indexOf('class="katex"')).toBeGreaterThan(html.indexOf(`<${container}`));
    expect(html.indexOf('class="katex"')).toBeLessThan(html.indexOf(`</${container}>`));
    expect(html).not.toContain('katex-error');
  }
});

test('incomplete TeX prefixes do not throw and the completed equation recovers', () => {
  const text = String.raw`\[\frac{x^2}{2}\]`;
  for (let end = 0; end <= text.length; end++) expect(() => render(text.slice(0, end))).not.toThrow();
  expect(render(text)).toContain('class="katex"');
  expect(render(text)).not.toContain('katex-error');
});

test('built-in formula components accept partial props and reject trusted HTML commands', () => {
  expect(() => renderToStaticMarkup(<LaTeX />)).not.toThrow();
  expect(renderToStaticMarkup(<MathBlock value={String.raw`\frac{x}{2}`} />)).toContain('katex-display');
  expect(renderToStaticMarkup(<LaTeX value={String.raw`\frac{`} />)).toContain('katex-error');
  expect(renderToStaticMarkup(<LaTeX value={String.raw`\href{javascript:alert(1)}{click}`} />)).not.toContain('href=');
});
