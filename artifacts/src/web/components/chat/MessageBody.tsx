import { lazy, memo, Suspense, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Streamdown } from 'streamdown';
import { cjk } from '@streamdown/cjk';
import { CodeBlock } from '../code/CodeBlock';
import { Collapsible } from '../code/Collapsible';
import { parseSegments } from './segments';

const Ui4aSurface = lazy(() => import('../../ui4a/Ui4aSurface').then(module => ({ default: module.Ui4aSurface })));
const PLUGINS = { cjk };
const ANIMATION = { duration: 300 };
function Pre({ children }: { children?: ReactNode }) {
  const code = children as ReactElement<{ className?: string; children?: ReactNode }> | undefined;
  return <CodeBlock code={String(code?.props.children ?? '').replace(/\n$/, '')} lang={/language-([\w-]+)/.exec(code?.props.className ?? '')?.[1] ?? 'text'} />;
}
const COMPONENTS = { pre: Pre };

export const MessageBody = memo(function MessageBody({ text, messageId, streaming, sessionId, onSend, allowUi = true }: { text: string; messageId: string; streaming: boolean; sessionId: string; onSend: (text: string) => void; allowUi?: boolean }) {
  const segments = useMemo(() => allowUi ? parseSegments(text) : [{ kind: 'markdown' as const, text }], [allowUi, text]);
  return <div className="flex flex-col gap-3">{segments.map((segment, index) => segment.kind === 'markdown' ? <div key={index} className="md text-sm leading-relaxed"><Streamdown plugins={PLUGINS} components={COMPONENTS} controls={false} animated={ANIMATION} isAnimating={streaming}>{segment.text}</Streamdown></div> : <InlineUi4a key={index} source={segment.code} streaming={streaming && !segment.complete} scope={`${sessionId}:inline:${messageId}:${index}`} sessionId={sessionId} onSend={onSend} />)}</div>;
});

function InlineUi4a({ source, ...props }: { source: string; streaming: boolean; scope: string; sessionId: string; onSend: (text: string) => void }) {
  const [showSource, setShowSource] = useState(false);
  const fallback = <div className="overflow-clip rounded-xl bg-surface-2"><Collapsible><CodeBlock code={source} /></Collapsible></div>;
  return <div className="group relative"><button type="button" onClick={() => setShowSource(value => !value)} className="interactive absolute top-2 right-2 z-10 rounded-lg bg-surface/80 px-2 py-1 text-xs text-muted opacity-0 backdrop-blur-md group-hover:opacity-100 hover:text-fg focus-visible:opacity-100">{showSource ? '预览' : '源码'}</button>{showSource ? fallback : <Suspense fallback={fallback}><Ui4aSurface source={source} {...props} /></Suspense>}</div>;
}
