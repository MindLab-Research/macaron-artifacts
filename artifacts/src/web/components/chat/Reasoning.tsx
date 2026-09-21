'use client';
/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- The named overflowing region must support keyboard scrolling. */

import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Disclosure, DisclosureButton } from '@headlessui/react';
import type { ReasoningUIPart } from 'ai';
import { Streamdown } from 'streamdown';
import { markdownPlugins } from '../../chat/markdown';
import { normalizeMath } from '../../chat/math';
import { Icon } from '../Icon';
import { analyzeReasoning, createSummaryArrivalTracker } from './reasoning-model';
import { useReasoningScroll } from './useReasoningScroll';
import { exportRehypePlugins } from '../../chat/export-links';
import './Reasoning.css';

const Markdown = memo(function Markdown({ text, live }: { text: string; live: boolean }) {
  // Reasoning is text, never an executable UI4A surface. Streamdown handles incomplete Markdown.
  return <Streamdown plugins={markdownPlugins} rehypePlugins={exportRehypePlugins} controls={false} isAnimating={live}>{normalizeMath(text)}</Streamdown>;
});

export const Reasoning = memo(function Reasoning({ parts, live }: { parts: readonly ReasoningUIPart[]; live: boolean }) {
  const active = live && parts.some(part => part.state !== 'done');
  const presentation = useMemo(() => analyzeReasoning(parts, active), [parts, active]);
  if (!presentation.entries.length && !active) return null;
  return <Disclosure as="section" className="reasoning" data-reasoning-kind={presentation.kind} data-reasoning-active={active}>
    {({ open }) => <ReasoningView presentation={presentation} active={active} historyOpen={open} />}
  </Disclosure>;
});

function ReasoningView({ presentation, active, historyOpen }: { presentation: ReturnType<typeof analyzeReasoning>; active: boolean; historyOpen: boolean }) {
  const regionId = useId();
  const { kind, entries } = presentation;
  const visible = kind === 'summary' && !historyOpen ? entries.slice(-1) : entries;
  const contentKey = `${historyOpen}:${visible.map(entry => `${entry.key}:${entry.text}`).join('\n')}`;
  const { viewport, content, following, overflowing, resume } = useReasoningScroll(contentKey, active && !historyOpen);
  const [arrivals] = useState(() => createSummaryArrivalTracker(entries));
  const arrival = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const enabled = kind === 'summary' && active && !historyOpen;
    if (!enabled) arrival.current?.cancel();
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const isNew = arrivals.isNew(entries, enabled);
    if (!enabled) { arrivals.consume(entries); return; }
    // Background or reduced-motion arrivals are intentionally consumed without replay when the view returns.
    if (!isNew || document.hidden || reduced.matches) { if (entries.at(-1)?.state !== 'streaming' || document.hidden || reduced.matches) arrivals.consume(entries); return; }
    const latest = content.current?.querySelector<HTMLElement>(':scope > [data-reasoning-latest="true"]');
    if (!latest || latest.hidden || !latest.animate) return;
    // Animate this arrival once. Token renders and display:none history toggles cannot restart a WAAPI animation.
    arrival.current?.cancel();
    const animation = latest.animate([{ opacity: 0.55 }, { opacity: 1 }], { duration: 160, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    arrivals.consume(entries);
    arrival.current = animation;
    const cancel = () => { if (reduced.matches || document.hidden) animation.cancel(); };
    const cleanup = () => { reduced.removeEventListener('change', cancel); document.removeEventListener('visibilitychange', cancel); };
    // Only active arrivals subscribe; old reasoning blocks must not accumulate document listeners.
    reduced.addEventListener('change', cancel); document.addEventListener('visibilitychange', cancel);
    animation.onfinish = cleanup; animation.oncancel = cleanup;
  }, [entries, kind, active, historyOpen, arrivals, content]);
  useEffect(() => () => arrival.current?.cancel(), []);
  return <>
    <div className="reasoning-main">
      <span className="reasoning-sr-only" role="status">{active ? '正在思考' : ''}</span>
      <div id={regionId} ref={viewport} className="reasoning-viewport" role="region" aria-label={kind === 'summary' ? '思考摘要' : '思考过程'} tabIndex={overflowing ? 0 : undefined}>
        <div ref={content} className="reasoning-content">
          {/* Keep earlier summaries mounted so exports include history that has never been opened. */}
          {entries.map(entry => <div key={entry.key} hidden={kind === 'summary' && !historyOpen && entry.key !== entries.at(-1)?.key} data-reasoning-entry data-reasoning-latest={kind === 'summary' ? entry.key === entries.at(-1)?.key : undefined}><Markdown text={entry.text} live={active} /></div>)}
          {!entries.length && active ? <span className="reasoning-placeholder">正在思考</span> : null}
        </div>
      </div>
      {(kind === 'summary' && entries.length > 1) || (overflowing && !following && active && !historyOpen) ? <div className="reasoning-actions">
        {kind === 'summary' && entries.length > 1 ? <DisclosureButton data-export-reasoning-toggle data-reasoning-count={entries.length} aria-controls={regionId} className="reasoning-action" onClick={() => { if (historyOpen) resume(); }} title={historyOpen ? '仅显示最新摘要' : '查看先前摘要'}><Icon name="chevronDown" className="reasoning-action-icon" /><span>{historyOpen ? '仅显示最新' : `${entries.length} 段摘要`}</span></DisclosureButton> : null}
        {overflowing && !following && active && !historyOpen ? <button type="button" className="reasoning-action reasoning-resume" onClick={resume} title="继续跟随思考"><Icon name="arrowDown" className="reasoning-action-icon" /><span>跟随最新</span></button> : null}
      </div> : null}
    </div>
  </>;
}
