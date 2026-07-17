import assert from 'node:assert/strict';
import { test } from 'node:test';
import { availableWeeks, buildHeatmap, isDay, intensityFor, navCells, navTarget, rampOf, utcToDay, dayToUTC, DAY } from '../src/lib/heatmap';

// Helper: synthesize a `daily` payload spanning [since, until] with 1 msg/day.
function fill(since: string, until: string) {
  const out: Array<{ date: string; messageCount: number }> = [];
  for (let ms = dayToUTC(since); ms <= dayToUTC(until); ms += DAY) out.push({ date: utcToDay(ms), messageCount: 1 });
  return out;
}

test('intensityFor maps a count to its rank in the window distribution (0 → background)', () => {
  const ramp = rampOf([10, 20, 30, 40]); // 4 distinct
  assert.equal(intensityFor(0, ramp), 0);  // no activity → background, never a tint
  assert.equal(intensityFor(10, ramp), 0.25); // lowest active day → lightest tint (not 0)
  assert.equal(intensityFor(20, ramp), 0.5);
  assert.equal(intensityFor(30, ramp), 0.75);
  assert.equal(intensityFor(40, ramp), 1);  // busiest day → full accent
  assert.equal(intensityFor(15, ramp), 0.25); // between distinct values ranks by how many are <=
});

test('intensity spreads an outlier-skewed window across the full light→dark band', () => {
  // 29 modest days + 1 huge spike. A linear-by-max scale would crush all 29 into
  // the lightest sliver; rank-based intensity gives every distinct day its own
  // shade, evenly spaced across (0,1].
  const active = [...Array(29)].map((_, i) => (i + 1) * 10).concat([100000]);
  const ramp = rampOf(active);
  const vals = active.map((c) => intensityFor(c, ramp)).sort((a, b) => a - b);
  assert.ok(vals[0]! <= 1 / 30 + 1e-9 && vals[0]! > 0, 'lightest active day is a small but non-zero intensity');
  assert.equal(vals.at(-1), 1, 'the spike is full accent');
  // 30 distinct values → 30 distinct intensities, none collapsed together.
  assert.equal(new Set(vals).size, 30, 'every distinct day gets its own shade');
});

test('intensityFor handles degenerate distributions without throwing', () => {
  assert.equal(intensityFor(5, rampOf([])), 0); // no active days → nothing to rank against
  assert.equal(intensityFor(7, rampOf([7])), 1); // a lone active day is the max → full accent
  const allEqual = rampOf([5, 5, 5, 5, 5]);
  assert.deepEqual(allEqual, [5], 'identical days collapse to one distinct rung');
  assert.equal(intensityFor(5, allEqual), 1); // all identical → all the same (top) shade
});

test('the busiest day always reaches full intensity at small sample sizes (4 and 8 distinct values)', () => {
  for (const active of [[1, 2, 3, 4], [1, 2, 3, 4, 5, 6, 7, 8]]) {
    const ramp = rampOf(active);
    const max = active[active.length - 1]!;
    assert.equal(intensityFor(max, ramp), 1, `n=${active.length}: max ${max} must be full accent`);
    assert.ok(intensityFor(active[0]!, ramp) > 0, `n=${active.length}: min is a visible non-zero tint`);
    // Every distinct value gets a distinct, evenly-spaced intensity.
    const shades = active.map((c) => intensityFor(c, ramp));
    assert.equal(new Set(shades).size, active.length, `n=${active.length}: all shades distinct`);
  }
});

test('the ramp is a property of the whole window — cropping columns never re-shades', () => {
  // Same daily payload, same window, different rendered width. buildHeatmap must
  // return an identical ramp regardless of how many columns fit, so a resize
  // only crops the grid — it never recolors the days that stay visible.
  const daily = fill('2026-01-01', '2026-07-14').map((d, i) => ({ ...d, messageCount: (i % 40) + 1 }));
  const wide = buildHeatmap(daily, '2026-01-01', '2026-07-14', 40);
  const narrow = buildHeatmap(daily, '2026-01-01', '2026-07-14', 6);
  assert.deepEqual(narrow.ramp, wide.ramp, 'ramp identical across widths');
  // And a day visible in BOTH widths keeps the same shade intensity.
  const sharedKey = narrow.weeks.flat().filter(isDay).at(-1)!.key;
  const inWide = wide.weeks.flat().filter(isDay).find((c) => c.key === sharedKey)!;
  const inNarrow = narrow.weeks.flat().filter(isDay).find((c) => c.key === sharedKey)!;
  assert.equal(intensityFor(inWide.count, wide.ramp), intensityFor(inNarrow.count, narrow.ramp), 'shared day keeps its shade');
});

