import { useEffect, useRef, useState } from 'react';
import type { QuestionResponse, QuestionState } from '../../../shared/questions';
import { Button } from '../ui4a-ui';
import { Icon } from '../Icon';
import { QuestionChoices, QuestionCounter, useQuestionTrack } from './QuestionMotion';
import './QuestionCard.css';

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
  const submitting = useRef(false), moveFocus = useRef(false);
  const [motion, setMotion] = useState(false);
  const response = request.response ?? sent, question = request.questions[draft.page];
  const complete = !!response || !active, page = complete ? request.questions.length : draft.page;
  const previousPage = useRef(page);
  const { viewport, track } = useQuestionTrack(page);
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
    if (previousPage.current === page) return;
    previousPage.current = page;
    // Historical results and responses arriving after the user moves to the composer must not take focus.
    if (moveFocus.current && (!complete || document.activeElement === document.body || viewport.current?.parentElement?.contains(document.activeElement))) track.current?.children[page]?.querySelector<HTMLElement>('[data-question-heading]')?.focus({ preventScroll: true });
    moveFocus.current = false;
  }, [complete, page, track, viewport]);
  const answer = (id: string) => [...selectedAnswers(draft, id), ...(customAnswer(draft, id).trim() ? [customAnswer(draft, id).trim()] : [])];
  const goTo = (page: number) => { moveFocus.current = true; setDraft(current => ({ ...current, page })); setError(undefined); };
  const send = async (response: QuestionResponse) => {
    if (submitting.current) return;
    moveFocus.current = !!viewport.current?.parentElement?.contains(document.activeElement);
    submitting.current = true; setBusy(true); setError(undefined);
    try { await onAnswer(response); setSent(response); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { submitting.current = false; setBusy(false); }
  };
  const advance = () => {
    if (complete || !answer(question.id).length) return;
    if (draft.page < request.questions.length - 1) { goTo(draft.page + 1); return; }
    const missing = request.questions.findIndex(question => !answer(question.id).length);
    if (missing !== -1) { goTo(missing); setError('请先回答这道问题'); return; }
    void send({ answers: Object.fromEntries(request.questions.map(question => [question.id, [...new Set(answer(question.id))]])) });
  };
  if (!question) return null;
  const last = draft.page === request.questions.length - 1;
  return <form aria-label={complete ? '提问结果' : '回答 agent 提问'} aria-busy={busy} data-motion={motion} className="question-card relative w-full max-w-80 rounded-[10px] border border-border bg-surface shadow-sm" onPointerDownCapture={() => setMotion(true)} onPointerMoveCapture={() => setMotion(true)} onKeyDownCapture={() => setMotion(false)} onSubmit={event => { event.preventDefault(); advance(); }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}>
    {!complete ? <button type="button" aria-label="取消回答" disabled={busy} onClick={() => void send({ cancelled: true })} className="btn-icon absolute right-1.5 top-1.5 z-10 size-8 rounded-md disabled:opacity-40"><Icon name="x" className="size-3.5" /></button> : null}
    <div ref={viewport} className="question-viewport"><div ref={track} className="question-track">
      {request.questions.map((question, index) => {
        const selected = selectedAnswers(draft, question.id), current = page === index;
        return <fieldset key={question.id} disabled={busy || !current} inert={!current} aria-hidden={!current} data-active={current} className="question-page m-0 min-w-0 p-3">
          <legend data-question-heading tabIndex={-1} className="float-left mb-2.5 w-full pr-7 text-sm font-medium outline-none">{question.header ? <span className="mb-1 block text-[11px] font-normal text-muted">{question.header}{question.multiple ? ' · 可多选' : ''}</span> : null}{question.question}</legend>
          <QuestionChoices>{question.options.map((option, index) => <label key={index} data-question-choice className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-2 text-[13px] hover:text-hover-fg">
            <input type={question.multiple ? 'checkbox' : 'radio'} name={`${request.id}:${question.id}`} checked={selected.includes(option.label)} className="question-choice-input sr-only" onChange={() => setDraft(current => ({ ...current, selected: { ...current.selected, [question.id]: question.multiple ? selected.includes(option.label) ? selected.filter(value => value !== option.label) : [...selected, option.label] : [option.label] }, custom: question.multiple ? current.custom : { ...current.custom, [question.id]: '' } }))} />
            <span aria-hidden="true" className={`question-marker mt-0.5 size-4 shrink-0 ${question.multiple ? 'rounded-[5px]' : 'rounded-full'}`}>{question.multiple ? <Icon name="check" className="size-3" /> : <span />}</span>
            <span className="min-w-0 break-words"><span>{option.label}</span>{option.description ? <span className="mt-0.5 block text-xs text-muted">{option.description}</span> : null}{selected.includes(option.label) && option.preview ? <pre className="mt-2 whitespace-pre-wrap text-xs">{option.preview}</pre> : null}</span>
          </label>)}
            {question.custom ? <label data-question-choice className="mt-1 block"><span className="sr-only">{question.options.length ? '自定义回答' : question.question}</span><input type={question.secret ? 'password' : 'text'} value={complete && question.secret ? '' : customAnswer(draft, question.id)} placeholder={question.placeholder || (question.options.length ? '其他想法…' : '输入回答…')} maxLength={20_000} autoComplete="off" className="w-full min-w-0 rounded-lg border border-input-border bg-input-bg px-2.5 py-2 text-[13px] text-input-fg placeholder:text-input-placeholder focus:border-input-focus focus:outline-none" onChange={event => setDraft(current => ({ ...current, custom: { ...current.custom, [question.id]: event.target.value }, selected: question.multiple ? current.selected : { ...current.selected, [question.id]: [] } }))} /></label> : null}
          </QuestionChoices>
          {current && error ? <p role="alert" className="pt-2 text-xs text-danger">{error}</p> : null}
        </fieldset>;
      })}
      <section aria-label="提问结果" inert={!complete} aria-hidden={!complete} data-active={complete} className="question-page p-3 text-xs">
        <p data-question-heading tabIndex={-1} role="status" className={`flex items-center gap-1.5 outline-none ${response && 'answers' in response ? 'text-success' : 'text-muted'}`}><Icon name={response && 'answers' in response ? 'check' : 'x'} className="size-3.5" />{response && 'answers' in response ? '回答已发送' : response ? '已取消回答' : '提问已结束'}</p>
        {response && 'answers' in response ? <dl className="mt-2 space-y-2">{request.questions.map(question => <div key={question.id}><dt className="text-muted">{question.header || question.question}</dt><dd className="mt-0.5 whitespace-pre-wrap break-words">{question.secret ? '••••••' : response.answers[question.id]?.join('、')}</dd></div>)}</dl> : null}
      </section>
    </div></div>
    <div className="question-footer" data-closed={complete} inert={complete} aria-hidden={complete}><div>
      <div className="flex items-center justify-between gap-2 border-t border-border p-2.5">
        <div className="flex items-center gap-0.5 text-muted"><button type="button" aria-label="上一题" disabled={busy || draft.page === 0} onClick={() => goTo(draft.page - 1)} className="btn-icon size-7 rounded-md disabled:opacity-30"><Icon name="chevronUp" className="size-3.5" /></button><span role="status" aria-label={`第 ${draft.page + 1} 题，共 ${request.questions.length} 题`} className="text-xs tabular-nums"><QuestionCounter value={draft.page + 1} motion={motion} /><span aria-hidden="true"> / {request.questions.length}</span></span><button type="button" aria-label="下一题" disabled={busy || last} onClick={() => goTo(draft.page + 1)} className="btn-icon size-7 rounded-md disabled:opacity-30"><Icon name="chevronDown" className="size-3.5" /></button></div>
        <Button size="sm" style={{ height: 28, borderRadius: 999 }} className="px-3 text-xs" disabled={busy || complete || !answer(question.id).length} onClick={() => advance()}>{busy ? '发送中…' : last ? '发送回答' : '继续'}</Button>
      </div>
    </div></div>
  </form>;
}
