'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Field, Label, Select } from '@headlessui/react';
import type { ReasoningUIPart } from 'ai';
import { Reasoning } from './Reasoning';
import './ReasoningExamples.css';

const CASES = [
  ['summary-titles', 'GPT · 连续摘要标题'], ['summary-description', 'GPT · 标题和说明'], ['long', '开源模型 · 长思考'],
  ['claude', 'Claude · 分段思考'], ['interrupted', '已停止'], ['empty', '等待首段'], ['unknown', '未知来源 · 混合 Markdown'],
] as const;
type CaseId = typeof CASES[number][0];
type Playback = 'playing' | 'paused' | 'finished';
type Segment = { kind: 'reasoning'; parts: ReasoningUIPart[] } | { kind: 'tool' | 'answer'; text: string };
type Frame = { segments: Segment[]; live: boolean };
type PreviewProps = { initialCase?: string; initialState?: string; initialStep?: number; initialTheme?: string; themeControl?: ReactNode };
const REQUEST = '帮我检查会话恢复的实现，特别是多轮对话里模型状态有没有正确保留。';
const ANSWER = '已经核对了会话标识、历史消息和下一轮请求。恢复时会沿用原来的会话；正在生成的一轮完成后，再应用更新的配置。';
const normalizeCase = (value?: string): CaseId => CASES.find(([id]) => id === value)?.[0] ?? 'summary-titles';

function createFrames(example: CaseId): Frame[] {
  const frames: Frame[] = [];
  const segments: Segment[] = [];
  let current: ReasoningUIPart | undefined;
  let live = true;
  const capture = () => frames.push({ live, segments: segments.map(segment => segment.kind === 'reasoning' ? { ...segment, parts: segment.parts.map(part => ({ ...part })) } : { ...segment }) });
  const begin = (kind: 'summary' | 'full' | 'unknown', id: string) => {
    if (current) current.state = 'done';
    current = { type: 'reasoning', id, text: '', state: 'streaming', ...(kind === 'unknown' ? {} : { providerMetadata: { macaron: { reasoningKind: kind } } }) };
    const last = segments.at(-1);
    if (last?.kind === 'reasoning') last.parts.push(current);
    else segments.push({ kind: 'reasoning', parts: [current] });
    capture();
  };
  const write = (text: string) => {
    // Splitting inside Markdown delimiters exercises the actual incremental rendering path.
    for (let offset = 0; offset < text.length; offset += 12) { current!.text += text.slice(offset, offset + 12); capture(); }
  };
  const hold = (count = 10) => { for (let index = 0; index < count; index++) capture(); };
  const answer = (stale = false) => { if (current && !stale) current.state = 'done'; live = false; segments.push({ kind: 'answer', text: ANSWER }); capture(); };

  if (example === 'summary-titles') {
    for (const [index, heading] of ['Checking session restoration flow', 'Tracing the saved conversation', 'Verifying the next turn', 'Confirming the final behavior'].entries()) {
      begin('summary', `summary-${index}`); write(`**${heading}**`); hold();
    }
    answer();
  } else if (example === 'summary-description') {
    for (const [index, [heading, description]] of [
      ['Checking session restoration', 'I am following the saved session identifier through the restore path and checking that the next request uses the same conversation.'],
      ['Comparing provider behavior', 'The adapters preserve different pieces of state. I am checking the boundaries before deciding which behavior should be shared.'],
      ['Verifying the final result', 'The restored session keeps its message history, while configuration changes are applied at the start of the next turn.'],
    ].entries()) { begin('summary', `description-${index}`); write(`**${heading}**\n\n${description}`); hold(); }
    answer();
  } else if (example === 'long' || example === 'interrupted') {
    begin('full', 'full-reasoning');
    for (let index = 0; index < 8; index++) write(`首先看第 ${index + 1} 个恢复分支。这里需要区分会话中保存的配置与当前这一轮已经拿到的配置快照：前者可以更新，后者应当保持稳定。\n\n接着沿着请求的 sessionId 向下追踪。如果恢复时重新生成了标识，下一轮就可能丢失之前的上下文。需要检查持久化的消息是否仍然按原来的顺序进入适配器，以及工具结果是否与调用记录配对。\n\n`);
    if (example === 'interrupted') { live = false; capture(); }
    else answer();
  } else if (example === 'claude') {
    begin('full', 'claude-before-tool');
    write('我先确认会话恢复的入口。需要查看保存的会话标识怎样传入适配器，以及每一轮请求是否重新读取配置。\n\n这一处会影响多轮对话，所以接下来检查恢复路径和对应的测试。');
    current!.state = 'done'; capture();
    segments.push({ kind: 'tool', text: '已读取 session.ts 和 adapter.test.ts · 找到 3 个恢复分支' }); capture(); hold();
    begin('full', 'claude-after-tool');
    write('恢复路径保留了原来的会话标识。工具返回的测试记录也显示，第二轮沿用了第一轮的上下文。\n\n还需要确认配置更新只影响下一轮，避免生成过程中替换当前的模型或连接参数。');
    hold(); answer();
  } else if (example === 'empty') {
    begin('full', 'waiting-reasoning'); hold(50); answer();
  } else {
    begin('unknown', 'imported-reasoning');
    write('The provider returned a reasoning stream without a presentation hint. This paragraph is part of the original content.\n\n**A heading within the transcript**\n\nA bold line does not mean the rest of the reasoning should disappear. The full stream must remain readable, including the explanation after this heading.\n\n');
    write('1. Check the saved session identifier.\n2. Keep tool results paired with their calls.\n3. Apply updated settings on the next turn.\n\n`sessionId` should survive reconnects, and **important inline emphasis** should stay within its paragraph.\n\n');
    write('This is a long unbroken identifier to verify wrapping: session_restore_0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz.');
    // Persisted streams can retain a stale part state after reload; live=false must win.
    answer(true);
  }
  return frames;
}

