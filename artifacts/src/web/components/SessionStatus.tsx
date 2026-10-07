import { useLayoutEffect, useRef } from 'react';
import type { SessionSummary } from '../../shared/types';
import { Icon } from './Icon';
const labels = { idle: '未开始', running: '正在生成', answer: '等待回答', approval: '等待审批', error: '失败', complete: '已完成' };
export function SessionStatus({ session }: { session: SessionSummary }) {
  const activity = session.activity ?? (session.status === 'idle' ? 'idle' : session.status);
  const element = useRef<HTMLSpanElement>(null), previous = useRef(activity);
  useLayoutEffect(() => {
    const changed = previous.current !== activity; previous.current = activity;
    if (!changed || document.hidden) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    if (reduced.matches) return;
    const animation = element.current?.animate([{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: 160, easing: 'cubic-bezier(.23,1,.32,1)' });
    const cancel = () => animation?.cancel(); reduced.addEventListener('change', cancel);
    return () => { cancel(); reduced.removeEventListener('change', cancel); };
  }, [activity]);
  return <span ref={element} data-session-activity={activity} className={`flex items-center gap-1 text-[11px] ${activity === 'error' ? 'text-danger' : activity === 'answer' || activity === 'approval' ? 'text-accent' : 'text-muted'}`}>{activity === 'complete' || activity === 'error' ? <Icon name={activity === 'complete' ? 'check' : 'x'} className="size-3" /> : <span aria-hidden className={`mx-0.75 size-1.5 rounded-full ${activity === 'idle' ? 'bg-current opacity-30' : 'bg-current'}`} />}{labels[activity]}</span>;
}
