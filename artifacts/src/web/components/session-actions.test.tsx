import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import { createGenerator } from '@unocss/core';
import { unoConfig } from '../theme/uno';
import { ApprovalCard } from './chat/ApprovalCard';
import { Button } from './ui4a-ui';

test('hidden session actions reject pointer hits while allowing dialog focus restoration', async () => {
  const source = await readFile(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
  const { css } = await (await createGenerator(unoConfig())).generate(source, { preflights: false });
  expect(css).toContain('.pointer-events-none{pointer-events:none;}');
  expect(css).not.toContain('visibility:hidden');
  expect(css).toContain('.group:focus-within .group-focus-within\\:pointer-events-auto');
  expect(css).toContain('.group:focus-within .group-focus-within\\:opacity-100');
  expect(css).toContain('@media(hover:none)');
  expect(css).toContain('@media(pointer:coarse)');
  expect(css).toMatch(/pointer\\:coarse.*pointer-events-auto\{pointer-events:auto;\}/);
});

test('historical approvals with no decision do not claim permission was granted', () => {
  const html = renderToStaticMarkup(<ApprovalCard approval={{ id: 'historical', tool: 'shell', input: {}, resolved: true }} onDecide={async () => { throw new Error('Historical decisions cannot be resubmitted'); }} />);
  expect(html).toContain('role="status"');
  expect(html).toContain('已处理');
  expect(html).not.toContain('已允许');
  expect(html).not.toContain('<button');
});

test('pending actions remain focusable and expose a styled unavailable state', async () => {
  const html = renderToStaticMarkup(<Button aria-disabled>正在允许…</Button>);
  expect(html).toContain('aria-disabled="true"');
  expect(html).not.toMatch(/\sdisabled(?:=|\s|>)/);
  const { matched } = await (await createGenerator(unoConfig())).generate(html);
  for (const token of ['aria-disabled:cursor-not-allowed', 'aria-disabled:opacity-50', 'aria-disabled:active:scale-100']) expect(matched.has(token)).toBe(true);
});
