import type { ThemedToken } from 'shiki/core';

export type HighlightedCode = { key: string; source: string; tokens: ThemedToken[] };
const EMPTY: ThemedToken[] = [];

/** A failed tokenizer chunk must never label an incomplete token list as the complete source. */
export function highlightedSnapshot(key: string, source: string, tokens: ThemedToken[]): HighlightedCode | undefined {
  return tokens.map(token => token.content).join('') === source ? { key, source, tokens } : undefined;
}

/** Highlighting may lag streaming. Its completed prefix must never hide newer raw text. */
export function codeView(source: string, key: string, highlighted?: HighlightedCode) {
  if (!highlighted || highlighted.key !== key || !source.startsWith(highlighted.source)) return { tokens: EMPTY, tail: source };
  return { tokens: highlighted.tokens, tail: source.slice(highlighted.source.length) };
}
