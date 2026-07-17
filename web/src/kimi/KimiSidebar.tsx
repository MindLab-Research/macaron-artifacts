import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Check, Circle, Plus, X, Settings } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { assetUrl } from '../lib/assetBase';
import { kimiApi, type KimiThread, type KimiWorkspace } from './api';
import {
  getCanvasSids,
  toggleCanvasSid,
  focusCanvasSid,
  subscribeCanvas,
} from '../lib/canvas';
import { subscribeSystemEvents } from '../lib/systemEvents';
import { useConfirm } from '../components/Confirm';
import { useToast } from '../components/Toast';

type WsData = KimiWorkspace & { sessions: KimiThread[] };

function basename(p: string): string {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

export function KimiSidebar() {
  const [workspaces, setWorkspaces] = useState<WsData[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<'connecting' | 'ok' | 'bad'>('connecting');
  const [providerLabel, setProviderLabel] = useState('');
  const [canvasBy, setCanvasBy] = useState<Record<string, string[]>>({});
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const activeProject = /^\/w\/([^/]+)/.exec(location.pathname)?.[1] ? decodeURIComponent(/^\/w\/([^/]+)/.exec(location.pathname)![1]!) : '';

  const load = useCallback(async () => {
    try {
      const d = await kimiApi.workspaces();
      const results = await Promise.all(
        d.workspaces.map(async (w) => {
          try {
            const detail = await kimiApi.workspace(w.project);
            return { ...w, sessions: detail.sessions } as WsData;
          } catch {
            return { ...w, sessions: [] } as WsData;
          }
        }),
      );
      setWorkspaces(results);
    } catch { /* nop */ }
  }, []);

  useEffect(() => {
    load();
    kimiApi.config()
      .then((c) => {
        setStatus('ok');
        if (c.activeProviderId === 'system') {
          const b = c.builtins[0];
          setProviderLabel(`system · ${b?.detectedModel || '(kimi default)'}`);
        } else {
          const p = c.customProviders.find((x) => x.id === c.activeProviderId);
          setProviderLabel(p ? `${p.name} · ${p.model}` : 'unknown provider');
        }
      })
      .catch(() => setStatus('bad'));
    const t = setInterval(load, 10_000);
    // Refresh immediately when a kimi session changes on disk (e.g. a
    // terminal-started `kimi` run); interval stays as a fallback.
    const unsub = subscribeSystemEvents((ev) => {
      if (ev.engine === 'kimi') void load();
    });
    return () => {
      clearInterval(t);
      unsub();
    };
  }, [load]);

  // Auto-expand the workspace that owns the active thread OR is the current
  // canvas route.
  const activeSid = /\/t\/([^/]+)/.exec(location.pathname)?.[1];
  useEffect(() => {
    if (activeProject) {
      setExpanded((s) => (s.has(activeProject) ? s : new Set(s).add(activeProject)));
    }
    if (!activeSid) return;
    for (const w of workspaces) {
      if (w.sessions.some((s) => s.sessionId === activeSid)) {
        setExpanded((s) => (s.has(w.project) ? s : new Set(s).add(w.project)));
        break;
      }
    }
  }, [activeSid, activeProject, workspaces]);

  // Re-read per-workspace canvas sids so the +/✓ toggles stay accurate.
  useEffect(() => {
    const refresh = () => {
      const next: Record<string, string[]> = {};
      for (const w of workspaces) next[w.project] = getCanvasSids(w.project);
      setCanvasBy(next);
    };
    refresh();
    const unsubs = workspaces.map((w) => subscribeCanvas(w.project, refresh));
    return () => { for (const u of unsubs) u(); };
  }, [workspaces]);

  const toggle = (p: string) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(p)) n.delete(p); else n.add(p);
    return n;
  });

  const del = async (e: React.MouseEvent, sid: string) => {
    e.stopPropagation();
    const ok = await confirm({
      title: 'Delete thread?',
      body: (
        <>
          The session directory under <code>~/.kimi-code/sessions</code> will be
          removed. This can't be undone.
        </>
      ),
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await kimiApi.deleteThread(sid);
      await load();
      if (activeSid === sid) navigate('/');
    } catch (err) {
      toast(`Delete failed: ${(err as Error).message}`);
    }
  };

  return (
    <aside className="kx-sidebar">
      <Link className="kx-sb-brand" to="/">
        <img className="kx-sb-logo" src={assetUrl('/mindlab-symbol.svg')} alt="" />
        <div>
          <div className="kx-sb-brand-name">Macaron Artifacts</div>
          <div className="kx-sb-brand-sub">Presented by Mind Lab</div>
        </div>
      </Link>

      <button className="kx-sb-new" onClick={() => navigate('/')}>
        <Plus size={14} aria-hidden="true" />
        <span>New thread</span>
      </button>

      <div className="kx-sb-label"><span>WORKSPACES</span></div>

      <div className="kx-sb-list">
        {workspaces.length === 0 && (
          <div className="kx-sb-empty">No workspaces yet.</div>
        )}
        {workspaces.map((w) => {
          const isExpanded = expanded.has(w.project);
          const name = w.name || basename(w.cwd) || w.project;
          return (
            <div key={w.project} className={'kx-sb-ws' + (isExpanded ? ' open' : '')}>
              <div
                className={'kx-sb-ws-head' + (w.project === activeProject ? ' active' : '')}
                onClick={() => {
                  toggle(w.project);
                  navigate(`/w/${encodeURIComponent(w.project)}`);
                }}
              >
                <span className="kx-sb-ws-arrow">{isExpanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}</span>
                <span className="kx-sb-ws-name">{name}</span>
                <span className="kx-sb-ws-count">{w.sessionCount}</span>
              </div>
              {isExpanded && (
                <div className="kx-sb-ws-sessions">
                  {w.sessions.map((s) => {
                    const pinned = (canvasBy[w.project] || []).includes(s.sessionId);
                    return (
                      <div
                        key={s.sessionId}
                        className={'kx-sb-thread' + (pinned ? ' pinned' : '')}
                        onClick={() => {
                          // Click to add to canvas; re-click on pinned focuses it.
                          if (!pinned) toggleCanvasSid(w.project, s.sessionId);
                          else focusCanvasSid(w.project, s.sessionId);
                          if (activeProject !== w.project) {
                            navigate(`/w/${encodeURIComponent(w.project)}`);
                          }
                        }}
                        title={s.cwd}
                      >
                        <span className="kx-sb-thread-title">
                          {s.title || s.preview || s.sessionId.slice(0, 8)}
                        </span>
                        <button
                          type="button"
                          className={'kx-sb-thread-pin' + (pinned ? ' pinned' : '')}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleCanvasSid(w.project, s.sessionId);
                            if (activeProject !== w.project) {
                              navigate(`/w/${encodeURIComponent(w.project)}`);
                            }
                          }}
                          title={pinned ? 'Remove from canvas' : 'Add to canvas'}
                        >{pinned ? <Check size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}</button>
                        <button
                          className="kx-sb-thread-del"
                          onClick={(e) => del(e, s.sessionId)}
                          title="Delete"
                        ><X size={14} aria-hidden="true" /></button>
                      </div>
                    );
                  })}
                  {w.sessions.length === 0 && (
                    <div className="kx-sb-thread empty">No threads</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="kx-sb-grow" />

      <Link className="kx-sb-settings" to="/settings">
        <span><Settings size={16} aria-hidden="true" /></span>
        <span>Settings</span>
      </Link>

      <footer className="kx-sb-foot">
        <div className={'kx-sb-status kx-sb-status-' + status}>
          <Circle className="kx-sb-status-dot" size={8} fill="currentColor" strokeWidth={0} aria-hidden="true" />
          {status === 'ok' ? providerLabel || 'online' : status === 'bad' ? 'config missing' : 'connecting…'}
        </div>
      </footer>
    </aside>
  );
}
