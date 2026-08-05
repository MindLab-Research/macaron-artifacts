import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Check, Circle, Plus, Search, X, Settings } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { assetUrl } from '../lib/assetBase';
import { codexApi, type CodexThread, type CodexWorkspace } from './api';
import {
  getCanvasSids,
  toggleCanvasSid,
  focusCanvasSid,
  subscribeCanvas,
  addDraftSid,
} from '../lib/canvas';
import { subscribeSystemEvents } from '../lib/systemEvents';
import { useConfirm } from '../components/Confirm';
import { useToast } from '../components/Toast';
import { sessionTitle } from '../lib/api';
import { NewProjectModal } from '../components/NewProjectModal';

type WsData = CodexWorkspace & { sessions: CodexThread[] };

function basename(p: string): string {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

export function CodexSidebar({ onNavigate }: {
  onNavigate?: () => void;
} = {}) {
  const [workspaces, setWorkspaces] = useState<WsData[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<'connecting' | 'ok' | 'bad'>('connecting');
  const [providerLabel, setProviderLabel] = useState('');
  const [canvasBy, setCanvasBy] = useState<Record<string, string[]>>({});
  const [showNewProject, setShowNewProject] = useState(false);
  // Inline rename state: sid whose title is currently in edit mode + draft
  // value. Committing writes via codexApi.setThreadLabel (engine-agnostic
  // label sidecar); Escape cancels without a request.
  const [renamingSid, setRenamingSid] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const renameDoneRef = useRef(false);
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const activeProject = /^\/w\/([^/]+)/.exec(location.pathname)?.[1] ? decodeURIComponent(/^\/w\/([^/]+)/.exec(location.pathname)![1]!) : '';

  const load = useCallback(async () => {
    try {
      const d = await codexApi.workspaces();
      const results = await Promise.all(
        d.workspaces.map(async (w) => {
          try {
            const detail = await codexApi.workspace(w.project);
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
    codexApi.config()
      .then((c) => {
        setStatus('ok');
        if (c.activeProviderId === 'system') {
          const b = c.builtins[0];
          setProviderLabel(`system · ${b?.detectedModel || '(codex default)'}`);
        } else {
          const p = c.customProviders.find((x) => x.id === c.activeProviderId);
          setProviderLabel(p ? `${p.name} · ${p.model}` : 'unknown provider');
        }
      })
      .catch(() => setStatus('bad'));
    const t = setInterval(load, 10_000);
    // Refresh immediately when a codex rollout changes on disk (e.g. a
    // terminal-started `codex` run); interval stays as a fallback.
    const unsub = subscribeSystemEvents((ev) => {
      if (ev.engine === 'codex') void load();
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

  const startRename = (sid: string, current: string) => {
    renameDoneRef.current = false;
    setRenamingSid(sid);
    setRenameDraft(current);
  };
  const commitRename = async (sid: string) => {
    if (renameDoneRef.current) return;
    renameDoneRef.current = true;
    const name = renameDraft.trim();
    setRenamingSid('');
    try {
      await codexApi.setThreadLabel(sid, name);
      await load();
    } catch (err) {
      toast(`rename failed: ${(err as Error).message}`);
    }
  };
  const cancelRename = () => {
    renameDoneRef.current = true;
    setRenamingSid('');
  };

  const del = async (e: React.MouseEvent, sid: string) => {
    e.stopPropagation();
    const ok = await confirm({
      title: 'Delete thread?',
      body: (
        <>
          The rollout file under <code>~/.codex/sessions</code> will be
          removed. This can't be undone.
        </>
      ),
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await codexApi.deleteThread(sid);
      await load();
      if (activeSid === sid) navigate('/');
    } catch (err) {
      toast(`Delete failed: ${(err as Error).message}`);
    }
  };

  return (
    <aside className="cx-sidebar">
      <Link className="cx-sb-brand" to="/" onClick={onNavigate}>
        <img className="cx-sb-logo" src={assetUrl('/mindlab-symbol.svg')} alt="" />
        <div>
          <div className="cx-sb-brand-name">Macaron Artifacts</div>
          <div className="cx-sb-brand-sub">Presented by Mind Lab</div>
        </div>
      </Link>

      <button
        className="cx-sb-new"
        onClick={() => {
          // In a workspace: drop a draft tile onto that workspace's canvas
          // so the new thread lives alongside pinned ones instead of jumping
          // out to a full-screen root. Outside any workspace: fall back to
          // the plain "/" composer.
          if (activeProject) {
            addDraftSid(activeProject);
            navigate(`/w/${encodeURIComponent(activeProject)}`);
          } else {
            navigate('/');
          }
          onNavigate?.();
        }}
      >
        <Plus size={14} aria-hidden="true" />
        <span>New thread</span>
      </button>

      <button
        type="button"
        className="cx-sb-search"
        onClick={() => {
          onNavigate?.();
          window.requestAnimationFrame(() => {
            window.dispatchEvent(new CustomEvent('macaron:open-search'));
          });
        }}
        title="Search threads (Cmd+K)"
      >
        <span className="cx-sb-search-icon"><Search size={14} aria-hidden="true" /></span>
        <span className="cx-sb-search-label">Search threads</span>
        <kbd className="cx-sb-search-kbd" aria-hidden="true">⌘K</kbd>
      </button>

      <Link
        className={'cx-sb-nav-link' + (location.pathname === '/examples' ? ' active' : '')}
        to="/examples"
        onClick={onNavigate}
      >
        <span>Examples</span>
      </Link>

      <div className="cx-sb-label">
        <span>WORKSPACES</span>
        <button
          type="button"
          className="cx-sb-new-project"
          onClick={() => { onNavigate?.(); setShowNewProject(true); }}
          title="New project (create dir or clone a repo)"
          aria-label="New project"
        >
          + new
        </button>
      </div>

      <div className="cx-sb-list">
        {workspaces.length === 0 && (
          <div className="cx-sb-empty">No workspaces yet.</div>
        )}
        {workspaces.map((w) => {
          const isExpanded = expanded.has(w.project);
          const name = w.name || basename(w.cwd) || w.project;
          return (
            <div key={w.project} className={'cx-sb-ws' + (isExpanded ? ' open' : '')}>
              <button
                type="button"
                className={'cx-sb-ws-head' + (w.project === activeProject ? ' active' : '')}
                aria-expanded={isExpanded}
                onClick={() => {
                  toggle(w.project);
                  const target = `/w/${encodeURIComponent(w.project)}`;
                  navigate(target, { state: { keepCodexDrawerOpen: true } });
                }}
              >
                <span className="cx-sb-ws-arrow">{isExpanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}</span>
                <span className="cx-sb-ws-name">{name}</span>
                <span className="cx-sb-ws-count">{w.sessionCount}</span>
              </button>
              {isExpanded && (
                <div className="cx-sb-ws-sessions">
                  {w.sessions.map((s) => {
                    const pinned = (canvasBy[w.project] || []).includes(s.sessionId);
                    const label = sessionTitle(s);
                    return (
                      <div
                        key={s.sessionId}
                        className={'cx-sb-thread' + (pinned ? ' pinned' : '')}
                      >
                        {renamingSid === s.sessionId ? (
                          <input
                            type="text"
                            className="cx-sb-thread-rename"
                            value={renameDraft}
                            autoFocus
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onBlur={() => { void commitRename(s.sessionId); }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { e.preventDefault(); void commitRename(s.sessionId); }
                              else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <button
                            type="button"
                            className="cx-sb-thread-main"
                            title={s.cwd}
                            onClick={() => {
                              // Click to add to canvas; re-click on pinned focuses it.
                              if (!pinned) toggleCanvasSid(w.project, s.sessionId);
                              else focusCanvasSid(w.project, s.sessionId);
                              if (activeProject !== w.project) {
                                navigate(`/w/${encodeURIComponent(w.project)}`);
                              }
                              onNavigate?.();
                            }}
                            onDoubleClick={(e) => { e.stopPropagation(); startRename(s.sessionId, label); }}
                          >
                            <span className="cx-sb-thread-title">{label}</span>
                          </button>
                        )}
                        <button
                          type="button"
                          className={'cx-sb-thread-pin' + (pinned ? ' pinned' : '')}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleCanvasSid(w.project, s.sessionId);
                            if (activeProject !== w.project) {
                              navigate(`/w/${encodeURIComponent(w.project)}`);
                            }
                            onNavigate?.();
                          }}
                          title={pinned ? 'Remove from canvas' : 'Add to canvas'}
                          aria-label={`${pinned ? 'Remove' : 'Add'} ${label} ${pinned ? 'from' : 'to'} canvas`}
                        >{pinned ? <Check size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}</button>
                        <button
                          type="button"
                          className="cx-sb-thread-del"
                          onClick={(e) => del(e, s.sessionId)}
                          title="Delete"
                          aria-label={`Delete ${label}`}
                        ><X size={14} aria-hidden="true" /></button>
                      </div>
                    );
                  })}
                  {w.sessions.length === 0 && (
                    <div className="cx-sb-thread empty">No threads</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="cx-sb-grow" />

      <div className="cx-sb-tools">
        <Link className={'cx-sb-tool-link' + (location.pathname === '/usage' ? ' active' : '')} to="/usage" onClick={onNavigate}>
          <span>Usage</span>
        </Link>
        <button
          type="button"
          className="cx-sb-tool-link cx-sb-shortcuts-btn"
          onClick={() => {
            onNavigate?.();
            window.requestAnimationFrame(() => {
              window.dispatchEvent(new CustomEvent('macaron:shortcuts'));
            });
          }}
          title="Keyboard shortcuts"
        >
          <span>Shortcuts</span>
          <span className="cx-sb-spacer" />
          <kbd className="cx-sb-shortcuts-kbd" aria-hidden="true">?</kbd>
        </button>
        <Link className={'cx-sb-tool-link' + (location.pathname === '/settings' ? ' active' : '')} to="/settings" onClick={onNavigate}>
          <span><Settings size={13} aria-hidden="true" /></span>
          <span>Settings</span>
        </Link>
      </div>

      <footer className="cx-sb-foot">
        <div className={'cx-sb-status cx-sb-status-' + status}>
          <Circle className="cx-sb-status-dot" size={8} fill="currentColor" strokeWidth={0} aria-hidden="true" />
          {status === 'ok' ? providerLabel || 'online' : status === 'bad' ? 'config missing' : 'connecting…'}
        </div>
      </footer>

      {showNewProject && (
        <NewProjectModal
          onClose={() => setShowNewProject(false)}
          onCreated={(project) => {
            setShowNewProject(false);
            void load();
            navigate(`/w/${encodeURIComponent(project)}`);
            onNavigate?.();
          }}
        />
      )}
    </aside>
  );
}
