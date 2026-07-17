// Monaco editor (via modern-monaco) used by FileTile's Edit mode and the
// full-page file explorer. Kept in its own module so React.lazy can defer the
// glue until the user actually flips to Edit; monaco-editor-core itself is
// loaded on demand by modern-monaco's init().

import { useEffect, useRef } from 'react';
import { init } from 'modern-monaco';
import type * as Monaco from 'modern-monaco/editor-core';
import { useTheme, type ResolvedTheme } from '../lib/theme';

// The vitesse pair follows the app-wide theme; both are preloaded by init()
// so a light<->dark flip swaps instantly without a CDN round-trip.
const MONACO_THEMES: Record<ResolvedTheme, string> = { light: 'vitesse-light', dark: 'vitesse-dark' };

// Mirrored from macaron-genui-demo's modernMonacoConfig.ts EDITOR_OPTIONS so
// both apps' editors feel identical — interval line numbers, sticky scroll,
// phase cursor, no indent guides. Typography is tuned for our compact tiles.
const EDITOR_OPTIONS: Monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  minimap: { enabled: true },
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  roundedSelection: false,
  wordWrap: 'off',
  wrappingIndent: 'none',
  tabSize: 2,
  insertSpaces: true,
  padding: { top: 16, bottom: 16 },
  fontSize: 12,
  lineHeight: 20,
  fontLigatures: true,
  lineNumbers: 'interval',
  cursorBlinking: 'phase',
  renderLineHighlight: 'all',
  renderLineHighlightOnlyWhenFocus: true,
  stickyScroll: { enabled: true, maxLineCount: 20, defaultModel: 'indentationModel' },
  guides: { indentation: false, highlightActiveIndentation: false, bracketPairs: false, bracketPairsHorizontal: false, highlightActiveBracketPair: false },
  // Monaco measures glyphs itself, so this must be a concrete stack (no
  // var(--font-mono)) — keep it in lockstep with styles.css.
  fontFamily: '"Söhne Mono", ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace',
};

// Shiki language id by file extension. Anything not listed opens as plain
// text; grammars are fetched from the CDN on demand per language.
function langFor(name: string): string | undefined {
  const ext = name.toLowerCase().split('.').pop() || '';
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': return 'javascript';
    case 'jsx': return 'jsx';
    case 'ts': return 'typescript';
    case 'tsx': return 'tsx';
    case 'py': return 'python';
    case 'html': case 'htm': return 'html';
    case 'vue': return 'vue';
    case 'svelte': return 'svelte';
    case 'css': return 'css';
    case 'scss': return 'scss';
    case 'less': return 'less';
    case 'json': case 'jsonc': return 'json';
    case 'md': case 'markdown': case 'mdx': return 'markdown';
    case 'yml': case 'yaml': return 'yaml';
    case 'toml': return 'toml';
    case 'sh': case 'bash': case 'zsh': return 'shellscript';
    default: return undefined;
  }
}

let monacoPromise: Promise<typeof Monaco> | null = null;
function loadMonaco(): Promise<typeof Monaco> {
  monacoPromise ??= init({
    themes: [MONACO_THEMES.light, MONACO_THEMES.dark],
    langs: ['typescript', 'tsx', 'javascript', 'jsx', 'html', 'css', 'json', 'markdown', 'python'],
  });
  return monacoPromise;
}

export default function CodeEditor({
  path,
  value,
  onChange,
}: {
  path: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { resolved } = useTheme();
  const liveRef = useRef({ value, onChange, resolved });
  liveRef.current = { value, onChange, resolved };
  const readyRef = useRef<{ monaco: typeof Monaco; model: Monaco.editor.ITextModel } | null>(null);

  useEffect(() => {
    let disposed = false;
    let editor: Monaco.editor.IStandaloneCodeEditor | undefined;
    let model: Monaco.editor.ITextModel | undefined;
    void loadMonaco().then((monaco) => {
      if (disposed || !containerRef.current) return;
      model = monaco.editor.createModel(liveRef.current.value, langFor(path));
      editor = monaco.editor.create(containerRef.current, { ...EDITOR_OPTIONS, theme: MONACO_THEMES[liveRef.current.resolved], model });
      model.onDidChangeContent(() => liveRef.current.onChange(model!.getValue()));
      readyRef.current = { monaco, model };
    });
    return () => {
      disposed = true;
      readyRef.current = null;
      editor?.dispose();
      model?.dispose();
    };
  }, [path]);

  // Typing round-trips straight back through onChange, so getValue() already
  // matches and this no-ops — only genuinely external content (a refresh
  // re-fetch) lands here, where resetting cursor/undo state is expected.
  useEffect(() => {
    const ready = readyRef.current;
    if (ready && ready.model.getValue() !== value) ready.model.setValue(value);
  }, [value]);

  // setTheme is global to all monaco editors — every mounted tile follows the
  // app theme together, same as the rest of the UI.
  useEffect(() => {
    readyRef.current?.monaco.editor.setTheme(MONACO_THEMES[resolved]);
  }, [resolved]);

  return <div ref={containerRef} className="code-editor" />;
}
