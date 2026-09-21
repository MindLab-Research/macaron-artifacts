import { useEffect, useId, useRef } from 'react';
import { useInputHistory } from './useInputHistory';
import { Icon } from '../Icon';

export function Composer({ text, setText, disabled, busy, onSend, onStop }: { text: string; setText: (text: string) => void; disabled: boolean; busy: boolean; onSend: (text: string) => void; onStop: () => void }) {
  const helpId = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const history = useInputHistory(text, setText, area);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || (active as HTMLElement | null)?.isContentEditable) return;
      event.preventDefault(); area.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { const element = area.current; if (element) { element.style.height = '0px'; element.style.height = `${Math.min(element.scrollHeight, 200)}px`; } }, [text]);
  const sendable = !disabled && Boolean(text.trim());
  const submit = () => { if (!sendable) return; onSend(text.trim()); history.remember(text.trim()); setText(''); };
  return <div className="shrink-0 p-3"><div className="interactive mx-auto flex w-full max-w-3xl items-end gap-2 rounded-2xl border border-input-border bg-input-bg p-2 focus-within:border-focus">
    <textarea ref={area} value={text} rows={1} disabled={disabled} placeholder="让它给你造个界面…" aria-label="消息" aria-describedby={helpId} title="/ 聚焦　↑↓ 翻历史　Enter 发送　Shift+Enter 换行" onChange={event => { history.onEdit(); setText(event.target.value); }} onKeyDown={event => { if (history.onKeyDown(event)) return; if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} className="max-h-50 min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-input-fg outline-none placeholder:text-input-placeholder" />
    {busy ? <button type="button" onClick={onStop} title="停止" aria-label="停止" className={`pressable interactive grid size-8 shrink-0 place-items-center rounded-full ${sendable ? 'text-muted hover:bg-surface-3 hover:text-hover-fg' : 'bg-accent text-accent-fg hover:bg-accent-hover active:scale-95'}`}><Icon name="x" filled className="size-3.5" /></button> : null}
    {busy && !sendable ? null : <button type="button" onClick={submit} disabled={!sendable} title={busy ? '加入队列' : '发送'} aria-label={busy ? '加入队列' : '发送'} className={`pressable interactive grid size-8 shrink-0 place-items-center rounded-full ${sendable ? 'bg-accent text-accent-fg hover:bg-accent-hover active:scale-95' : 'cursor-not-allowed bg-surface-3 text-muted'}`}><Icon name="send" /></button>}
  </div><span id={helpId} className="sr-only">斜杠聚焦输入框，上下键浏览历史，Enter 发送，Shift 加 Enter 换行</span></div>;
}
