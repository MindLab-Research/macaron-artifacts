import { useEffect, useRef, useState } from 'react';
import type { QuestionResponse, QuestionState } from '../../../shared/questions';
import { Button } from '../ui4a-ui';
import { Icon } from '../Icon';

type Draft = { page: number; selected: Record<string, string[]>; custom: Record<string, string> };
const emptyDraft = (): Draft => ({ page: 0, selected: Object.create(null), custom: Object.create(null) });
const selectedAnswers = (draft: Draft, id: string): string[] => Object.hasOwn(draft.selected, id) ? draft.selected[id] : [];
const customAnswer = (draft: Draft, id: string): string => Object.hasOwn(draft.custom, id) ? draft.custom[id] : '';
function readDraft(key: string, request: QuestionState): Draft {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null'), draft = emptyDraft();
    if (!saved) return draft;
    draft.page = Number.isInteger(saved.page) ? Math.max(0, Math.min(saved.page, request.questions.length - 1)) : 0;
    for (const question of request.questions) {
      if (question.secret) continue;
      const selected = saved.selected?.[question.id];
      if (Array.isArray(selected)) draft.selected[question.id] = selected.filter(item => question.options.some(option => option.label === item));
      if (question.custom && typeof saved.custom?.[question.id] === 'string') draft.custom[question.id] = saved.custom[question.id];
    }
    return draft;
  } catch { return emptyDraft(); }
}

