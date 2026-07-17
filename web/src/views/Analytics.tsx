import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, fmtAgo, type AnalyticsResponse, type UsageBySession } from '../lib/api';
import { availableWeeks, buildHeatmap, isDay, intensityFor, navCells, navTarget } from '../lib/heatmap';

const WINDOWS: Array<{ id: string; label: string }> = [
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: '90d', label: '90d' },
  { id: 'all', label: 'All' },
];

const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const compact = (n: number) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const int = (n: number) => n.toLocaleString('en-US');
const shortModel = (m: string) => m.replace(/^claude-/, '') || 'unknown';

type SortKey = keyof Pick<
  UsageBySession,
  'preview' | 'model' | 'messageCount' | 'inputTokens' | 'outputTokens' | 'cacheWriteTokens' | 'cacheReadTokens' | 'costUsd' | 'lastActivity'
>;

const SESSION_CAP = 100;

// GitHub-style contribution grid: equal fixed-size squares, one per day
// (columns = weeks, rows = weekday), shaded by that day's message count. Layout
// is driven by the container's measured width — we render only as many whole
// week-columns as fit at the fixed cell+gap size, showing the most-recent days,
// so squares never stretch and no half-column is ever clipped or scrolled. The
// bucketing and keyboard-nav math live in ../lib/heatmap (pure + unit-tested).
const CELL = 13; // px — square side; matches the reference figure's dense grid
const GAP = 4;

