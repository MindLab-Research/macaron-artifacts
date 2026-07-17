// Always-visible rate-limit meters for the sidebar footer. Two labeled bars
// (5-hour + weekly subscription windows) with a reset countdown, fed by
// /api/usage which reads the ambient Claude OAuth login. Renders nothing when
// usage is unavailable (custom-provider users, no login, or endpoint down),
// so it costs zero layout in those cases.

import { useEffect, useState } from 'react';
import { api, type UsageResponse, type RateLimitWindow } from '../lib/api';

function formatReset(iso: string | null): string | null {
  if (!iso) return null;
  const diffMs = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return null;
  const totalMin = Math.ceil(diffMs / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

function Meter({ label, tone, win }: { label: string; tone: 'usage' | 'weekly'; win: RateLimitWindow }) {
  const pct = Math.max(0, Math.min(100, win.utilization));
  const reset = formatReset(win.resetsAt);
  const level = pct >= 80 ? 'bad' : pct >= 50 ? 'warn' : 'good';
  return (
    <div className="rl-meter" title={`${label} usage · ${pct}%${reset ? ` · resets in ${reset}` : ''}`}>
      <span className="rl-meter-label">{label}</span>
      <div className={`status-bar-track tone-${tone}`}>
        <div className="status-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className={`rl-meter-pct rl-${level}`}>{pct}%</span>
      {reset && <span className="rl-meter-reset">{reset}</span>}
    </div>
  );
}

export function RateLimitMeters() {
  const [usage, setUsage] = useState<UsageResponse | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => api.usage().then((u) => { if (alive) setUsage(u); }).catch(() => { if (alive) setUsage(null); });
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!usage?.available) return null;
  const { fiveHour, sevenDay } = usage;
  if (!fiveHour && !sevenDay) return null;

  return (
    <div className="rl-meters">
      {fiveHour && <Meter label="5h" tone="usage" win={fiveHour} />}
      {sevenDay && <Meter label="wk" tone="weekly" win={sevenDay} />}
    </div>
  );
}
