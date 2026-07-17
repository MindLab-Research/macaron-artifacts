import { useEffect, useMemo, useState } from 'react';
import {
  api,
  basename,
  type HooksResponse,
  type HookHandlerView,
  type HookScope,
  type Workspace,
} from '../lib/api';

// Fixed order so events always render in lifecycle sequence, not JSON key
// order. Anything not listed (newer events) falls to the end alphabetically.
const EVENT_ORDER = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'SessionEnd',
];

function eventRank(event: string): number {
  const i = EVENT_ORDER.indexOf(event);
  return i === -1 ? EVENT_ORDER.length : i;
}

const SCOPE_LABEL: Record<HookScope, string> = {
  user: 'user',
  project: 'project',
  local: 'local',
};

function groupByEvent(handlers: HookHandlerView[]): Array<[string, HookHandlerView[]]> {
  const map = new Map<string, HookHandlerView[]>();
  for (const h of handlers) {
    const list = map.get(h.event) ?? [];
    list.push(h);
    map.set(h.event, list);
  }
  return [...map.entries()].sort(
    ([a], [b]) => eventRank(a) - eventRank(b) || a.localeCompare(b),
  );
}

export function Hooks() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [project, setProject] = useState<string>('');
  const [data, setData] = useState<HooksResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  // Workspace list drives the scope picker. Best-effort — the page still
  // works (user-scope hooks) if this fails.
  useEffect(() => {
    api.workspaces().then((d) => setWorkspaces(d.workspaces)).catch(() => {/* ignore */});
  }, []);

  useEffect(() => {
    setLoading(true);
    setError('');
    api
      .hooks(project || undefined)
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [project]);

  const grouped = useMemo(() => groupByEvent(data?.handlers ?? []), [data]);
  const total = data?.handlers.length ?? 0;

  return (
    <section className="view hooks-view">
      <header>
        <h1>Hooks</h1>
        <p>
          Shell commands, HTTP endpoints, and prompts that fire automatically at Claude Code
          lifecycle events. Read from your <code>settings.json</code> files — this view is
          read-only; edit the files to change them.
        </p>
      </header>

      <div className="hooks-scope">
        <label htmlFor="hooks-project">Project scope</label>
        <select
          id="hooks-project"
          className="settings-input hooks-scope-select"
          value={project}
          onChange={(e) => setProject(e.target.value)}
        >
          <option value="">User only (~/.claude)</option>
          {workspaces.map((w) => (
            <option key={w.project} value={w.project}>
              {w.name || basename(w.cwd) || w.project}
            </option>
          ))}
        </select>
      </div>

      {error && <div className="placeholder">Error: {error}</div>}
      {loading && !error && <div className="muted">Loading…</div>}

      {!loading && !error && data && (
        <>
          <div className="hooks-sources">
            {data.sources.map((s) => (
              <span key={s.path} className={`hooks-source${s.present && !s.error ? '' : ' absent'}`}>
                <span className={`prov-tag ${s.present && !s.error ? 'ok' : 'bad'}`}>{SCOPE_LABEL[s.scope]}</span>
                <code title={s.path}>{s.path}</code>
                {s.error ? <span className="hooks-source-note" title={s.error}>invalid JSON</span> : !s.present && <span className="hooks-source-note">not found</span>}
              </span>
            ))}
          </div>

          {total === 0 ? (
            <div className="placeholder">
              No hooks configured. Add a <code>hooks</code> block to a{' '}
              <code>settings.json</code> above to gate, format, or notify on lifecycle events.
            </div>
          ) : (
            grouped.map(([event, handlers]) => (
              <div key={event} className="hooks-group">
                <div className="hooks-group-head">
                  <h2 className="sec-title">{event}</h2>
                  <span className="hooks-group-count">
                    {handlers.length} handler{handlers.length === 1 ? '' : 's'}
                  </span>
                </div>
                <table className="hooks-table">
                  <thead>
                    <tr>
                      <th>Matcher</th>
                      <th>Type</th>
                      <th>Runs</th>
                      <th>Scope</th>
                    </tr>
                  </thead>
                  <tbody>
                    {handlers.map((h, i) => (
                      <tr key={`${h.source}:${h.matcher}:${i}`}>
                        <td className="hooks-matcher">
                          <code>{h.matcher || '*'}</code>
                        </td>
                        <td className="hooks-type">{h.type}</td>
                        <td className="hooks-run">
                          <code>{h.run || '—'}</code>
                          {h.condition && (
                            <div className="hooks-cond">
                              if <code>{h.condition}</code>
                            </div>
                          )}
                        </td>
                        <td>
                          <span className={`prov-tag ${h.scope === 'user' ? '' : 'ok'}`}>
                            {SCOPE_LABEL[h.scope]}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))
          )}
        </>
      )}
    </section>
  );
}
