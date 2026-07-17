// Model → price table for cost analytics. Macaron's jsonl transcripts do NOT
// carry a per-message costUSD (unlike some other Claude Code WebUIs), so we
// compute cost ourselves from token counts. Prices are USD per 1M tokens,
// standard (non-batch) tier, sourced from Anthropic's published pricing.
//
// Cache-write has a TTL-dependent rate (5m vs 1h ephemeral); cache-read is
// ~0.1x input. When the jsonl splits cache_creation into ephemeral_5m/1h we
// price each at its own rate and charge any unsplit remainder at the 5m rate
// (the conservative undercount ccusage-dashboard uses).

export type ModelRates = {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
};

// Ordered most-specific-substring-first: the first key contained in the
// lowercased model string wins, so legacy Opus 4.0/4.1 ($15/$75) must precede
// the generic `opus` (current $5/$25), and `3-5-haiku` must precede `haiku`.
const RATE_TABLE: Array<[string, ModelRates]> = [
  ['fable', { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1.0 }],
  ['opus-4.1', { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 }],
  ['opus-4-1', { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 }],
  ['opus-4.0', { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 }],
  ['opus-4-0', { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 }],
  ['opus-4-20250514', { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 }],
  ['opus', { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 }],
  ['sonnet', { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 }],
  ['3-5-haiku', { input: 0.8, output: 4, cacheWrite5m: 1.0, cacheWrite1h: 1.6, cacheRead: 0.08 }],
  ['haiku', { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 }],
];

// Sonnet-shaped fallback for unrecognised models (e.g. a custom provider).
// Flagged `known:false` upstream so the UI can mark the estimate as rough.
const DEFAULT_RATES: ModelRates = { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 };

export function rateFor(model: string | undefined | null): { rates: ModelRates; known: boolean } {
  const m = (model || '').toLowerCase();
  for (const [key, rates] of RATE_TABLE) {
    if (m.includes(key)) return { rates, known: true };
  }
  return { rates: DEFAULT_RATES, known: false };
}

export type UsageCounts = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  ephemeral5m: number;
  ephemeral1h: number;
};

export function costOf(u: UsageCounts, rates: ModelRates): number {
  const unsplitCreate = Math.max(0, u.cacheWrite - u.ephemeral5m - u.ephemeral1h);
  return (
    u.input * rates.input +
    u.output * rates.output +
    u.ephemeral5m * rates.cacheWrite5m +
    u.ephemeral1h * rates.cacheWrite1h +
    unsplitCreate * rates.cacheWrite5m +
    u.cacheRead * rates.cacheRead
  ) / 1_000_000;
}
