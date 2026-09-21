import { expect, test } from 'bun:test';
import { parseQuestionResponse, type QuestionRequest } from '../../shared/questions.js';
import { claudeOptions } from './claude.js';
import { codexServerRequest } from './codex.js';
import { piQuestionUI } from './pi.js';
import { nativeQuestions } from './questions.js';
import type { HarnessTurn } from './types.js';

const turn = (extra: Partial<HarnessTurn> = {}): HarnessTurn => ({ cwd: '/tmp', prompt: '', instructions: '', signal: new AbortController().signal, onNativeSession() {}, approve: async () => { throw new Error('Questions must not use tool approvals'); }, ask: async () => ({ cancelled: true }), ...extra });
const choices = [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }];
test('validates complete answers, choice membership and multiplicity against the pending questionnaire', () => {
  const request: QuestionRequest = { id: 'request', questions: [{ id: 'one', question: 'Choose one', options: choices }, { id: 'many', question: 'Choose many', options: choices, multiple: true, custom: true }] };
  const response = { answers: { one: ['A'], many: ['B', '自定义答案'] } };
  expect(parseQuestionResponse(request, response)).toEqual(response);
  expect(parseQuestionResponse(request, { cancelled: true })).toEqual({ cancelled: true });
  for (const answers of [{ one: ['A'] }, { one: ['A', 'B'], many: ['A'] }, { one: ['C'], many: ['A'] }, { one: ['A'], many: [] }, { one: ['A'], many: [' '] }, { one: ['A'], many: [123] }, { one: ['A'], many: ['A', 'A'] }, { ...response.answers, extra: ['B'] }]) expect(parseQuestionResponse(request, { answers })).toBeUndefined();
});

test('Codex preserves native question IDs and returns selected and custom answers in its RPC envelope', async () => {
  const params = { questions: [{ id: 'format', header: 'Format', question: 'Which format?', isOther: true, options: choices }, { id: 'notes', question: 'Notes?', options: null, isSecret: true }] };
  const result = await codexServerRequest(turn({ ask: async request => {
    expect(request.questions[0]).toMatchObject({ id: 'format', custom: true, multiple: false, options: choices });
    expect(request.questions[1]).toMatchObject({ id: 'notes', custom: true, secret: true });
    return { answers: { format: ['B'], notes: ['具体要求'] } };
  } }), 'item/tool/requestUserInput', params);
  expect(result).toEqual({ answers: { format: { answers: ['B'] }, notes: { answers: ['具体要求'] } } });
  expect(await codexServerRequest(turn(), 'item/tool/requestUserInput', params)).toEqual({ answers: {} });
  expect(await codexServerRequest(turn({ enrichment: true, ask: async () => { throw new Error('Metadata cannot ask'); } }), 'item/tool/requestUserInput', params)).toEqual({ answers: {} });
});

test('Claude allows AskUserQuestion with answer strings keyed by question text and denies cancellation', async () => {
  const input = { questions: [{ question: 'Which features?', header: 'Features', options: choices, multiSelect: true }, { question: 'Anything else?', options: choices, multiSelect: false }] };
  const context = { signal: new AbortController().signal, toolUseID: 'tool', requestId: 'request' };
  const options = claudeOptions(turn({ ask: async (request, signal) => {
    expect(signal).toBe(context.signal); expect(request.questions[0]).toMatchObject({ multiple: true, custom: true });
    return { answers: { '0': ['A', 'B'], '1': ['自定义'] } };
  } }), new AbortController());
  expect(await options.canUseTool!('AskUserQuestion', input, context)).toEqual({ behavior: 'allow', updatedInput: { ...input, answers: { 'Which features?': 'A, B', 'Anything else?': '自定义' } } });
  expect(await claudeOptions(turn(), new AbortController()).canUseTool!('AskUserQuestion', input, context)).toMatchObject({ behavior: 'deny', interrupt: false });
});

test('OpenCode custom=false and native multi-select flags survive normalization', () => {
  expect(nativeQuestions([{ question: 'Choose', options: choices, multiple: true, custom: false }], 'opencode')[0]).toMatchObject({ id: '0', multiple: true, custom: false });
  expect(() => nativeQuestions([], 'codex')).toThrow('empty questionnaire');
  expect(() => nativeQuestions([{ id: 'a', question: 'One' }, { id: 'a', question: 'Two' }], 'codex')).toThrow('duplicate question IDs');
});

test('pi selectors and inputs return strings, and timeout or metadata return cancellation', async () => {
  const ui = piQuestionUI(turn({ ask: async request => {
    const question = request.questions[0];
    if (question.options.length) { expect(question.custom).toBe(false); return { answers: { answer: ['B'] } }; }
    expect(question.placeholder).toBe('Add details'); return { answers: { answer: ['hello'] } };
  } }));
  expect(await ui.select('Pick', ['A', 'B'])).toBe('B');
  expect(await ui.input('Details', 'Add details')).toBe('hello');
  expect(await piQuestionUI(turn({ enrichment: true, ask: async () => { throw new Error('Metadata cannot ask'); } })).input('Details')).toBeUndefined();
  const timeout = piQuestionUI(turn({ ask: (_request, signal) => new Promise(resolve => signal!.addEventListener('abort', () => resolve({ cancelled: true }), { once: true })) }));
  expect(await timeout.select('Pick', ['A'], { timeout: 1 })).toBeUndefined();
});
