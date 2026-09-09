import { expect, test } from 'bun:test';
import { artifactEntryPath } from './artifact-path';

test('tool paths resolve to the artifact stream identity within their own workspace', () => {
  const path = '.artifacts/canvases/demo.ui4a.tsx';
  for (const input of [path, `./${path}`, `/workspace/${path}`, `/workspace/.artifacts/canvases/../canvases/demo.ui4a.tsx`]) expect(artifactEntryPath(input, '/workspace')).toBe(path);
  expect(artifactEntryPath('C:\\workspace\\.artifacts\\canvases\\demo.ui4a.tsx', 'C:\\workspace')).toBe(path);
  expect(artifactEntryPath('/.artifacts/demo.tsx', '/')).toBe('.artifacts/demo.tsx');
  for (const input of ['/workspace-other/' + path, '/other/' + path, '../' + path, '.artifacts/../outside.tsx', '.artifacts/canvases/demo/Counter.tsx', '.artifacts/state.json']) expect(artifactEntryPath(input, '/workspace')).toBeUndefined();
});
