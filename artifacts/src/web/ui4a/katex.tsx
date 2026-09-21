import { renderToString } from 'katex';
import { useMemo, type CSSProperties } from 'react';

export type LaTeXProps = { value?: string; block?: boolean; className?: string; style?: CSSProperties };

export function LaTeX({ value = '', block = false, className = '', style }: LaTeXProps) {
  // Stable payload identity keeps sibling streaming updates from rebuilding the formula DOM.
  const html = useMemo(() => ({ __html: renderToString(value, { displayMode: block, throwOnError: false, trust: false, strict: 'ignore', maxSize: 8, maxExpand: 500, errorColor: 'var(--muted)' }) }), [value, block]);
  return <span className={`${block ? 'ui4a-math-block' : 'ui4a-math'} ${className}`} style={style} dangerouslySetInnerHTML={html} />;
}

export function MathBlock(props: Omit<LaTeXProps, 'block'>) { return <LaTeX {...props} block />; }
