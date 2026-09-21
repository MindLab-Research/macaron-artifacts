import type { ReasoningUIPart } from 'ai';
import { parseMarkdownIntoBlocks } from 'streamdown';

type ReasoningEntry = { key: string; text: string; state?: ReasoningUIPart['state'] };
type ReasoningKind = 'summary' | 'full';

export function reasoningRunAt(parts: readonly { type: string }[], index: number): ReasoningUIPart[] | undefined {
  if (parts[index]?.type !== 'reasoning' || parts[index - 1]?.type === 'reasoning') return undefined;
  const run: ReasoningUIPart[] = [];
  for (let current = index; current < parts.length && parts[current].type === 'reasoning'; current++) run.push(parts[current] as ReasoningUIPart);
  return run;
}

function declaredKind(part: ReasoningUIPart): ReasoningKind | undefined {
  const kind = part.providerMetadata?.macaron?.reasoningKind;
  if (kind === 'summary' || kind === 'full') return kind;
  const legacy = /:(summary|content):\d+$/.exec(part.id ?? '')?.[1];
  return legacy === 'summary' ? 'summary' : legacy === 'content' ? 'full' : undefined;
}

function summaryEntries(part: ReasoningUIPart, partIndex: number, live: boolean) {
  const entries: ReasoningEntry[] = [];
  const prefix = part.id ?? `reasoning-${partIndex}`;
  let text = '';
  let headingCount = 0;
  let headingsOnly = true;
  const flush = () => {
    if (text.trim()) entries.push({ key: `${prefix}:${entries.length}`, text: text.trim(), state: part.state });
    text = '';
  };
  const blocks = parseMarkdownIntoBlocks(part.text);
  for (const block of blocks) {
    // Parse block boundaries first so a code sample cannot become a thinking status.
    if (/^ {0,3}(?:`{3,}|~{3,})/.test(block) || /^ {4}\S/.test(block)) {
      headingsOnly = false;
      text += block;
      continue;
    }
    const lines = block.split(/(?<=\n)/);
    for (const line of lines) {
      if (/^ {0,3}(\*\*|__)(?=\S)((?:(?!\1).)+?)\1[\t ]*\r?\n?$/.test(line)) {
        flush();
        headingCount++;
        text = line;
      } else if (live && (/^ {0,3}(\*\*|__)(?:(?!\1)[^\n])*$/.test(line) || /^ {0,3}[*_]$/.test(line)) && block === blocks.at(-1) && line === lines.at(-1)) {
        // A streaming heading replaces the previous status only when its closing marker arrives.
        continue;
      } else {
        if (line.trim()) headingsOnly = false;
        text += line;
      }
    }
  }
  flush();
  return { entries, headingCount, headingsOnly };
}

/** Treat mounted history and first-seen completed parts as baseline, even while another part is live. */
export function createSummaryArrivalTracker(initial: readonly ReasoningEntry[]) {
  const seen = new Set(initial.map(entry => entry.key));
  return {
    isNew(entries: readonly ReasoningEntry[], enabled: boolean) {
      const latest = entries.at(-1);
      return Boolean(enabled && latest?.state === 'streaming' && !seen.has(latest.key));
    },
    consume(entries: readonly ReasoningEntry[]) { for (const entry of entries) seen.add(entry.key); },
  };
}

export function analyzeReasoning(parts: readonly ReasoningUIPart[], live = false): { kind: ReasoningKind; entries: ReasoningEntry[] } {
  const nonempty = parts.flatMap((part, index) => part.text.trim() ? [{ part, index }] : []);
  const kinds = nonempty.map(({ part }) => declaredKind(part));
  const full = { kind: 'full' as const, entries: nonempty.map(({ part, index }) => ({ key: part.id ?? `reasoning-${index}`, text: part.text })) };
  if (kinds.includes('full')) return full;
  const summaries = nonempty.map(({ part, index }) => summaryEntries(part, index, live && part.state !== 'done'));
  const inferredSummary = summaries.every((summary) => summary.headingsOnly) && summaries.reduce((total, summary) => total + summary.headingCount, 0) >= 2;
  return kinds.includes('summary') || inferredSummary ? { kind: 'summary', entries: summaries.flatMap((result) => result.entries) } : full;
}
