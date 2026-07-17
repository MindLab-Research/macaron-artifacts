// CLI-style multiline status bar. Rows appear only when their data is
// present, so a fresh session collapses to just the identity + permission
// lines. Rendering density is deliberately tight; the terminal-footer feel
// is what claude-cli users expect.
//
// Layout:
//   Row 1: [Provider chip] | project              (identity, emphasized)
//   Row 2: Context ▓▓▓░░ 32% (64k / 200k)         (bar, colored)
//   Row 3: 1 CLAUDE.md | 2 MCPs                    (env counters)
//   Row 4: ✓ Bash ×N | ✓ Read ×N ...               (tool tally)
//   Row 5: ▸ current in-progress todo (X/N)        (task)
//   Row 6: [Permission chip] shift+tab to cycle    (permission)

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronsRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ProviderPicker } from './ProviderPicker';
import { api, type PublicSettings } from '../lib/api';
import { effectiveWindow, formatTokens } from '../lib/modelWindow';
import type { TodoEntry } from '../views/Session';
import type { ContextBreakdown, UsageSnapshot } from '@macaron/shared';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

// Ordered largest-context-hog first so the popover reads top-down by impact.
// Colors echo Anthropic's /context palette (system grey, messages green,
// tool results blue, tool calls purple, thinking amber).
const SEGMENTS: Array<{ key: keyof Omit<ContextBreakdown, 'total'>; label: string; color: string }> = [
  { key: 'system', label: 'System + tools', color: '#8a8880' },
  { key: 'toolResults', label: 'Tool results', color: '#6d99c8' },
  { key: 'messages', label: 'Messages', color: '#7fb26b' },
  { key: 'toolCalls', label: 'Tool calls', color: '#9b7bc4' },
  { key: 'thinking', label: 'Thinking', color: '#b88a3a' },
];

const PERMISSION_OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: 'default', label: 'Default (ask)' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan mode' },
  { value: 'bypassPermissions', label: 'Bypass all' },
];

