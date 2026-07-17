import {
  createContext,
  isValidElement,
  lazy,
  Suspense,
  useContext,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from 'react';
import type { ExtraProps } from 'react-markdown';
import type { ShikiStreamCodeBlockProps } from './ShikiStreamCodeBlock';

type MarkdownCodeProps = ComponentProps<'code'> & ExtraProps;
type MarkdownPreProps = ComponentProps<'pre'> & ExtraProps;
type PositionedNode = { position?: { start?: { offset?: number }; end?: { offset?: number } } };
type ShikiCodeBlockModule = { default: ComponentType<ShikiStreamCodeBlockProps> };

function PlainShikiCodeBlock({ code }: ShikiStreamCodeBlockProps) {
  return <PlainCodeFallback code={code} />;
}

// Keep the heavy Shiki bundle out of the default chunk, and degrade to readable
// plaintext (never a crash) if the lazy chunk can't load.
export function loadShikiStreamCodeBlock(
  importer: () => Promise<ShikiCodeBlockModule> = () => import('./ShikiStreamCodeBlock'),
) {
  return importer().catch(() => ({ default: PlainShikiCodeBlock }));
}

const LazyShikiStreamCodeBlock = lazy(loadShikiStreamCodeBlock);
const MarkdownStreamingContext = createContext<{ content: string; streaming: boolean }>({ content: '', streaming: false });

function extractText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return extractText(node.props.children);
  return '';
}

function getLanguage(className?: string) {
  return className?.match(/language-([^\s]+)/)?.[1];
}

function stripMarkdownContainerPrefix(line: string) {
  return line.replace(/^(?:[\t ]*>[\t ]?)*/, '').trim();
}

// True while a fenced block at the tail of the streamed markdown has no matching
// closing fence yet — that block (and only that one) should stream token-by-token.
export function isMarkdownCodeFenceIncomplete(markdown: string, node?: PositionedNode) {
  const startOffset = node?.position?.start?.offset;
  const endOffset = node?.position?.end?.offset;
  if (typeof startOffset !== 'number' || typeof endOffset !== 'number') return false;
  if (markdown.slice(endOffset).trim()) return false;

  const rawCodeNode = markdown.slice(startOffset, endOffset).trimEnd();
  const lines = rawCodeNode.split(/\r?\n/);
  const openingFence = stripMarkdownContainerPrefix(lines[0] ?? '').match(/^(`{3,}|~{3,})/)?.[1];
  if (!openingFence) return false;

  const closingFence = stripMarkdownContainerPrefix(lines[lines.length - 1] ?? '').match(/^(`+|~+)$/)?.[1];
  return !(closingFence && closingFence[0] === openingFence[0] && closingFence.length >= openingFence.length);
}

function PlainCodeFallback({ code }: { code: string }) {
  return (
    <div data-testid="chat-code-block" data-shiki-loading="true" className="chat-shiki-code">
      <div className="chat-shiki-code__viewport">
        <pre className="chat-code-plain">{code}</pre>
      </div>
    </div>
  );
}

export function MarkdownCode({ node: _node, className, children, ...props }: MarkdownCodeProps) {
  return (
    <code className={[className, 'chat-inline-code'].filter(Boolean).join(' ')} {...props}>
      {children}
    </code>
  );
}

export function MarkdownPre({ node: _node, children }: MarkdownPreProps) {
  const { content, streaming } = useContext(MarkdownStreamingContext);
  const codeElement = isValidElement<{ className?: string; children?: ReactNode; node?: PositionedNode }>(children)
    ? children
    : null;

  if (!codeElement) return <pre className="chat-code-plain">{children}</pre>;

  // Strip only the single trailing newline mdast appends to fenced code — not every
  // trailing blank line, which would silently drop meaningful empty lines the user wrote
  // (rendered and copied content must equal the fenced source).
  const code = extractText(codeElement.props.children).replace(/\n$/, '');
  const language = getLanguage(codeElement.props.className);
  const shouldStream = streaming && isMarkdownCodeFenceIncomplete(content, codeElement.props.node);

  return (
    <Suspense fallback={<PlainCodeFallback code={code} />}>
      <LazyShikiStreamCodeBlock code={code} language={language} streaming={shouldStream} />
    </Suspense>
  );
}

export function MarkdownCodeStreamingProvider({
  streaming,
  content,
  children,
}: {
  streaming: boolean;
  content: string;
  children: ReactNode;
}) {
  return <MarkdownStreamingContext.Provider value={{ content, streaming }}>{children}</MarkdownStreamingContext.Provider>;
}
