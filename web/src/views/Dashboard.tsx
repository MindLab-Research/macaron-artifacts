import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, basename, sessionTitle, fmtAgo, type Workspace, type SessionListItem } from '../lib/api';
import { NewProjectModal } from '../components/NewProjectModal';
import { subscribeSystemEvents } from '../lib/systemEvents';

type WsWithSessions = Workspace & { sessions: SessionListItem[] };

function sessStatus(mtime: number): 'completed' | 'running' {
  return Date.now() - mtime < 60_000 ? 'running' : 'completed';
}

export function Dashboard() {
  const [workspaces, setWorkspaces] = useState<WsWithSessions[] | null>(null);
  const [error, setError] = useState('');
  const [showNewProject, setShowNewProject] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      const d = await api.workspaces();
      const results = await Promise.all(
        d.workspaces.map(async (w) => {
          try {
            const detail = await api.workspace(w.project);
            return { ...w, sessions: detail.sessions };
          } catch {
            return { ...w, sessions: [] as SessionListItem[] };
          }
        }),
      );
      setWorkspaces(results);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    // Live-refresh when a claude session changes on disk — including runs
    // started outside the WebUI in a terminal. Keep a slow poll as an SSE
    // fallback, matching the workspace/sidebar views.
    const t = setInterval(load, 30_000);
    const unsub = subscribeSystemEvents((ev) => {
      if (ev.engine === 'claude') void load();
    });
    return () => {
      clearInterval(t);
      unsub();
    };
  }, [load]);

  return (
    <section className="view">
      <header>
        <h1>Dashboard</h1>
        <p>All workspaces at a glance</p>
        <button className="primary small dash-new-project" onClick={() => setShowNewProject(true)}>
          + New Project
        </button>
      </header>
      {error && <div className="placeholder">Error: {error}</div>}
      {!workspaces && !error && <div className="muted">Loading…</div>}
      {workspaces && workspaces.length === 0 && (
        <div className="placeholder">
          No workspaces yet. Run <code>claude</code> in any project to create one, or{' '}
          <button className="link-btn" onClick={() => setShowNewProject(true)}>
            create a new project
          </button>
          .
        </div>
      )}
      {workspaces && workspaces.length > 0 && (
        <div className="wk-grid">
          {workspaces.map((w) => {
            const name = w.name || basename(w.cwd) || w.project;
            const running = w.sessions.filter((s) => sessStatus(s.mtime) === 'running').length;
            return (
              <Link key={w.project} className="wk-card" to={`/w/${encodeURIComponent(w.project)}`}>
                <div className="wk-head">
                  <div className="wk-name">{name}</div>
                  <div className="wk-count">
                    {w.sessions.length} session{w.sessions.length === 1 ? '' : 's'}
                    {running > 0 && <span className="wk-running"> · {running} active</span>}
                  </div>
                </div>
                <div className="wk-path">{w.cwd || '—'}</div>
                <div className="wk-sessions-preview">
                  {w.sessions.slice(0, 4).map((s) => {
                    const st = sessStatus(s.mtime);
                    return (
                      <div key={s.sessionId} className="wk-sess-row">
                        <span className={'wk-sess-dot wk-sess-dot-' + st} />
                        <span className="wk-sess-name">{sessionTitle(s)}</span>
                        <span className="wk-sess-time">{fmtAgo(s.mtime)}</span>
                      </div>
                    );
                  })}
                  {w.sessions.length > 4 && (
                    <div className="wk-sess-more">+{w.sessions.length - 4} more</div>
                  )}
                </div>
                <div className="wk-open">Open workspace →</div>
              </Link>
            );
          })}
        </div>
      )}
      {showNewProject && (
        <NewProjectModal
          onClose={() => setShowNewProject(false)}
          onCreated={(project) => {
            setShowNewProject(false);
            navigate(`/w/${encodeURIComponent(project)}`);
          }}
        />
      )}
    </section>
  );
}
