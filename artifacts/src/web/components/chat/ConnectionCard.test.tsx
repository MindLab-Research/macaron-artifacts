import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectionCard } from './ConnectionCard';
import { normalizeConnection, redactConnection } from '../../../server/connections';

const snapshot = () => normalizeConnection({
  op_id: 'catalog-op', seq: 0, deadline_at: Date.now() / 1000 + 60, timeout_seconds: 60,
  targets: [
    { name: 'docs', kind: 'mcp', action: 'install', state: 'pending' },
    { name: 'nvidia-app', kind: 'plugin', action: 'install', state: 'pending', display: 'NVIDIA App', description: 'Overlay tools', tier: 'official', platforms: ['windows'], repo: 'https://github.com/NousResearch/hermes-nvidia', sha: 'a'.repeat(40), has_desktop_half: true, scan: { status: 'warnings', summary: 'Review permissions' }, requirements: ['NVIDIA App'] },
    { name: 'obsidian-notes', kind: 'skill', action: 'install', state: 'pending', display: 'Obsidian notes', description: 'Vault access', tier: 'community' },
  ],
})!;

const render = (view = snapshot()) => renderToStaticMarkup(<ConnectionCard connection={{ ...redactConnection(view), id: 'card', actionable: true }} onCommand={async () => {}} />);

test('mixed Hermes connector, plugin and skill rows render install, advanced, skip and provenance', () => {
  const html = render();
  for (const label of ['NVIDIA App', 'Obsidian notes', 'Overlay tools', 'Vault access', 'windows', 'Review permissions', 'NVIDIA App', '查看来源', '高级选项', '安装', '跳过', '继续对话']) expect(html).toContain(label);
  expect(html).toContain('href="https://github.com/NousResearch/hermes-nvidia"');
  expect((html.match(/高级选项/g) ?? [])).toHaveLength(2);
});

test('catalog result states come from the backend snapshot and hide install controls on settled rows', () => {
  const before = snapshot();
  const after = normalizeConnection({ ...before, seq: 1, targets: [
    before.targets[0], { ...before.targets[1], state: 'connected', tools: ['driver_tool'], skill: 'nvidia-app' }, { ...before.targets[2], state: 'skipped' },
  ] }, before)!;
  const html = render(after);
  expect(html).toContain('已安装');
  expect(html).toContain('driver_tool');
  expect(html).toContain('技能：nvidia-app');
  expect(html).toContain('已跳过');
  expect(html).not.toContain('Review permissions');
  expect((html.match(/高级选项/g) ?? [])).toHaveLength(0);
  expect(renderToStaticMarkup(<ConnectionCard connection={{ ...redactConnection(after), id: 'card', actionable: false, settled_by: 'continue' }} onCommand={async () => {}} />)).toContain('已继续对话');
});