function PermissionChip({
  value,
  onChange,
  disabled,
}: {
  value: PermissionMode;
  onChange: (v: PermissionMode) => void;
  disabled: boolean;
}) {
  const active = PERMISSION_OPTIONS.find((o) => o.value === value);
  return (
    <div className={`provider-chip${disabled ? ' disabled' : ''}`} title={`Permission · ${active?.label ?? value}`}>
      <span className="provider-chip-label">{active?.label ?? value}</span>
      <ChevronDown className="provider-chip-caret" size={8} strokeWidth={2.5} aria-hidden="true" />
      <select
        className="provider-chip-select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as PermissionMode)}
        aria-label="Permission mode"
      >
        {PERMISSION_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

// A 10-cell filled bar with two clarity marks: color changes as it fills.
function Bar({ pct, tone = 'context' }: { pct: number; tone?: 'context' | 'usage' | 'weekly' }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className={`status-bar-track tone-${tone}`}>
      <div className="status-bar-fill" style={{ width: `${clamped}%` }} />
    </div>
  );
}

// Context bar split by source, with a hover/focus popover legend. Each segment
// is sized as tokens/window; the remainder reads as free space. The split is
// an estimate (see ContextBreakdown) — the headline % stays ground-truth.
function SegmentedContextBar({ breakdown, window }: { breakdown: ContextBreakdown; window: number }) {
  const rows = SEGMENTS.map((s) => ({ ...s, tokens: breakdown[s.key] })).filter((r) => r.tokens > 0);
  return (
    <div className="status-context-seg" tabIndex={0} aria-label="Context composition">
      <div className="status-bar-track tone-context">
        {rows.map((r) => (
          <div
            key={String(r.key)}
            className="status-seg-fill"
            style={{ width: `${window > 0 ? Math.min(100, (r.tokens / window) * 100) : 0}%`, background: r.color }}
          />
        ))}
      </div>
      <div className="status-seg-pop" role="tooltip">
        <div className="status-seg-pop-title">Context by source <span>· estimated</span></div>
        {rows.map((r) => (
          <div key={String(r.key)} className="status-seg-pop-row">
            <span className="status-seg-swatch" style={{ background: r.color }} />
            <span className="status-seg-pop-label">{r.label}</span>
            <span className="status-seg-pop-tok">{formatTokens(r.tokens)}</span>
            <span className="status-seg-pop-pct">{window > 0 ? ((r.tokens / window) * 100).toFixed(0) : 0}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function StatusBar({
  projectName,
  permissionMode,
  onPermissionChange,
  sending,
  currentTodo,
  latestUsage,
  contextBreakdown,
  claudeMdCount,
  mcpCount,
}: {
  projectName: string;
  permissionMode: PermissionMode;
  onPermissionChange: (v: PermissionMode) => void;
  sending: boolean;
  currentTodo: { text: string; done: number; total: number } | null;
  latestUsage?: UsageSnapshot;
  contextBreakdown?: ContextBreakdown;
  claudeMdCount?: number;
  mcpCount?: number;
}) {
  // Fetch settings once to know the active provider's model — needed to pick
  // a context-window size when the latest assistant message doesn't report
  // one (e.g. a fresh session with no replies yet).
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  useEffect(() => {
    api.settings().then(setSettings).catch(() => {/* ignore — bar just skips model text */});
  }, []);

  const activeCustom = settings?.customProviders.find((p) => p.id === settings.activeProviderId);
  const providerModel = latestUsage?.model || activeCustom?.model || '';
  const usedTokens = latestUsage
    ? latestUsage.inputTokens
      + latestUsage.cacheCreationInputTokens
      + latestUsage.cacheReadInputTokens
      + latestUsage.outputTokens
    : 0;
  const window = effectiveWindow(providerModel, usedTokens);
  const contextPct = window > 0 ? (usedTokens / window) * 100 : 0;

  const hasEnv = (claudeMdCount ?? 0) > 0 || (mcpCount ?? 0) > 0;

  return (
    <div className="status-bar">
      <div className="status-row status-identity">
        <ProviderPicker />
        <span className="status-sep">|</span>
        <span className="status-project" title={projectName}>{projectName || 'no project'}</span>
      </div>

      {usedTokens > 0 && (
        <div className="status-row status-context">
          <span className="status-context-label">Context</span>
          {contextBreakdown && contextBreakdown.total > 0
            ? <SegmentedContextBar breakdown={contextBreakdown} window={window} />
            : <Bar pct={contextPct} tone="context" />}
          <span className="status-context-pct">{contextPct.toFixed(0)}%</span>
          <span className="status-context-tokens">
            ({formatTokens(usedTokens)} / {formatTokens(window)})
          </span>
        </div>
      )}

      {hasEnv && (
        <div className="status-row status-env">
          {(claudeMdCount ?? 0) > 0 && (
            <span>{claudeMdCount} CLAUDE.md</span>
          )}
          {(claudeMdCount ?? 0) > 0 && (mcpCount ?? 0) > 0 && (
            <span className="status-sep">|</span>
          )}
          {(mcpCount ?? 0) > 0 && (
            <Link className="status-env-link" to="/mcp" title="Manage MCP servers">{mcpCount} MCPs</Link>
          )}
        </div>
      )}

      {currentTodo && (
        <div className="status-row status-todo">
          <span className="status-todo-arrow"><ChevronRight size={12} aria-hidden="true" /></span>
          <span className="status-todo-text">{currentTodo.text}</span>
          <span className="status-todo-progress">
            ({currentTodo.done}/{currentTodo.total})
          </span>
        </div>
      )}

      <div className="status-row status-perm">
        <span className="status-perm-arrow"><ChevronsRight size={12} aria-hidden="true" /></span>
        <PermissionChip value={permissionMode} onChange={onPermissionChange} disabled={sending} />
        <span className="status-perm-hint">shift+tab to cycle</span>
      </div>
    </div>
  );
}
