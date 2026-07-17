import { renderToString, type KatexOptions } from "katex";
import { useMemo, type CSSProperties } from "react";
import { cn } from "@/lib/style";

export type LaTeXProps = { value: string; block?: boolean; className?: string; style?: CSSProperties; errorColor?: string };
type MathBlockProps = Omit<LaTeXProps, "block">;

const renderMath = (value: string, block: boolean, errorColor?: string) => {
  const options: KatexOptions = { displayMode: block, throwOnError: false, trust: false, strict: "warn", maxSize: 8, maxExpand: 500 };
  if (errorColor) options.errorColor = errorColor;
  return renderToString(value, options);
};

/**
 * Render one TeX expression with KaTeX. Put the formula in the value string prop, not JSX children, so braces like S_{t-1} stay valid TSX.
 * @param value TeX source without surrounding $ or $$ delimiters, e.g. "\\int_0^1 x^2 dx".
 * @param block Use display math layout for standalone equations.
 */
export function LaTeX({ value, block = false, className, style, errorColor }: LaTeXProps) {
  const html = useMemo(() => renderMath(value, block, errorColor), [value, block, errorColor]);
  return <span className={cn(block && "block overflow-x-auto py-1", className)} style={style} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Render a standalone TeX equation with display math layout.
 * @param value TeX source without surrounding $$ delimiters.
 */
export function MathBlock({ value, className, style, errorColor }: MathBlockProps) {
  return <LaTeX value={value} block className={className} style={style} errorColor={errorColor} />;
}
