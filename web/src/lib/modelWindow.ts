// Rough model → context-window (token) map for the Context bar.
// We can't reliably ping every custom provider for its window size, so we
// infer from the model string. Unknown models fall back to 200k (Sonnet
// default), which is honest-if-vague until the user picks a known model.

const TIERS = [128_000, 200_000, 1_000_000, 2_000_000];

export function inferModelWindow(model: string | undefined | null): number {
  if (!model) return 200_000;
  const m = model.toLowerCase();
  if (m.includes('1m') || m.includes('1000k')) return 1_000_000;
  if (m.includes('opus')) return 200_000;
  if (m.includes('sonnet')) return 200_000;
  if (m.includes('haiku')) return 200_000;
  if (m.includes('gpt-5') || m.includes('gpt-4.1')) return 1_000_000;
  if (m.includes('gpt-4o')) return 128_000;
  if (m.includes('gpt-4')) return 128_000;
  if (m.includes('gemini') && m.includes('pro')) return 2_000_000;
  if (m.includes('gemini')) return 1_000_000;
  if (m.startsWith('glm') || m.includes('glm')) return 128_000;
  if (m.includes('qwen')) return 128_000;
  if (m.includes('deepseek')) return 128_000;
  return 200_000;
}

// If observed usage exceeds the inferred window, the model is probably
// running in an extended-context beta (e.g. Opus 4.7 defaults to 200k but
// commonly runs in the 1M-context beta). Escalate to the smallest known
// tier that still contains the observed usage so the bar reads correctly.
export function effectiveWindow(model: string | undefined | null, usedTokens: number): number {
  const base = inferModelWindow(model);
  if (usedTokens <= base) return base;
  for (const tier of TIERS) {
    if (tier >= base && tier >= usedTokens) return tier;
  }
  return Math.max(base, Math.ceil(usedTokens * 1.1));
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