test('buildHeatmap renders exactly the requested whole columns, no stretch', () => {
  const daily = fill('2024-01-01', '2026-07-14');
  const grid = buildHeatmap(daily, '2024-01-01', '2026-07-14', 20);
  assert.equal(grid.weeks.length, 20, 'exactly 20 columns');
  for (const week of grid.weeks) assert.equal(week.length, 7, 'every column has 7 weekday rows');
});

test('buildHeatmap shows the MOST-RECENT days when fewer columns than history fit', () => {
  const daily = fill('2024-01-01', '2026-07-14');
  const grid = buildHeatmap(daily, '2024-01-01', '2026-07-14', 4); // only 4 weeks fit
  const firstRealKey = grid.weeks.flat().filter(isDay).map((c) => c.key).sort()[0];
  // 4 columns back from the week of 2026-07-14 (Tue) → grid starts 2026-06-21 (Sun).
  assert.equal(firstRealKey, '2026-06-21');
});

test('buildHeatmap keeps real day keys inside the window; pads before, hides after', () => {
  // untilDate is a Tuesday; the last column's Wed–Sat are AFTER the window → null
  // hidden slots. The first column's days before sinceDate are BEFORE it → visible
  // inert pad squares (fill the column, no date key), never real day cells.
  const daily = fill('2026-07-01', '2026-07-14');
  const grid = buildHeatmap(daily, '2026-07-01', '2026-07-14', 4);
  const keys = grid.weeks.flat().filter(isDay).map((c) => c.key).sort();
  assert.equal(keys[0], '2026-07-01', 'no real day before sinceDate');
  assert.equal(keys.at(-1), '2026-07-14', 'no real day after untilDate');
  // First column (week 2026-06-21..27) is entirely before the window → all pads.
  const firstCol = grid.weeks[0]!;
  assert.deepEqual(firstCol.map((c) => (isDay(c) ? c.key : c && 'pad' in c ? 'pad' : null)), ['pad', 'pad', 'pad', 'pad', 'pad', 'pad', 'pad']);
  // The window opens mid-column: Wed 2026-07-01 is the first real day, preceded
  // by pads for Sun–Tue in that same column.
  const openCol = grid.weeks.find((w) => w.some((c) => isDay(c) && c.key === '2026-07-01'))!;
  assert.deepEqual(openCol.map((c) => (isDay(c) ? c.key : c && 'pad' in c ? 'pad' : null)), ['pad', 'pad', 'pad', '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04']);
  // Last column (week of untilDate, Sun 2026-07-12) keeps Sun/Mon/Tue, hides Wed+.
  const lastCol = grid.weeks.at(-1)!;
  assert.deepEqual(lastCol.map((c) => (isDay(c) ? c.key : null)), ['2026-07-12', '2026-07-13', '2026-07-14', null, null, null, null]);
});

test('buildHeatmap fills the full requested width with inert pads when history is short', () => {
  // A 2-week window rendered into a 12-column container: every column exists (no
  // half-empty grid), the earlier columns are inert pad squares, and the real
  // days still match the server window exactly — pads never become date cells.
  const daily = fill('2026-07-01', '2026-07-14');
  const grid = buildHeatmap(daily, '2026-07-01', '2026-07-14', 12);
  assert.equal(grid.weeks.length, 12, 'renders all 12 requested columns');
  const realKeys = grid.weeks.flat().filter(isDay).map((c) => c.key).sort();
  assert.equal(realKeys[0], '2026-07-01', 'earliest real day is still sinceDate');
  assert.equal(realKeys.at(-1), '2026-07-14', 'latest real day is still untilDate');
  // The leading columns are entirely pad squares (no real day leaks earlier).
  const pads = grid.weeks.flat().filter((c) => c && !isDay(c)).length;
  assert.ok(pads > 0, 'pre-window columns are filled with inert pad squares');
  // navCells (the ARIA/keyboard model) sees only real days, never pads.
  assert.equal(navCells(grid).length, realKeys.length, 'pads never enter the nav/ARIA set');
});

test('first-frame long history clamps to fitted columns (no full-width overflow)', () => {
  // Whatever column count the layout fits, buildHeatmap returns exactly that many
  // — a 135-week history asked for 52 columns yields 52, not 135, so the very
  // first paint is already the fitted width.
  const daily = fill('2024-01-01', '2026-07-14');
  assert.equal(buildHeatmap(daily, '2024-01-01', '2026-07-14', 52).weeks.length, 52);
});

test('availableWeeks caps the column count to the window span', () => {
  const daily = fill('2026-06-15', '2026-07-14');
  assert.equal(availableWeeks(daily, '2026-06-15', '2026-07-14', '30d'), 5);
  const long = fill('2026-01-01', '2026-07-14');
  assert.ok(availableWeeks(long, '1970-01-01', '2026-07-14', 'all') >= 27);
});