export function UsageHeatmap({ daily, sinceDate, untilDate, window }: { daily: AnalyticsResponse['daily']; sinceDate: string; untilDate: string; window: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // `active` drives the caption (hover OR focus). `rovingKey` is the single
  // tabbable cell — updated only by keyboard focus, never hover, so the mouse
  // can't steal the roving tab stop. `focusedRef` remembers the focused cell so
  // a mouseleave restores its caption instead of blanking it.
  const [active, setActive] = useState<{ key: string; count: number } | null>(null);
  const [rovingKey, setRovingKey] = useState<string | null>(null);
  const focusedRef = useRef<{ key: string; count: number } | null>(null);
  // How many whole columns the container currently fits. Measured before paint
  // (useLayoutEffect) so a long history never flashes its full width for a frame
  // before clamping — the first visible paint already has the fitted count.
  const [fitWeeks, setFitWeeks] = useState(0);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      // n columns take n*CELL + (n-1)*GAP; solve for the largest n that fits.
      setFitWeeks(Math.max(1, Math.floor((w + GAP) / (CELL + GAP))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const maxWeeks = useMemo(() => availableWeeks(daily, sinceDate, untilDate, window), [daily, sinceDate, untilDate, window]);
  // Always fill the container: render as many whole columns as fit, even when
  // the window's own span is shorter — buildHeatmap pads the pre-window columns
  // with inert L0 squares so a short history never leaves the panel half-blank.
  // Fall back to the window span only before the first measurement lands.
  const weeks = fitWeeks || maxWeeks;
  // For 'all', clamp the window's low bound to the first active day (sinceDate is
  // epoch), so buildHeatmap clips leading padding to real in-window days only.
  const effectiveSince = window === 'all' ? (daily.length ? daily[0]!.date : untilDate) : sinceDate;
  const grid = useMemo(() => buildHeatmap(daily, effectiveSince, untilDate, weeks), [daily, effectiveSince, untilDate, weeks]);

  // A day's shade = its rank-based intensity in the window's distribution, mapped
  // to the accent at that fraction. Continuous, so the scale auto-adapts to the
  // selected window instead of snapping to fixed bands — 0 stays background.
  const intensity = (count: number) => intensityFor(count, grid.ramp);

  // Keep keyboard state coherent across any resize (both directions). When the
  // visible columns change, the roving key, the real DOM focus, and the caption
  // must all still point at the SAME visible day. Because cells are keyed by
  // date, a focused day that scrolls out of range unmounts and the browser drops
  // focus to <body> — so we drive re-focus from focusedRef (remembered on focus),
  // not from document.activeElement, which is already gone by the time this runs.
  useLayoutEffect(() => {
    const visibleKeys = grid.weeks.flat().filter(isDay).map((c) => c.key);
    const visible = new Set(visibleKeys);
    const firstVisible = visibleKeys[0] ?? null;
    const wasFocused = focusedRef.current;
    // The focused day fell off the visible set → move real focus to the nearest
    // still-visible day, and let its onFocus resync rovingKey + caption.
    if (wasFocused && !visible.has(wasFocused.key) && firstVisible) {
      gridRef.current?.querySelector<HTMLElement>(`.heatmap-cell[data-key="${firstVisible}"]`)?.focus();
      return; // onFocus handles rovingKey/active; nothing left to reconcile
    }
    // No live focus, but the roving tab stop pointed at a now-hidden day → retarget
    // it so Tab still lands on a visible cell.
    if (rovingKey && !visible.has(rovingKey)) setRovingKey(firstVisible);
    // A caption must never outlive its day. When the captioned day scrolls out of
    // the visible set and nothing is focused to re-emit it (e.g. focus was already
    // dropped onto the All pill before the resize), clear it — otherwise the detail
    // line keeps naming a date the grid no longer shows.
    if (active && !visible.has(active.key) && !focusedRef.current) setActive(null);
  }, [grid]);

  // Roving tabindex over a row-major (weekday × week) cell space. All target
  // resolution (arrows stay put at an edge; Home/End walk the weekday row;
  // Ctrl/⌘+Home/End pick the earliest/latest day by date key, not DOM order)
  // lives in navTarget; here we only translate the resolved key back to focus.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const cells = navCells(grid);
    const fromKey = (document.activeElement as HTMLElement)?.dataset.key ?? '';
    const targetKey = navTarget(cells, fromKey, e.key, e.ctrlKey || e.metaKey);
    if (targetKey) gridRef.current?.querySelector<HTMLElement>(`.heatmap-cell[data-key="${targetKey}"]`)?.focus();
  };

  const captionText = active ? `${active.key} · ${active.count} message${active.count === 1 ? '' : 's'}` : 'Hover or focus a day for details';

  // The tabbable cell: the keyboard-visited one, else the first in-range day.
  const firstKey = grid.weeks.flat().find(isDay)?.key ?? null;
  const tabKey = rovingKey ?? firstKey;

  return (
    <div className="heatmap" ref={wrapRef} style={{ '--cell': `${CELL}px`, '--gap': `${GAP}px`, '--weeks': grid.weeks.length } as React.CSSProperties}>
      <div
        className="heatmap-grid"
        role="grid"
        aria-label="Daily message activity"
        aria-rowcount={7}
        aria-colcount={grid.weeks.length}
        ref={gridRef}
        onKeyDown={onKeyDown}
        onMouseLeave={() => setActive(focusedRef.current)}
      >
        {/* Row-major for ARIA: one role=row per weekday, cells placed into the
            shared column track by grid-column-start so they still read as weeks.
            Real cells are keyed by their stable date, NOT column index: on a
            resize the visible columns shift, and a positional key would let React
            reuse the focused DOM node for a different date (activeElement's
            data-key would silently change). A date key ties each node to one day,
            so the reconcile effect below can move real focus deterministically. */}
        {[0, 1, 2, 3, 4, 5, 6].map((r) => (
          <div key={r} className="heatmap-row" role="row" aria-rowindex={r + 1}>
            {grid.weeks.map((week, wi) => {
              const cell = week[r];
              if (isDay(cell)) return (
                <div
                  key={cell.key}
                  className="heatmap-cell"
                  style={{ gridColumnStart: wi + 1, '--hm-i': intensity(cell.count) } as React.CSSProperties}
                  data-active={cell.count > 0 ? 1 : 0}
                  data-key={cell.key}
                  data-row={r}
                  data-col={wi}
                  role="gridcell"
                  aria-colindex={wi + 1}
                  tabIndex={cell.key === tabKey ? 0 : -1}
                  aria-label={`${cell.key}: ${cell.count} message${cell.count === 1 ? '' : 's'}`}
                  onMouseEnter={() => setActive({ key: cell.key, count: cell.count })}
                  onFocus={() => { const a = { key: cell.key, count: cell.count }; focusedRef.current = a; setActive(a); setRovingKey(cell.key); }}
                  onBlur={() => { focusedRef.current = null; }}
                />
              );
              // Pre-window pad → a visible-but-inert background square (fills the
              // column, never focuses, never enters the ARIA date range). Future
              // day → a hidden slot that only reserves grid space.
              if (cell) return <div key={`pad-${r}-${wi}`} className="heatmap-cell" style={{ gridColumnStart: wi + 1 }} data-active={0} role="presentation" aria-hidden="true" />;
              return <div key={`empty-${r}-${wi}`} className="heatmap-cell heatmap-cell--empty" style={{ gridColumnStart: wi + 1 }} role="presentation" aria-hidden="true" />;
            })}
          </div>
        ))}
      </div>
      <div className="heatmap-footer">
        <div className="heatmap-detail" aria-live="polite">{captionText}</div>
        <div className="heatmap-legend">
          <span>Less</span>
          <div className="heatmap-cell" data-active={0} aria-hidden="true" />
          {[0.25, 0.5, 0.75, 1].map((i) => <div key={i} className="heatmap-cell" data-active={1} style={{ '--hm-i': i } as React.CSSProperties} aria-hidden="true" />)}
          <span>More</span>
        </div>
      </div>
    </div>
  );
}

export function Analytics() {
  const [window, setWindow] = useState('30d');
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'costUsd', dir: 'desc' });

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    setData(null);
    api
      .analytics(window)
      .then((d) => { if (live) { setData(d); setLoading(false); } })
      .catch((e) => { if (live) { setError((e as Error).message); setLoading(false); } });
    return () => { live = false; };
  }, [window]);

  const totals = data?.totals;
  const cacheHit = totals
    ? totals.cacheReadTokens / Math.max(1, totals.inputTokens + totals.cacheWriteTokens + totals.cacheReadTokens)
    : 0;

  const dailyChart = useMemo(
    () => (data?.daily ?? []).map((d) => ({ ...d, label: d.date.slice(5) })),
    [data],
  );
  const modelChart = useMemo(
    () => (data?.byModel ?? []).map((m) => ({ ...m, label: shortModel(m.model) })),
    [data],
  );

  const sortedSessions = useMemo(() => {
    const rows = [...(data?.bySession ?? [])];
    const { key, dir } = sort;
    const mul = dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * mul;
      return ((av as number) - (bv as number)) * mul;
    });
    return rows;
  }, [data, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <section className="view">
      <header>
        <h1>Usage & Cost</h1>
        <p>Token usage, spend, and burn rate across your Claude Code sessions. Cost is estimated from public model rates — transcripts don't record a price.</p>
      </header>

      <div className="usage-pills">
        {WINDOWS.map((w) => (
          <button
            key={w.id}
            className={'usage-pill' + (window === w.id ? ' active' : '')}
            onClick={() => setWindow(w.id)}
          >
            {w.label}
          </button>
        ))}
      </div>

      {error && <div className="placeholder">Error: {error}</div>}
      {loading && !data && <div className="muted">Loading…</div>}

      {totals && (
        <>
          <div className="usage-tiles">
            <div className="stat-tile">
              <div className="stat-label">Total cost</div>
              <div className="stat-value">{usd(totals.costUsd)}</div>
              <div className="stat-sub">{int(totals.messageCount)} messages</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">Total tokens</div>
              <div className="stat-value">{compact(totals.inputTokens + totals.outputTokens + totals.cacheWriteTokens + totals.cacheReadTokens)}</div>
              <div className="stat-sub">{compact(totals.inputTokens)} in · {compact(totals.outputTokens)} out</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">Cache hit</div>
              <div className="stat-value">{(cacheHit * 100).toFixed(1)}%</div>
              <div className="stat-sub">{compact(totals.cacheReadTokens)} read · {compact(totals.cacheWriteTokens)} write</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">Sessions</div>
              <div className="stat-value">{int(totals.sessionCount)}</div>
              <div className="stat-sub">{dailyChart.length} active day{dailyChart.length === 1 ? '' : 's'}</div>
            </div>
          </div>

          <div className="usage-panel">
            <h2 className="sec-title">Activity</h2>
            {dailyChart.length === 0 ? (
              <p className="muted">No activity in this window.</p>
            ) : (
              <UsageHeatmap daily={data.daily} sinceDate={data.sinceDate} untilDate={data.untilDate} window={window} />
            )}
          </div>

          <div className="usage-panel">
            <h2 className="sec-title">Daily spend</h2>
            {dailyChart.length === 0 ? (
              <p className="muted">No activity in this window.</p>
            ) : (
              <div className="usage-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={dailyChart} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="costFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--muted)' }} tickLine={false} axisLine={{ stroke: 'var(--border)' }} minTickGap={24} />
                    <YAxis tickFormatter={(v) => usd0(Number(v))} tick={{ fontSize: 11, fill: 'var(--muted)' }} tickLine={false} axisLine={false} width={54} />
                    <Tooltip
                      formatter={(v) => [usd(Number(v)), 'Cost']}
                      labelFormatter={(l) => `Date ${l}`}
                      contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border-strong)', borderRadius: 8, fontSize: 12 }}
                    />
                    <Area type="monotone" dataKey="costUsd" stroke="var(--accent)" strokeWidth={2} fill="url(#costFill)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div className="usage-panel">
            <h2 className="sec-title">Cost by model</h2>
            {modelChart.length === 0 ? (
              <p className="muted">No activity in this window.</p>
            ) : (
              <div className="usage-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={modelChart} layout="vertical" margin={{ top: 4, right: 12, bottom: 0, left: 8 }}>
                    <CartesianGrid stroke="var(--border)" horizontal={false} />
                    <XAxis type="number" tickFormatter={(v) => usd0(Number(v))} tick={{ fontSize: 11, fill: 'var(--muted)' }} tickLine={false} axisLine={{ stroke: 'var(--border)' }} />
                    <YAxis type="category" dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-2)' }} tickLine={false} axisLine={false} width={130} />
                    <Tooltip
                      formatter={(v) => [usd(Number(v)), 'Cost']}
                      cursor={{ fill: 'var(--accent-soft)' }}
                      contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border-strong)', borderRadius: 8, fontSize: 12 }}
                    />
                    <Bar dataKey="costUsd" fill="var(--accent)" radius={[0, 4, 4, 0]} maxBarSize={26} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            {modelChart.some((m) => !m.known) && (
              <p className="usage-note">Models marked <span className="usage-est">~est</span> didn't match the rate table and use a default Sonnet-class estimate.</p>
            )}
          </div>

          <div className="usage-panel">
            <h2 className="sec-title">Sessions</h2>
            {sortedSessions.length === 0 ? (
              <p className="muted">No sessions in this window.</p>
            ) : (
              <div className="usage-table-wrap">
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th className="ut-left" onClick={() => toggleSort('preview')}>Session{arrow('preview')}</th>
                      <th className="ut-left" onClick={() => toggleSort('model')}>Model{arrow('model')}</th>
                      <th onClick={() => toggleSort('messageCount')}>Msgs{arrow('messageCount')}</th>
                      <th onClick={() => toggleSort('inputTokens')}>Input{arrow('inputTokens')}</th>
                      <th onClick={() => toggleSort('outputTokens')}>Output{arrow('outputTokens')}</th>
                      <th onClick={() => toggleSort('cacheReadTokens')}>Cache R{arrow('cacheReadTokens')}</th>
                      <th onClick={() => toggleSort('cacheWriteTokens')}>Cache W{arrow('cacheWriteTokens')}</th>
                      <th onClick={() => toggleSort('costUsd')}>Cost{arrow('costUsd')}</th>
                      <th onClick={() => toggleSort('lastActivity')}>Last{arrow('lastActivity')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedSessions.slice(0, SESSION_CAP).map((s) => (
                      <tr key={`${s.project}/${s.sessionId}`}>
                        <td className="ut-left ut-preview" title={s.preview || s.sessionId}>{s.preview || s.sessionId.slice(0, 8)}</td>
                        <td className="ut-left ut-mono">{shortModel(s.model)}</td>
                        <td>{int(s.messageCount)}</td>
                        <td>{compact(s.inputTokens)}</td>
                        <td>{compact(s.outputTokens)}</td>
                        <td>{compact(s.cacheReadTokens)}</td>
                        <td>{compact(s.cacheWriteTokens)}</td>
                        <td className="ut-cost">{usd(s.costUsd)}</td>
                        <td className="ut-ago">{fmtAgo(s.lastActivity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {sortedSessions.length > SESSION_CAP && (
                  <p className="usage-note">Showing top {SESSION_CAP} of {int(sortedSessions.length)} sessions.</p>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
