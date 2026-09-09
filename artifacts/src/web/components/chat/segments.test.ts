import { describe, expect, test } from 'bun:test';
import { parseSegments } from './segments';

describe('inline UI4A streaming', () => {
  test('preserves surrounding prose and emits every growing prefix before the fence closes', () => {
    const code = 'export default function Demo() { return <button>你好</button>; }';
    const open = '前文。\n````ui4a/tsx\n';
    for (let length = 1; length <= code.length; length++) {
      const parts = parseSegments(open + code.slice(0, length));
      expect(parts).toEqual([{ kind: 'markdown', text: '前文。\n' }, { kind: 'ui4a', code: code.slice(0, length), complete: false }]);
    }
    const parts = parseSegments(`${open}${code}\n\x60\x60\x60\x60\n后文。`);
    expect(parts[1]).toEqual({ kind: 'ui4a', code: `${code}\n`, complete: true });
    expect(parts[2]).toEqual({ kind: 'markdown', text: '后文。' });
  });
  test('accepts inline code after the language and shorter standalone closing fences', () => {
    expect(parseSegments('正文。````ui4a/tsx export default () => <p>done</p>;\n```\n下一步')).toEqual([
      { kind: 'markdown', text: '正文。' }, { kind: 'ui4a', code: 'export default () => <p>done</p>;\n', complete: true }, { kind: 'markdown', text: '下一步' },
    ]);
  });
  test('does not turn a prose mention into a blank generated surface', () => {
    const text = '使用 ````ui4a/tsx```` 块。\n正文继续。';
    expect(parseSegments(text)).toEqual([{ kind: 'markdown', text }]);
  });
  test('recognizes the inner real fence and strips leaked tool markup', () => {
    const text = '`````ui4a/tsx\n````ui4a/tsx\nexport default () => <p>ok</p>;\n</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>';
    expect(parseSegments(text)).toEqual([{ kind: 'ui4a', code: 'export default () => <p>ok</p>;', complete: false }]);
  });
});
