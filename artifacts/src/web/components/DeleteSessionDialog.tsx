import { Description, Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { useRef, useState } from 'react';
import type { SessionSummary } from '../../shared/types';
import { Button } from './ui4a-ui';

export function DeleteSessionDialog({ session, onClose, onDelete }: { session: Pick<SessionSummary, 'title' | 'status'>; onClose: () => void; onDelete: () => Promise<unknown> }) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const running = session.status === 'running';
  const dismiss = () => { if (!pending.current) onClose(); };
  const confirm = async () => {
    // React has not necessarily committed disabled state before a second activation arrives.
    if (pending.current || running) return;
    pending.current = true; setBusy(true); setError(undefined);
    try { await onDelete(); onClose(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; setBusy(false); }
  };
  // Headless UI blurs before its Escape onClose callback; retain focus when an in-flight deletion cannot be dismissed.
  return <Dialog open onClose={dismiss} onKeyDownCapture={event => { if (pending.current && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); } }} className="relative z-confirm"><div className="fixed inset-0 bg-black/40" /><div className="fixed inset-0 grid place-items-center p-4"><DialogPanel className="theme-widget w-full max-w-sm rounded-2xl p-5">
    <DialogTitle className="break-words text-base font-medium">删除「{session.title}」？</DialogTitle>
    <Description className="mt-2 text-sm text-muted">会话记录将被永久删除，此操作无法撤销。</Description>
    {error ? <p role="alert" className="mt-3 break-words text-sm text-danger">{error}</p> : null}
    <p role="status" className={running ? 'mt-3 text-sm text-muted' : 'sr-only'}>{busy ? '正在删除会话…' : running ? '请先停止生成，再删除会话。' : ''}</p>
    <div aria-busy={busy} className="mt-5 flex justify-end gap-2"><Button autoFocus variant="secondary" aria-disabled={busy} onClick={dismiss}>取消</Button><Button variant="danger" aria-disabled={busy || running} onClick={() => { void confirm(); }}>{busy ? '正在删除…' : '删除会话'}</Button></div>
  </DialogPanel></div></Dialog>;
}
