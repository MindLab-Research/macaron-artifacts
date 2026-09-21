import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Streamdown } from 'streamdown';
import { Reasoning } from '../components/chat/Reasoning';
import { exportRehypePlugins } from './export-links';

test('export metadata preserves link destinations while keeping the live safety button', () => {
  const html = renderToStaticMarkup(<Streamdown rehypePlugins={exportRehypePlugins}>{'[Reference](https://example.com/?a=1&b=2)'}</Streamdown>);
  expect(html).toContain('data-export-link="https://example.com/?a=1&amp;b=2"');
  expect(html).toContain('<button');
  expect(html).toContain('Reference</button>');
});

test('export metadata cannot bypass Markdown URL sanitization', () => {
  const html = renderToStaticMarkup(<Streamdown rehypePlugins={exportRehypePlugins}>{'[Unsafe](javascript:alert%281%29)'}</Streamdown>);
  expect(html).not.toContain('data-export-link="javascript:');
  expect(html).not.toContain('href="javascript:');
});

test('unopened summary history remains in the transcript without becoming visible', () => {
  const html = renderToStaticMarkup(<Reasoning live={false} parts={[
    { type: 'reasoning', text: '**First**\n\nEarlier context', state: 'done', providerMetadata: { macaron: { reasoningKind: 'summary' } } },
    { type: 'reasoning', text: '**Latest**\n\nCurrent context', state: 'done', providerMetadata: { macaron: { reasoningKind: 'summary' } } },
  ]} />);
  expect(html).toContain('Earlier context'); expect(html).toContain('Current context');
  expect(html).toMatch(/hidden=""[^>]*data-reasoning-latest="false"/);
  expect(html).toContain('data-export-reasoning-toggle="true"');
});
