import { Check, Copy, X } from 'lucide-react';
import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { getTokenStyleObject } from 'shiki/core';
import type { RecallToken } from '@shikijs/stream';
import type { ThemedToken } from 'shiki';
import {
  createChatCodeDeltaStream,
  renderChatCodeToHtml,
  resolveChatCodeLanguage,
  type ChatCodeTokenStream,
} from '../lib/chatCodeHighlighter';
import { nextScrollStickiness } from '../lib/chatCodeScroll';

type CodeTokenSegment = { key: string; content: string; style?: CSSProperties; animate: boolean };
type CodeTokenItem = { key: string; segments: CodeTokenSegment[] };

export interface ShikiStreamCodeBlockProps {
  code: string;
  language?: string;
  streaming: boolean;
}

function PlainCode({ code }: { code: string }) {
  return <pre className="chat-code-plain">{code}</pre>;
}

// Copy that also works on the LAN-over-HTTP surfaces (phones opening a dev box by IP),
// where the page isn't a secure context and navigator.clipboard is absent. Falls back to
// a hidden textarea + execCommand; throws if neither path succeeds so the button can flag it.
async function copyChatCode(text: string) {
  if (navigator.clipboard?.writeText && window.isSecureContext) return navigator.clipboard.writeText(text);
  if (typeof document === 'undefined') throw new Error('Clipboard unavailable');
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  const copied = (document as unknown as { execCommand(id: string): boolean }).execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Clipboard copy failed');
}

function StaticHighlightedCode({ code, language }: { code: string; language: ReturnType<typeof resolveChatCodeLanguage> }) {
  const [html, setHtml] = useState('');

  useEffect(() => {
    let cancelled = false;
    setHtml('');
    if (!code) return () => undefined;
    void renderChatCodeToHtml(code, language).then(
      (next) => { if (!cancelled) setHtml(next); },
      () => { if (!cancelled) setHtml(''); },
    );
    return () => { cancelled = true; };
  }, [code, language]);

  if (!html) return <PlainCode code={code} />;
  return <div className="chat-shiki-code__highlight" dangerouslySetInnerHTML={{ __html: html }} />;
}

function StreamingHighlightedCode({ code, language }: { code: string; language: ReturnType<typeof resolveChatCodeLanguage> }) {
  const [tokenStream, setTokenStream] = useState<ChatCodeTokenStream | null>(null);
  const [tokenItems, setTokenItems] = useState<CodeTokenItem[]>([]);
  const [failed, setFailed] = useState(false);
  const codeStreamRef = useRef<ReturnType<typeof createChatCodeDeltaStream> | null>(null);
  const previousCodeRef = useRef('');
  const segmentSequenceRef = useRef(0);
  const tokenSequenceRef = useRef(0);
  const animatedCharWatermarkRef = useRef(0);

  useEffect(() => {
    const codeStream = createChatCodeDeltaStream(language);
    codeStreamRef.current = codeStream;
    previousCodeRef.current = '';
    segmentSequenceRef.current = 0;
    tokenSequenceRef.current = 0;
    animatedCharWatermarkRef.current = 0;
    setTokenItems([]);
    setFailed(false);
    setTokenStream(codeStream.stream);
    return () => {
      codeStreamRef.current?.close();
      codeStreamRef.current = null;
    };
  }, [language]);

  useEffect(() => {
    let codeStream = codeStreamRef.current;
    if (!codeStream) return;

    const previousCode = previousCodeRef.current;
    if (code.startsWith(previousCode)) {
      codeStream.push(code.slice(previousCode.length));
      previousCodeRef.current = code;
      return;
    }

    // Non-append edit (resend / rewind): tear the stream down and replay from scratch.
    codeStream.close();
    codeStream = createChatCodeDeltaStream(language);
    codeStreamRef.current = codeStream;
    previousCodeRef.current = code;
    segmentSequenceRef.current = 0;
    tokenSequenceRef.current = 0;
    animatedCharWatermarkRef.current = 0;
    setTokenItems([]);
    setFailed(false);
    setTokenStream(codeStream.stream);
    codeStream.push(code);
  }, [code, language]);

  useEffect(() => {
    if (!tokenStream) return;

    let cancelled = false;
    const reader = tokenStream.getReader();
    const nextSegmentKey = () => `segment-${++segmentSequenceRef.current}`;
    const nextTokenKey = () => `token-${++tokenSequenceRef.current}`;

    void (async () => {
      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) break;

        if ('recall' in (value as RecallToken)) {
          setTokenItems((current) => current.slice(0, Math.max(0, current.length - (value as RecallToken).recall)));
          continue;
        }

        const token = value as ThemedToken;
        const style = (token.htmlStyle || getTokenStyleObject(token)) as CSSProperties;
        setTokenItems((current) => {
          const visibleLength = current.reduce(
            (length, item) => length + item.segments.reduce((itemLength, segment) => itemLength + segment.content.length, 0),
            0,
          );
          // Only fade in characters past the high-water mark so re-tokenized prefixes don't re-animate.
          const stableLength = Math.min(animatedCharWatermarkRef.current, visibleLength + token.content.length);
          const existingLength = Math.max(0, stableLength - visibleLength);
          const stableContent = token.content.slice(0, existingLength);
          const freshContent = token.content.slice(existingLength);
          animatedCharWatermarkRef.current = Math.max(animatedCharWatermarkRef.current, visibleLength + token.content.length);

          return [
            ...current,
            {
              key: nextTokenKey(),
              segments: [
                ...(stableContent ? [{ key: nextSegmentKey(), content: stableContent, style, animate: false }] : []),
                ...(freshContent ? [{ key: nextSegmentKey(), content: freshContent, style, animate: true }] : []),
              ],
            },
          ];
        });
      }
    })().catch(() => { if (!cancelled) setFailed(true); });

    return () => {
      cancelled = true;
      void reader.cancel();
    };
  }, [tokenStream]);

  if (failed || !tokenStream || tokenItems.length === 0) return <PlainCode code={code} />;

  return (
    <pre className="shiki shiki-stream">
      <code>
        {tokenItems.flatMap((item) =>
          item.segments.map((segment) => (
            <span key={segment.key} className={segment.animate ? 'shiki-stream-token-new' : undefined} style={segment.style}>
              {segment.content}
            </span>
          )),
        )}
      </code>
    </pre>
  );
}

