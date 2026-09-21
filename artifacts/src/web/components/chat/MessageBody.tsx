import { lazy, memo, Suspense, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Streamdown } from 'streamdown';
import { markdownPlugins } from '../../chat/markdown';
import { normalizeMath } from '../../chat/math';
import { CodeBlock } from '../code/CodeBlock';
import { Collapsible } from '../code/Collapsible';
import { parseSegments } from './segments';
import { ExportMenu } from '../ExportMenu';
import { exportRehypePlugins } from '../../chat/export-links';

const Ui4aSurface = lazy(() => import('../../ui4a/Ui4aSurface').then(module => ({ default: module.Ui4aSurface })));
const ANIMATION = { duration: 300 };
function Pre({ children }: { children?: ReactNode }) {
  const code = children as ReactElement<{ className?: string; children?: ReactNode }> | undefined;
  return <CodeBlock code={String(code?.props.children ?? '').replace(/\n$/, '')} lang={/language-([\w-]+)/.exec(code?.props.className ?? '')?.[1] ?? 'text'} />;
}
const COMPONENTS = { pre: Pre };

export const MessageBody = memo(function MessageBody({ text, messageId, streaming, sessionId, onSend, allowUi = true }: { text: string; messageId: string; streaming: boolean; sessionId: string; onSend: (text: string) => void; allowUi?: boolean }) {
  const segments = useMemo(() => allowUi ? parseSegments(text) : [{ kind: 'markdown' as const, text }], [allowUi, text]);
  return <div className="flex min-w-0 flex-col gap-3">{segments.map((segment, index) => segment.kind === 'markdown' ? <div key={index} className="md min-w-0 text-sm leading-relaxed"><Streamdown plugins={markdownPlugins} rehypePlugins={exportRehypePlugins} components={COMPONENTS} controls={false} animated={ANIMATION} isAnimating={streaming}>{normalizeMath(segment.text)}</Streamdown></div> : <InlineUi4a key={index} source={segment.code} streaming={streaming && !segment.complete} scope={`${sessionId}:inline:${messageId}:${index}`} sessionId={sessionId} onSend={onSend} />)}</div>;
});

function InlineUi4a({ source, ...props }: { source: string; streaming: boolean; scope: string; sessionId: string; onSend: (text: string) => void }) {
  const [showSource, setShowSource] = useState(false);
  const target = useRef<HTMLDivElement>(null);
  const fallback = <div className="theme-code overflow-clip rounded-xl"><Collapsible><CodeBlock code={source} /></Collapsible></div>;
  return <div><div data-export-control className="flex min-h-10 items-center justify-end gap-1"><button type="button" onClick={() => setShowSource(value => !value)} aria-pressed={showSource} className="artifact-source-toggle interactive h-9 rounded-md px-2 text-xs text-muted hover:bg-surface-3 hover:text-hover-fg">{showSource ? '预览' : '源码'}</button><ExportMenu target={target} disabled={props.streaming || showSource} /></div><div ref={target}>{showSource ? fallback : <Suspense fallback={fallback}><Ui4aSurface source={source} {...props} /></Suspense>}</div></div>;
}
