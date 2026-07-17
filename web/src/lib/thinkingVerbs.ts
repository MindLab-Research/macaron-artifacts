// Everything here is byte-identical to what the shipped `claude` CLI binary
// does — extracted from /opt/homebrew/Caskroom/claude-code/2.1.149/claude.
// See the offsets referenced in comments if you need to re-verify.

// ---------- verb list (Eh8 @ ~199104054) --------------------------------
// Random-picked once per turn and shown as "{Verb}…" next to the spinner.
export const THINKING_VERBS: readonly string[] = [
  'Accomplishing', 'Actioning', 'Actualizing', 'Architecting', 'Baking', 'Beaming',
  "Beboppin'", 'Befuddling', 'Billowing', 'Blanching', 'Bloviating', 'Boogieing',
  'Boondoggling', 'Booping', 'Bootstrapping', 'Brewing', 'Bunning', 'Burrowing',
  'Calculating', 'Canoodling', 'Caramelizing', 'Cascading', 'Catapulting',
  'Cerebrating', 'Channeling', 'Channelling', 'Choreographing', 'Churning',
  'Clauding', 'Coalescing', 'Cogitating', 'Combobulating', 'Composing', 'Computing',
  'Concocting', 'Considering', 'Contemplating', 'Cooking', 'Crafting', 'Creating',
  'Crunching', 'Crystallizing', 'Cultivating', 'Deciphering', 'Deliberating',
  'Determining', 'Dilly-dallying', 'Discombobulating', 'Doing', 'Doodling',
  'Drizzling', 'Ebbing', 'Effecting', 'Elucidating', 'Embellishing', 'Enchanting',
  'Envisioning', 'Evaporating', 'Fermenting', 'Fiddle-faddling', 'Finagling',
  'Flambéing', 'Flibbertigibbeting', 'Flowing', 'Flummoxing', 'Fluttering',
  'Forging', 'Forming', 'Frolicking', 'Frosting', 'Gallivanting', 'Galloping',
  'Garnishing', 'Generating', 'Gesticulating', 'Germinating', 'Gitifying',
  'Grooving', 'Gusting', 'Harmonizing', 'Hashing', 'Hatching', 'Herding', 'Honking',
  'Hullaballooing', 'Hyperspacing', 'Ideating', 'Imagining', 'Improvising',
  'Incubating', 'Inferring', 'Infusing', 'Ionizing', 'Jitterbugging', 'Julienning',
  'Kneading', 'Leavening', 'Levitating', 'Lollygagging', 'Manifesting',
  'Marinating', 'Meandering', 'Metamorphosing', 'Misting', 'Moonwalking',
  'Moseying', 'Mulling', 'Mustering', 'Musing', 'Nebulizing', 'Nesting',
  'Newspapering', 'Noodling', 'Nucleating', 'Orbiting', 'Orchestrating', 'Osmosing',
  'Perambulating', 'Percolating', 'Perusing', 'Philosophising', 'Photosynthesizing',
  'Pollinating', 'Pondering', 'Pontificating', 'Pouncing', 'Precipitating',
  'Prestidigitating', 'Processing', 'Proofing', 'Propagating', 'Puttering',
  'Puzzling', 'Quantumizing', 'Razzle-dazzling', 'Razzmatazzing', 'Recombobulating',
  'Reticulating', 'Roosting', 'Ruminating', 'Sautéing', 'Scampering', 'Schlepping',
  'Scurrying', 'Seasoning', 'Shenaniganing', 'Shimmying', 'Simmering', 'Skedaddling',
  'Sketching', 'Slithering', 'Smooshing', 'Sock-hopping', 'Spelunking', 'Spinning',
  'Sprouting', 'Stewing', 'Sublimating', 'Swirling', 'Swooping', 'Symbioting',
  'Synthesizing', 'Tempering', 'Thinking', 'Thundering', 'Tinkering', 'Tomfoolering',
  'Topsy-turvying', 'Transfiguring', 'Transmuting', 'Twisting', 'Undulating',
  'Unfurling', 'Unravelling', 'Vibing', 'Waddling', 'Wandering', 'Warping',
  'Whatchamacalliting', 'Whirlpooling', 'Whirring', 'Whisking', 'Wibbling',
  'Working', 'Wrangling', 'Zesting', 'Zigzagging',
];

// ---------- spinner frames (YwH @ ~195230413) ---------------------------
// The base frame array; XQ7 = [...frames, ...[...frames].reverse()] gives the
// full 12-frame twinkle cycle. Steps every 120ms.
const SPINNER_BASE = ['·', '✢', '✳', '✶', '✻', '✽'] as const;
export const SPINNER_FRAMES: readonly string[] = [
  ...SPINNER_BASE,
  ...[...SPINNER_BASE].reverse(),
];
export const SPINNER_INTERVAL_MS = 120;

// ---------- thinking-status tail (_13 @ ~199124687) ---------------------
// Thresholds inlined from the CLI binary (s43=10000, t43=20000, e43=30000,
// H13=45000). Returns null below 10s to match `pH = null` on `case "none"`.
export function thinkingTail(thinkingMs: number): string | null {
  if (thinkingMs >= 45000) return 'almost done thinking';
  if (thinkingMs >= 30000) return 'thinking some more';
  if (thinkingMs >= 20000) return 'thinking more';
  if (thinkingMs >= 10000) return 'still thinking';
  return null;
}

// ---------- duration formatter (H7 @ ~191457628) -----------------------
// 0 → "0s", <1s → "0.5s", <60s → "5s", <1h → "5m 30s", <1d → "1h 5m 30s", ...
export function formatDuration(ms: number): string {
  if (ms < 60000) {
    if (ms === 0) return '0s';
    if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 1000)}s`;
  }
  const d = Math.floor(ms / 86_400_000);
  let h = Math.floor((ms % 86_400_000) / 3_600_000);
  let m = Math.floor((ms % 3_600_000) / 60_000);
  let s = Math.round((ms % 60_000) / 1000);
  if (s === 60) { s = 0; m++; }
  if (m === 60) { m = 0; h++; }
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

// ---------- animated counter (matches responseLength easing) ------------
// The CLI eases the *response-length* ref at 50ms cadence with steps 3/8-30/50
// (calibrated for chars). Our display counter is in TOKENS (~4x smaller), so
// we shrink the step schedule by ~4x. The staircase feel matches the CLI's.
export function easeTowards(current: number, target: number): number {
  const gap = target - current;
  if (gap <= 0) return current;
  let step: number;
  if (gap < 18) step = 1;
  else if (gap < 50) step = Math.max(2, Math.ceil(gap * 0.15));
  else step = 12;
  return Math.min(current + step, target);
}