export function ReasoningExamples({ initialCase, initialState, initialStep, initialTheme, themeControl }: PreviewProps) {
  const [example, setExample] = useState(() => normalizeCase(initialCase));
  const frames = useMemo(() => createFrames(example), [example]);
  const [cursor, setCursor] = useState(() => initialState === 'finished' ? frames.length - 1 : Math.max(0, Math.min(Number.isFinite(initialStep) ? Math.floor(initialStep!) : 0, frames.length - 1)));
  const [playing, setPlaying] = useState(initialState !== 'paused' && initialState !== 'finished');
  const [theme, setTheme] = useState(initialTheme === 'dark' ? 'dark' : 'light');
  const frame = frames[Math.min(cursor, frames.length - 1)];
  const state: Playback = cursor === frames.length - 1 ? 'finished' : playing ? 'playing' : 'paused';
  useEffect(() => {
    if (!playing || cursor >= frames.length - 1) return;
    const timeout = window.setTimeout(() => setCursor(value => Math.min(value + 1, frames.length - 1)), 90);
    return () => window.clearTimeout(timeout);
  }, [playing, cursor, frames.length]);
  useEffect(() => { if (!themeControl) document.documentElement.dataset.theme = theme; }, [theme, themeControl]);
  const choose = (next: string) => { setExample(normalizeCase(next)); setCursor(0); setPlaying(true); };
  const replay = () => { setCursor(0); setPlaying(true); };
  return <main className="reasoning-examples" data-example-case={example} data-example-state={state} data-example-step={cursor} data-example-total={frames.length}>
    <header className="reasoning-examples-toolbar">
      <Field className="reasoning-examples-field"><Label>场景</Label><Select value={example} onChange={event => choose(event.target.value)}>{CASES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</Select></Field>
      <div className="reasoning-examples-playback"><Button onClick={state === 'finished' ? replay : () => setPlaying(value => !value)}>{state === 'playing' ? '暂停' : '播放'}</Button><Button onClick={replay}>重播</Button></div>
      <label className="reasoning-examples-progress"><span className="reasoning-examples-sr-only">播放进度</span><input type="range" min={0} max={frames.length - 1} value={cursor} onChange={event => { setCursor(Number(event.target.value)); setPlaying(false); }} /></label>
      {themeControl ?? <Field className="reasoning-examples-field"><Label>外观</Label><Select value={theme} onChange={event => setTheme(event.target.value)}><option value="light">浅色</option><option value="dark">深色</option></Select></Field>}
    </header>
    <div className="reasoning-examples-conversation">
      <article className="reasoning-examples-user" aria-label="用户消息"><p>{REQUEST}</p></article>
      <article className="reasoning-examples-assistant" aria-label="助手消息">
        {frame.segments.map((segment, index) => segment.kind === 'reasoning' ? <Reasoning key={index} parts={segment.parts} live={frame.live} /> : segment.kind === 'tool' ? <div key={index} className="reasoning-examples-tool" data-example-tool>{segment.text}</div> : <p key={index} className="reasoning-examples-answer" data-example-answer>{segment.text}</p>)}
        {example === 'interrupted' && state === 'finished' ? <p className="reasoning-examples-stopped" data-example-stopped>已停止生成</p> : null}
      </article>
    </div>
  </main>;
}
