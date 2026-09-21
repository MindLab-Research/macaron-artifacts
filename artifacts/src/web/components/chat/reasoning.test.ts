import { describe, expect, test } from 'bun:test';
import type { ReasoningUIPart } from 'ai';
import { analyzeReasoning, createSummaryArrivalTracker, reasoningRunAt } from './reasoning-model';

const part = (text: string, extra: Partial<ReasoningUIPart> = {}): ReasoningUIPart => ({ type: 'reasoning', text, ...extra });
const summary = (text: string, extra: Partial<ReasoningUIPart> = {}) => part(text, { providerMetadata: { macaron: { reasoningKind: 'summary' } }, ...extra });

describe('reasoning presentation', () => {
  test('groups only adjacent parts without erasing their identities or crossing an answer or tool', () => {
    const first = part('First block', { id: 'first' });
    const second = part('Second block', { id: 'second' });
    const third = part('Third block', { id: 'third' });
    const parts = [first, second, { type: 'tool-read' }, third, { type: 'text' }, part('Fourth block')];
    expect(reasoningRunAt(parts, 0)).toEqual([first, second]);
    expect(reasoningRunAt(parts, 0)?.[0]).toBe(first);
    expect(reasoningRunAt(parts, 1)).toBeUndefined();
    expect(reasoningRunAt(parts, 2)).toBeUndefined();
    expect(reasoningRunAt(parts, 3)).toEqual([third]);
    expect(reasoningRunAt(parts, 5)).toHaveLength(1);
  });

  test('keeps raw full reasoning and separate provider blocks intact', () => {
    const texts = ['  Inspect the constraints.\n\nThen compare both paths.  ', 'A separate block after an unseen reasoning gap.'];
    const result = analyzeReasoning(texts.map((text, index) => part(text, { id: `block-${index}` })));
    expect(result.kind).toBe('full');
    expect(result.entries.map((entry) => entry.text)).toEqual(texts);
    expect(result.entries.map((entry) => entry.key)).toEqual(['block-0', 'block-1']);
  });

  test('keeps descriptions with their summary heading and retains history across parts', () => {
    const result = analyzeReasoning([
      summary('**Inspecting the existing code**\n\nRead both implementations before changing the presentation.\n\n**Comparing the rendering paths**\n\nCheck which events preserve the summary.', { id: 'one' }),
      summary('**Preparing the final patch**', { id: 'two' }),
    ]);
    expect(result.kind).toBe('summary');
    expect(result.entries.map((entry) => entry.text)).toEqual([
      '**Inspecting the existing code**\n\nRead both implementations before changing the presentation.',
      '**Comparing the rendering paths**\n\nCheck which events preserve the summary.',
      '**Preparing the final patch**',
    ]);
    expect(new Set(result.entries.map((entry) => entry.key)).size).toBe(3);
  });

  test('does not replace the previous summary while the next heading is incomplete', () => {
    const previous = '**Inspecting the source**\n\nThe implementation is under review.';
    const next = '**Comparing the rendering paths**';
    const stable = analyzeReasoning([summary(previous)]).entries.at(-1);
    for (let length = 1; length < next.length; length++) {
      expect(analyzeReasoning([summary(`${previous}\n\n${next.slice(0, length)}`)], true).entries.at(-1)).toEqual(stable);
    }
    expect(analyzeReasoning([summary(`${previous}\n\n${next}`)]).entries.at(-1)?.text).toBe(next);
  });

  test('keeps inferred summary compact during a new heading but preserves interrupted text', () => {
    const complete = '**Inspecting the source**\n\n**Comparing the rendering paths**';
    const next = '**Preparing the final patch**';
    for (let length = 1; length < next.length; length++) {
      const result = analyzeReasoning([part(`${complete}\n\n${next.slice(0, length)}`)], true);
      expect(result.kind).toBe('summary');
      expect(result.entries.at(-1)?.text).toBe('**Comparing the rendering paths**');
      const separate = analyzeReasoning([part(complete), part(next.slice(0, length), { state: 'streaming' })], true);
      expect(separate.kind).toBe('summary');
      expect(separate.entries.at(-1)?.text).toBe('**Comparing the rendering paths**');
    }
    const interrupted = `${complete}\n\n**Preparing the`;
    expect(analyzeReasoning([part(interrupted)]).entries[0].text).toBe(interrupted);
    expect(analyzeReasoning([summary(interrupted)]).entries.at(-1)?.text).toContain('**Preparing the');
    expect(analyzeReasoning([summary(interrupted, { state: 'done' })], true).entries.at(-1)?.text).toContain('**Preparing the');
  });

  test('infers summary only from multiple standalone headings and respects explicit full metadata', () => {
    expect(analyzeReasoning([part('**One heading**')]).kind).toBe('full');
    expect(analyzeReasoning([part('**One heading**\n**Another heading**')]).kind).toBe('summary');
    expect(analyzeReasoning([part('**One heading**'), part('**Another heading**')]).kind).toBe('summary');
    expect(analyzeReasoning([part('**One heading**\n\nSome explanation.\n\n**Another heading**')]).kind).toBe('full');
    expect(analyzeReasoning([part('**One heading** and **some prose**\n\n**Another heading**')]).kind).toBe('full');
    expect(analyzeReasoning([part('**One heading**\n\n**Another heading**', { providerMetadata: { macaron: { reasoningKind: 'full' } } })]).kind).toBe('full');
  });

  test('honors known legacy IDs and lets explicit metadata override them', () => {
    expect(analyzeReasoning([part('A plain summary.', { id: 'turn:item:summary:0' })]).kind).toBe('summary');
    expect(analyzeReasoning([part('**One heading**\n\n**Another heading**', { id: 'turn:item:content:0' })]).kind).toBe('full');
    expect(analyzeReasoning([summary('A plain summary.', { id: 'turn:item:content:0' })]).kind).toBe('summary');
  });

  test('does not interpret headings in fenced code as new status entries', () => {
    const text = '**Inspecting the example**\n\n```markdown\n**This is example code**\n```\n\n**Checking the result**';
    const result = analyzeReasoning([summary(text)]);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].text).toContain('```markdown\n**This is example code**\n```');
    expect(analyzeReasoning([part('```markdown\n**One heading**\n**Another heading**\n```')]).kind).toBe('full');
  });

  test('ignores empty completed blocks without hiding earlier content', () => {
    const result = analyzeReasoning([summary('**Inspecting the source**'), summary('', { state: 'done' }), part(' \n ', { state: 'done' })]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].text).toBe('**Inspecting the source**');
    expect(analyzeReasoning([part('', { state: 'done' })])).toEqual({ kind: 'full', entries: [] });
  });
});