const ShikiStreamCodeBlock = memo(function ShikiStreamCodeBlock({ code, language, streaming }: ShikiStreamCodeBlockProps) {
  const resolvedLanguage = resolveChatCodeLanguage(language);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);

  useEffect(() => { setCopyState('idle'); }, [code]);

  useEffect(() => {
    if (copyState === 'idle') return;
    const timeoutId = window.setTimeout(() => setCopyState('idle'), 1200);
    return () => window.clearTimeout(timeoutId);
  }, [copyState]);

  // Auto-follow the tail. Only ever scrolls downward, so the `scroll` handler can treat any
  // upward delta as the user taking ownership — no timed suppression window needed.
  const stickToBottom = (viewport: HTMLDivElement) => {
    if (typeof viewport.scrollTo !== 'function') return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
  };

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!streaming || !viewport || !shouldStickToBottomRef.current) return;
    stickToBottom(viewport);
  }, [code, streaming]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!streaming || !viewport || typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => {
      if (shouldStickToBottomRef.current) stickToBottom(viewport);
    });
    observer.observe(viewport, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [streaming]);

  const handleCopy = async () => {
    try {
      await copyChatCode(code);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  };

  // Sample stickiness on every `scroll` (covers wheel, touch, scrollbar drag, keyboard).
  // Direction-based ownership: an upward scroll — impossible from our downward-only
  // auto-follow — immediately hands control to the user; scrolling back to the bottom
  // re-arms follow. No timer window, so a real scroll is never swallowed.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!streaming || !viewport) return;
    lastScrollTopRef.current = viewport.scrollTop;
    const onScroll = () => {
      shouldStickToBottomRef.current = nextScrollStickiness(shouldStickToBottomRef.current, {
        scrollTop: viewport.scrollTop,
        lastScrollTop: lastScrollTopRef.current,
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
      });
      lastScrollTopRef.current = viewport.scrollTop;
    };
    viewport.addEventListener('scroll', onScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', onScroll);
  }, [streaming]);

  const copyLabel = copyState === 'copied' ? 'Code copied' : copyState === 'error' ? 'Copy code failed, try again' : 'Copy code';

  return (
    <div
      data-testid="chat-code-block"
      data-code-language={resolvedLanguage}
      data-shiki-streaming={streaming ? 'true' : 'false'}
      className="chat-shiki-code"
    >
      <button
        type="button"
        aria-label={copyLabel}
        title={copyLabel}
        className="chat-shiki-code__copy"
        data-copy-state={copyState}
        disabled={!code.trim()}
        onClick={() => void handleCopy()}
      >
        {copyState === 'copied' ? <Check size={16} aria-hidden /> : copyState === 'error' ? <X size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
      </button>
      <div ref={viewportRef} className="chat-shiki-code__viewport">
        {streaming ? (
          <StreamingHighlightedCode code={code} language={resolvedLanguage} />
        ) : (
          <StaticHighlightedCode code={code} language={resolvedLanguage} />
        )}
      </div>
    </div>
  );
});

export default ShikiStreamCodeBlock;
