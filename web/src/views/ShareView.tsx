import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, basename, type SharedSessionResponse } from '../lib/api';
import { flatten, ItemView } from './Session';

// Public read-only viewer for a shared session. Resolves the share token to a
// snapshot and renders it through the SAME flatten() + ItemView pipeline the
// live Session view uses — identical look, no composer, no rewind/permission
// affordances. The server never attaches an agent for this route.
export function ShareView() {
  const { token = '' } = useParams();
  const [resp, setResp] = useState<SharedSessionResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setResp(null);
    setError('');
    api
      .sharedSession(token)
      .then((d) => { if (alive) setResp(d); })
      .catch((e) => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, [token]);

  const items = useMemo(() => (resp ? flatten(resp.detail.messages) : []), [resp]);
  const cwd = resp?.detail.cwd || '';
  const name = cwd ? basename(cwd) : 'Shared session';
  const shownCwd = cwd ? cwd.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~') : '';

  return (
    <main id="main">
      <section className="view session-view">
        <div className="session-bar">
          <div className="session-bar-left">
            <span className="sb-brand-name">Macaron</span>
            <span className="sep">›</span>
            <span className="sess-id-crumb">{name}</span>
            {resp?.detail.gitBranch && <span className="sess-branch">{resp.detail.gitBranch}</span>}
          </div>
          <div className="session-bar-right">
            <span className="thread-banner" style={{ margin: 0 }}>Read-only · shared</span>
          </div>
        </div>

        {/* Same column-reverse thread as the live view: newest → oldest in DOM. */}
        <div className="thread tui">
          {[...items].reverse().map((it) => (
            <ItemView key={it.id} it={it} />
          ))}
          {resp?.detail.truncated && (
            <div className="thread-banner">
              Showing tail only — full session is {(resp.detail.totalBytes! / 1024 / 1024).toFixed(1)} MB.
            </div>
          )}
          {resp && items.length === 0 && <div className="placeholder">This session has no messages.</div>}
          {error && (
            <div className="placeholder">This share link is no longer available.</div>
          )}
          {!resp && !error && <div className="muted">Loading…</div>}
          {shownCwd && (
            <div className="ti-session-head">
              <span className="ti-session-cwd">{shownCwd}</span>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
