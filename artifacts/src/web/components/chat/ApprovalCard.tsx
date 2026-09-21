import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { Approval } from '../../../shared/types';
import { Button } from '../ui4a-ui';
import { CodeBlock } from '../code/CodeBlock';
import { Collapsible } from '../code/Collapsible';
import { MorphHeight } from '../MorphHeight';

export function ApprovalCard({ approval, onDecide }: { approval: Approval & { resolved?: boolean }; onDecide: (approved: boolean) => Promise<unknown> }) {
  const [decision, setDecision] = useState<boolean>();
  const [pending, setPending] = useState<boolean>();
  const [motion, setMotion] = useState(false);
  const submitting = useRef(false);
  const controls = useRef<HTMLDivElement | null>(null), result = useRef<HTMLParagraphElement>(null), focusResult = useRef(false);
  const [error, setError] = useState<string>();
  const busy = pending !== undefined;
  const finished = decision !== undefined || approval.resolved && !busy;
  const controlsRef = useCallback((node: HTMLDivElement | null) => {
    // Ref detachment runs before the focused buttons are removed; never take focus from another part of the page.
    if (!node && controls.current?.contains(document.activeElement)) focusResult.current = true;
    controls.current = node;
  }, []);
  useLayoutEffect(() => { if (finished && focusResult.current) { focusResult.current = false; result.current?.focus({ preventScroll: true }); } }, [finished]);
  const decide = async (approved: boolean, pointer: boolean) => {
    if (submitting.current || approval.resolved || decision !== undefined) return;
    submitting.current = true; setMotion(pointer); setPending(approved); setError(undefined);
    try { await onDecide(approved); setDecision(approved); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { submitting.current = false; setPending(undefined); }
  };
  // The resolved stream event can precede the HTTP acknowledgement; keep the pending decision visible until it settles.
  const status = finished ? `${approval.tool} · ${decision === undefined ? '已处理' : decision ? '已允许' : '已拒绝'}` : busy ? pending ? '正在允许操作…' : '正在拒绝操作…' : '';
  return <section className="approval-morph rounded-xl bg-surface-2 data-[finished]:bg-transparent" data-finished={finished || undefined} data-motion={motion} aria-label="操作确认"><MorphHeight change={Boolean(finished)} animate={motion}>
    <p ref={result} role="status" aria-atomic="true" tabIndex={finished ? -1 : undefined} className={finished ? 'text-xs text-muted' : 'sr-only'}>{status}</p>
    {!finished ? <div className="p-3"><p className="mb-2 text-sm font-medium">允许 {approval.tool}？</p><Collapsible><CodeBlock code={JSON.stringify(approval.input, null, 2)} lang="json" /></Collapsible>{error ? <p role="alert" className="mt-2 text-xs text-danger">{error}</p> : null}<div ref={controlsRef} aria-busy={busy} className="mt-3 flex gap-2"><Button size="sm" aria-disabled={busy} onClick={event => void decide(true, event.detail > 0)}>{pending === true ? '正在允许…' : '允许这次'}</Button><Button size="sm" variant="secondary" aria-disabled={busy} onClick={event => void decide(false, event.detail > 0)}>{pending === false ? '正在拒绝…' : '拒绝'}</Button></div></div> : null}
  </MorphHeight></section>;
}
