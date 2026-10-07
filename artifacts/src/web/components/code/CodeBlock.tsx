import { Fragment, memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ShikiStreamTokenizer } from '@shikijs/stream';
import type { ThemedToken } from 'shiki/core';
import { highlighter, normalizeLanguage } from '../../theme/themes';
import { useTheme } from '../../theme/ThemeProvider';
import { codeView, highlightedSnapshot, type HighlightedCode } from './highlighted-code';

type StreamState = { key: string; consumed: string; tokenizer?: ShikiStreamTokenizer; queue: Promise<void>; tokens: ThemedToken[] };
const CodeLine = memo(function CodeLine({ tokens }: { tokens: ThemedToken[]; signature: string }) {
  return <>{tokens.map((token, index) => <span key={index} style={{ color: token.color, fontStyle: token.fontStyle && (token.fontStyle & 1) ? 'italic' : undefined, fontWeight: token.fontStyle && (token.fontStyle & 2) ? 'bold' : undefined } as CSSProperties}>{token.content}</span>)}</>;
}, (before, after) => before.signature === after.signature);

export function CodeBlock({ code, lang = 'tsx', className = '' }: { code: string; lang?: string; className?: string }) {
  const { appearance } = useTheme();
  const mount = useRef<HTMLPreElement>(null);
  const current = useRef<StreamState | null>(null);
  const [active, setActive] = useState(false);
  const [highlighted, setHighlighted] = useState<HighlightedCode>();
  const language = normalizeLanguage(lang), key = `${language}:${appearance.syntax}`;
  const { tokens, tail } = codeView(code, key, highlighted);
  useEffect(() => {
    const node = mount.current;
    if (!node) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setActive(true); observer.disconnect(); } }, { rootMargin: '300px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!active) return;
    if (!current.current || current.current.key !== key || !code.startsWith(current.current.consumed)) {
      current.current = { key, consumed: '', queue: Promise.resolve(), tokens: [] };
      setHighlighted(undefined);
    }
    const state = current.current;
    const delta = code.slice(state.consumed.length);
    if (!delta) return;
    state.consumed = code;
    // The tokenizer owns lexical state: serialize deltas and discard work belonging to a replaced file or theme.
    state.queue = state.queue.then(async () => {
      if (current.current !== state) return;
      state.tokenizer ??= new ShikiStreamTokenizer({ highlighter: await highlighter(language, appearance.syntax), lang: language, theme: appearance.syntax });
      const { recall, stable, unstable } = await state.tokenizer.enqueue(delta);
      state.tokens = [...state.tokens.slice(0, state.tokens.length - recall), ...stable, ...unstable];
      if (current.current === state) setHighlighted(highlightedSnapshot(key, code, state.tokens));
    }).catch(error => {
      // consumed includes the failed chunk. Rebuild from the full source on the next update.
      if (current.current === state) { current.current = null; setHighlighted(undefined); }
      console.warn('[artifacts] syntax highlighting failed', error);
    });
  }, [active, appearance.syntax, code, key, language]);
  useEffect(() => () => { current.current = null; }, []);
  const lines = useMemo(() => {
    const result: ThemedToken[][] = [[]];
    for (const token of tokens) for (const [index, content] of token.content.split('\n').entries()) { if (index) result.push([]); if (content) result.at(-1)!.push({ ...token, content }); }
    return result;
  }, [tokens]);
  return <pre ref={mount} data-code-language={language} data-code-theme={appearance.syntax} tabIndex={0} aria-label="代码" className={`theme-code scroll-x m-0 p-3 text-xs leading-5 ${className}`}><code>{lines.map((line, index) => <Fragment key={index}><CodeLine tokens={line} signature={line.map(token => `${token.content}:${token.color}:${token.fontStyle}`).join('|')} />{index < lines.length - 1 ? '\n' : ''}</Fragment>)}{tail}</code></pre>;
}