describe('summary arrival identity', () => {
  const entries = (text: string, state: 'streaming' | 'done' = 'streaming') => analyzeReasoning([summary(text, { id: 'summary', state })], true).entries;
  test('seeds the initial snapshot and remounted history without replaying', () => {
    const current = entries('**Current**');
    const tracker = createSummaryArrivalTracker(current);
    expect(tracker.isNew(current, true)).toBe(false);
    expect(tracker.isNew(entries('**Current**\nMore text'), true)).toBe(false);
  });
  test('fades each new live identity once, not each token or repeated appearance', () => {
    const first = entries('**First**'), next = entries('**First**\n\n**Next**');
    const arrives = createSummaryArrivalTracker(first);
    expect(arrives.isNew(next, true)).toBe(true); arrives.consume(next);
    expect(arrives.isNew(entries('**First**\n\n**Next**\nNew token'), true)).toBe(false);
    arrives.consume(first);
    expect(arrives.isNew(next, true)).toBe(false);
  });
  test('consumes hidden history arrivals and completed backfill even when the turn is live', () => {
    const arrives = createSummaryArrivalTracker([]);
    expect(arrives.isNew(entries('**History**', 'done'), true)).toBe(false); arrives.consume(entries('**History**', 'done'));
    expect(arrives.isNew(entries('**History**\n\n**Hidden arrival**'), false)).toBe(false); arrives.consume(entries('**History**\n\n**Hidden arrival**'));
    expect(arrives.isNew(entries('**History**\n\n**Hidden arrival**'), true)).toBe(false);
    expect(arrives.isNew(entries('**History**\n\n**Hidden arrival**\n\n**Visible arrival**'), true)).toBe(true);
  });
  test('history-open arrivals become baseline before the latest view is restored', () => {
    const arrives = createSummaryArrivalTracker(entries('**Initial**'));
    const hidden = entries('**Initial**\n\n**Hidden**');
    expect(arrives.isNew(hidden, false)).toBe(false); arrives.consume(hidden);
    expect(arrives.isNew(hidden, true)).toBe(false);
  });
  test('unknown provenance is baseline, and incomplete headings do not count as arrivals', () => {
    const initial = analyzeReasoning([summary('**Existing**', { id: 'summary' })], true).entries;
    const arrives = createSummaryArrivalTracker([]);
    expect(arrives.isNew(initial, true)).toBe(false); arrives.consume(initial);
    expect(arrives.isNew(entries('**Existing**\n\n**Incompl'), true)).toBe(false);
    expect(arrives.isNew(entries('**Existing**\n\n**Complete**'), true)).toBe(true);
  });
});