test('navTarget global/boundary uses date keys not DOM order', () => {
  const daily = fill('2026-07-01', '2026-07-31');
  const grid = buildHeatmap(daily, '2026-07-01', '2026-07-31', 6);
  const cells = navCells(grid);
  assert.equal(navTarget(cells, cells[3]!.key, 'Home', true), cells.map((c) => c.key).sort()[0], 'Ctrl+Home → earliest date');
  assert.equal(navTarget(cells, cells[3]!.key, 'End', true), '2026-07-31', 'Ctrl+End → latest date');
});

test('navTarget arrows stay put at an edge', () => {
  const daily = fill('2026-07-01', '2026-07-31');
  const grid = buildHeatmap(daily, '2026-07-01', '2026-07-31', 6);
  const cells = navCells(grid);
  const earliest = cells.reduce((a, b) => (a.key < b.key ? a : b));
  assert.equal(navTarget(cells, earliest.key, 'ArrowLeft', false), null);
});

test('narrow resize drops leftmost columns — earlier keys leave the visible set', () => {
  // Simulates a wide→narrow resize: same data, fewer fitted columns. The keys
  // visible when narrow must be a strict suffix (most-recent) of the wide set,
  // so the component knows which roving/focus keys fell off the left edge.
  const daily = fill('2024-01-01', '2026-07-14');
  const wide = new Set(navCells(buildHeatmap(daily, '2024-01-01', '2026-07-14', 40)).map((c) => c.key));
  const narrow = navCells(buildHeatmap(daily, '2024-01-01', '2026-07-14', 8)).map((c) => c.key);
  assert.ok(narrow.every((k) => wide.has(k)), 'narrow keys are a subset of wide');
  assert.ok(wide.size > narrow.length, 'wide shows strictly more days than narrow');
});

// --- Colour ramp: mirrors the continuous .heatmap-cell[data-active='1'] formula
// in styles.css (accent% = 16 + i*84, light darken = i*16). Verifies the ramp
// is perceptually a light→dark gradient — low days genuinely light, each step
// distinguishable, and the busiest day dark enough to read against the panel —
// WITHOUT a flat contrast floor that would push low days dark. ---
type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const mix = (a: RGB, b: RGB, pa: number): RGB => a.map((v, i) => Math.round(v * pa + b[i]! * (1 - pa))) as RGB;
const relLum = ([r, g, b]: RGB) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a: RGB, b: RGB) => { const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
// The rendered fill at intensity i: color-mix(text (i*darkMax)%, color-mix(accent (16+i*84)%, surface2)).
const shadeAt = (t: { accent: string; surface2: string; text: string; darkMax: number }, i: number) =>
  mix(hex(t.text), mix(hex(t.accent), hex(t.surface2), 0.16 + i * 0.84), i * t.darkMax);

test('the continuous ramp reads light→dark and stays distinguishable in both themes', () => {
  const themes = {
    light: { accent: '#C96442', surface2: '#F5F4ED', text: '#3D3929', panel: '#FFFFFF', darkMax: 0.16 },
    dark: { accent: '#E08159', surface2: '#2C2B26', text: '#EDEAE0', panel: '#262521', darkMax: 0.0 },
  };
  const samples = [0.2, 0.4, 0.6, 0.8, 1.0];
  for (const [name, t] of Object.entries(themes)) {
    const panel = hex(t.panel);
    const lums = samples.map((i) => relLum(shadeAt(t, i)));
    // Strictly monotonic in ONE direction: light theme darkens toward the accent,
    // dark theme brightens toward it (accent is lighter than the charcoal panel).
    // Either way the ramp is a clean gradient with no fold-back.
    const rising = lums[lums.length - 1]! > lums[0]!;
    for (let k = 1; k < lums.length; k++) assert.ok(rising ? lums[k]! > lums[k - 1]! : lums[k]! < lums[k - 1]!, `${name}: monotonic step ${samples[k - 1]}→${samples[k]}`);
    // The lowest sampled day is a genuinely LIGHT tint (not already dark) — this
    // is the whole point: contrast against panel stays modest at the low end.
    assert.ok(ratio(shadeAt(t, 0.2), panel) <= 2.2, `${name}: low day stays light (ratio ${ratio(shadeAt(t, 0.2), panel).toFixed(2)} <= 2.2)`);
    // The busiest day is dark enough to read against the panel.
    assert.ok(ratio(shadeAt(t, 1.0), panel) >= 3, `${name}: peak day ${ratio(shadeAt(t, 1.0), panel).toFixed(2)} >= 3`);
    // Adjacent sampled shades differ enough to tell apart (luminance gap).
    for (let k = 1; k < lums.length; k++) assert.ok(Math.abs(lums[k]! - lums[k - 1]!) >= 0.02, `${name}: shades ${samples[k - 1]}/${samples[k]} distinguishable`);
  }
});