/** Visual adaptation of Beautiful UI's ApprovalCard (MIT); native request/answer state is owned by our stream. */
export function QuestionCard({ request, active, sessionId, onAnswer }: { request: QuestionState; active: boolean; sessionId: string; onAnswer: (response: QuestionResponse) => Promise<unknown> }) {
  const key = `macaron-artifacts:question:${sessionId}:${request.id}`;
  const [draft, setDraft] = useState(() => readDraft(key, request));
  const [sent, setSent] = useState<QuestionResponse>();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const submitting = useRef(false), heading = useRef<HTMLLegendElement>(null), fieldset = useRef<HTMLFieldSetElement>(null), previousPage = useRef(draft.page), pointerPage = useRef(false);
  const response = request.response ?? sent, question = request.questions[draft.page];
  useEffect(() => {
    try {
      if (response) { sessionStorage.removeItem(key); return; }
      // A detached stream can briefly report an error while its native turn is still waiting.
      if (!active) return;
      const publicIds = request.questions.filter(question => !question.secret).map(question => question.id);
      sessionStorage.setItem(key, JSON.stringify({ page: draft.page, selected: Object.fromEntries(publicIds.map(id => [id, draft.selected[id]])), custom: Object.fromEntries(publicIds.map(id => [id, draft.custom[id]])) }));
    } catch { /* A restricted browser can still answer without saving a draft. */ }
  }, [active, draft, key, request.questions, response]);
  useEffect(() => {
    if (previousPage.current === draft.page) return;
    previousPage.current = draft.page;
    heading.current?.focus({ preventScroll: true });
    if (pointerPage.current && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const animation = fieldset.current?.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 180, easing: 'cubic-bezier(.23,1,.32,1)' });
      return () => animation?.cancel();
    }
  }, [draft.page]);
  const answer = (id: string) => [...selectedAnswers(draft, id), ...(customAnswer(draft, id).trim() ? [customAnswer(draft, id).trim()] : [])];
  const goTo = (page: number, pointer = false) => { pointerPage.current = pointer; setDraft(current => ({ ...current, page })); setError(undefined); };
  const send = async (response: QuestionResponse) => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError(undefined);
    try { await onAnswer(response); setSent(response); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { submitting.current = false; setBusy(false); }
  };
  const advance = (pointer = false) => {
    if (!answer(question.id).length) return;
    if (draft.page < request.questions.length - 1) { goTo(draft.page + 1, pointer); return; }
    const missing = request.questions.findIndex(question => !answer(question.id).length);
    if (missing !== -1) { goTo(missing, pointer); setError('请先回答这道问题'); return; }
    void send({ answers: Object.fromEntries(request.questions.map(question => [question.id, [...new Set(answer(question.id))]])) });
  };
  if (response || !active) return <section aria-label="提问结果" className="w-full max-w-80 rounded-[10px] border border-border bg-surface p-3 text-xs">
    <p role="status" className={`flex items-center gap-1.5 ${response && 'answers' in response ? 'text-success' : 'text-muted'}`}><Icon name={response && 'answers' in response ? 'check' : 'x'} className="size-3.5" />{response && 'answers' in response ? '回答已发送' : response ? '已取消回答' : '提问已结束'}</p>
    {response && 'answers' in response ? <dl className="mt-2 space-y-2">{request.questions.map(question => <div key={question.id}><dt className="text-muted">{question.header || question.question}</dt><dd className="mt-0.5 whitespace-pre-wrap break-words">{question.secret ? '••••••' : response.answers[question.id]?.join('、')}</dd></div>)}</dl> : null}
  </section>;
  if (!question) return null;
  const selected = selectedAnswers(draft, question.id), last = draft.page === request.questions.length - 1;
  return <form aria-label="回答 agent 提问" aria-busy={busy} className="relative w-full max-w-80 rounded-[10px] border border-border bg-surface shadow-sm" onSubmit={event => { event.preventDefault(); advance(); }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}>
    <button type="button" aria-label="取消回答" disabled={busy} onClick={() => void send({ cancelled: true })} className="btn-icon absolute right-1.5 top-1.5 z-10 size-8 rounded-md disabled:opacity-40"><Icon name="x" className="size-3.5" /></button>
    <fieldset key={question.id} ref={fieldset} disabled={busy} className="min-w-0 p-3">
      <legend ref={heading} tabIndex={-1} className="float-left mb-2.5 w-full pr-7 text-sm font-medium outline-none">{question.header ? <span className="mb-1 block text-[11px] font-normal text-muted">{question.header}{question.multiple ? ' · 可多选' : ''}</span> : null}{question.question}</legend>
      <div className="clear-both flex flex-col gap-1">{question.options.map((option, index) => <label key={index} className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-2 text-[13px] hover:bg-surface-3 hover:text-hover-fg focus-within:outline-2 focus-within:outline-focus">
        <input type={question.multiple ? 'checkbox' : 'radio'} name={`${request.id}:${question.id}`} checked={selected.includes(option.label)} className="mt-0.5 size-4 shrink-0 accent-fg" onChange={() => setDraft(current => ({ ...current, selected: { ...current.selected, [question.id]: question.multiple ? selected.includes(option.label) ? selected.filter(value => value !== option.label) : [...selected, option.label] : [option.label] }, custom: question.multiple ? current.custom : { ...current.custom, [question.id]: '' } }))} />
        <span className="min-w-0 break-words"><span>{option.label}</span>{option.description ? <span className="mt-0.5 block text-xs text-muted">{option.description}</span> : null}{selected.includes(option.label) && option.preview ? <pre className="mt-2 whitespace-pre-wrap text-xs">{option.preview}</pre> : null}</span>
      </label>)}
        {question.custom ? <label className="mt-1 block"><span className="sr-only">{question.options.length ? '自定义回答' : question.question}</span><input type={question.secret ? 'password' : 'text'} value={customAnswer(draft, question.id)} placeholder={question.placeholder || (question.options.length ? '其他想法…' : '输入回答…')} maxLength={20_000} autoComplete="off" className="w-full min-w-0 rounded-lg border border-input-border bg-input-bg px-2.5 py-2 text-[13px] text-input-fg placeholder:text-input-placeholder focus:border-input-focus focus:outline-none" onChange={event => setDraft(current => ({ ...current, custom: { ...current.custom, [question.id]: event.target.value }, selected: question.multiple ? current.selected : { ...current.selected, [question.id]: [] } }))} /></label> : null}
      </div>
    </fieldset>
    {error ? <p role="alert" className="px-3 pb-2 text-xs text-danger">{error}</p> : null}
    <div className="flex items-center justify-between gap-2 border-t border-border p-2.5">
      <div className="flex items-center gap-0.5 text-muted"><button type="button" aria-label="上一题" disabled={busy || draft.page === 0} onClick={event => goTo(draft.page - 1, event.detail > 0)} className="btn-icon size-7 rounded-md disabled:opacity-30"><Icon name="chevronUp" className="size-3.5" /></button><span role="status" aria-label={`第 ${draft.page + 1} 题，共 ${request.questions.length} 题`} className="text-xs tabular-nums">{draft.page + 1} / {request.questions.length}</span><button type="button" aria-label="下一题" disabled={busy || last} onClick={event => goTo(draft.page + 1, event.detail > 0)} className="btn-icon size-7 rounded-md disabled:opacity-30"><Icon name="chevronDown" className="size-3.5" /></button></div>
      <Button size="sm" style={{ height: 28, borderRadius: 999 }} className="px-3 text-xs" disabled={busy || !answer(question.id).length} onClick={event => advance(event.detail > 0)}>{busy ? '发送中…' : last ? '发送回答' : '继续'}</Button>
    </div>
  </form>;
}
