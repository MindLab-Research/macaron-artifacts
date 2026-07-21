import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { getApiBase } from '../lib/apiBase';
import { assetUrl } from '../lib/assetBase';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  CopyPlus,
  Crosshair,
  GitMerge,
  Link as LinkIcon,
  Pencil,
  Plus,
  Search,
  Trash2,
  Unlink,
  X,
} from 'lucide-react';
import { api, basename, sessionTitle, HttpError, type Workspace, type SessionListItem, type WorktreeInfo } from '../lib/api';
import { useToast } from './Toast';
import { useConfirm } from './Confirm';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { DirPicker } from './DirPicker';
import { encodeClaudeProjectName, setPendingCwd } from '../lib/newSession';
import { RateLimitMeters } from './RateLimitMeters';
import { NewProjectModal } from './NewProjectModal';
import {
  getCanvasSids,
  toggleCanvasSid,
  focusCanvasSid,
  subscribeCanvas,
  removeCanvasSid,
} from '../lib/canvas';
import { subscribeSystemEvents } from '../lib/systemEvents';

type WsData = Workspace & { sessions: SessionListItem[] };

function sessStatus(mtime: number): 'completed' | 'running' {
  return Date.now() - mtime < 60_000 ? 'running' : 'completed';
}

export function Sidebar({ onNavigate }: {
  onNavigate?: () => void;
} = {}) {
  const [workspaces, setWorkspaces] = useState<WsData[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<'connecting' | 'ok' | 'bad'>('connecting');
  const [model, setModel] = useState('');
  const [ctxMenu, setCtxMenu] = useState<{ items: MenuItem[]; x: number; y: number } | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Per-workspace set of canvas-pinned sids, so the session rows can show
  // + / ✓ toggles. Re-reads from localStorage whenever a canvas changes.
  const [canvasBy, setCanvasBy] = useState<Record<string, string[]>>({});
  // sid currently in inline-rename mode (its name span becomes an <input>).
  const [renamingSid, setRenamingSid] = useState<string>('');
  const [renameDraft, setRenameDraft] = useState<string>('');
  const renameDoneRef = useRef(false);
  // sessionId → active worktree, so a session row's context menu can offer
  // merge/discard only for sessions that actually run in a worktree.
  const [worktrees, setWorktrees] = useState<Record<string, WorktreeInfo>>({});
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const confirm = useConfirm();

  const loadData = useCallback(async () => {
    try {
      const d = await api.workspaces();
      const results = await Promise.all(
        d.workspaces.map(async (w) => {
          try {
            const detail = await api.workspace(w.project);
            return { ...w, sessions: detail.sessions } as WsData;
          } catch {
            return { ...w, sessions: [] } as WsData;
          }
        }),
      );
      setWorkspaces(results);
      try {
        const wt = await api.worktrees();
        setWorktrees(Object.fromEntries(wt.worktrees.map((w) => [w.sessionId, w])));
      } catch {}
    } catch {}
  }, []);

  useEffect(() => {
    api
      .health()
      .then((j) => {
        setStatus('ok');
        setModel(j.model);
      })
      .catch(() => setStatus('bad'));
    loadData();
    const t = setInterval(loadData, 10_000);
    // Refresh immediately when a claude session changes on disk (e.g. a
    // terminal run) — the interval above stays as a fallback.
    const unsub = subscribeSystemEvents((ev) => {
      if (ev.engine === 'claude') void loadData();
    });
    return () => {
      clearInterval(t);
      unsub();
    };
  }, [loadData]);

  // Track canvas state per workspace. On every workspaces refresh (or
  // canvas mutation) re-read the sids so the +/✓ toggles stay accurate.
  useEffect(() => {
    const refresh = () => {
      const next: Record<string, string[]> = {};
      for (const w of workspaces) next[w.project] = getCanvasSids(w.project);
      setCanvasBy(next);
    };
    refresh();
    const unsubs = workspaces.map((w) => subscribeCanvas(w.project, refresh));
    return () => {
      for (const u of unsubs) u();
    };
  }, [workspaces]);

  // Auto-expand workspace from URL
  useEffect(() => {
    const m = location.pathname.match(/^\/w\/([^/]+)/);
    if (m) {
      const proj = decodeURIComponent(m[1]!);
      setExpanded((s) => {
        if (s.has(proj)) return s;
        const next = new Set(s);
        next.add(proj);
        return next;
      });
    }
  }, [location.pathname]);

  const toggleExpand = (project: string) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });
  };

  const activeProject = (() => {
    const m = location.pathname.match(/^\/w\/([^/]+)/);
    return m ? decodeURIComponent(m[1]!) : '';
  })();

  // Directory picker → start a session in any folder on disk. Encode the
  // chosen path to its project key (claude-cli style), stash the raw cwd for
  // the first-send POST, then navigate to that workspace so a draft opens.
  const onPickDir = (cwd: string) => {
    setPickerOpen(false);
    const project = encodeClaudeProjectName(cwd);
    setPendingCwd(project, cwd);
    navigate(`/w/${encodeURIComponent(project)}`);
    onNavigate?.();
  };


  const wsMenu = (w: WsData, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          icon: <Plus size={14} aria-hidden="true" />,
          label: 'New Session',
          onClick: () => navigate(`/w/${encodeURIComponent(w.project)}`),
        },
        {
          icon: <Clipboard size={14} aria-hidden="true" />,
          label: 'Copy Path',
          onClick: () => {
            navigator.clipboard.writeText(w.cwd || w.project);
            toast('path copied');
          },
        },
        'separator',
        {
          icon: <X size={14} aria-hidden="true" />,
          label: 'Delete Workspace',
          danger: true,
          onClick: async () => {
            const ok = await confirm({
              title: 'Delete workspace?',
              body: (
                <>
                  All <strong>{w.sessionCount}</strong> session{w.sessionCount === 1 ? '' : 's'} under <code>{w.name || w.project}</code> will be removed from Macaron
                  (jsonl files under <code>~/.claude/projects/{w.project}/</code>).
                  {' '}<strong>The project directory on disk stays put</strong>
                  {w.cwd ? <> — <code>{w.cwd}</code> is not touched.</> : '.'}
                  {' '}Can't be undone.
                </>
              ),
              confirmLabel: `Delete ${w.sessionCount} session${w.sessionCount === 1 ? '' : 's'}`,
              destructive: true,
            });
            if (!ok) return;
            try {
              const { removedSessions } = await api.deleteWorkspace(w.project);
              toast(`Workspace deleted — removed ${removedSessions} session${removedSessions === 1 ? '' : 's'}`);
              // If we were sitting on this workspace, bounce home so the
              // dashboard doesn't keep polling a project that no longer exists.
              if (activeProject === w.project) navigate('/');
              loadData();
            } catch (err) {
              toast(`Delete failed: ${(err as Error).message}`);
            }
          },
        },
      ],
    });
  };

  const startRename = (s: SessionListItem) => {
    renameDoneRef.current = false;
    setRenamingSid(s.sessionId);
    // Prefill with the current override (manual label or native title) so an
    // edit tweaks the existing name rather than starting blank.
    setRenameDraft(s.label || s.title || '');
  };

  const commitRename = async (project: string, sid: string) => {
    if (renameDoneRef.current) return;
    renameDoneRef.current = true;
    const name = renameDraft.trim();
    setRenamingSid('');
    try {
      await api.setSessionLabel(project, sid, name);
      loadData();
    } catch (err) {
      toast(`rename failed: ${(err as Error).message}`);
    }
  };

  const sessMenu = (w: WsData, s: SessionListItem, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const wt = worktrees[s.sessionId];
    const items: MenuItem[] = [
        {
          icon: <Crosshair size={14} aria-hidden="true" />,
          label: 'Focus Session',
          onClick: () =>
            navigate(
              `/w/${encodeURIComponent(w.project)}/s/${encodeURIComponent(s.sessionId)}`,
            ),
        },
        {
          icon: <Pencil size={14} aria-hidden="true" />,
          label: 'Rename',
          onClick: () => startRename(s),
        },
        {
          icon: <CopyPlus size={14} aria-hidden="true" />,
          label: 'Duplicate',
          onClick: async () => {
            try {
              const r = await api.duplicateSession(w.project, s.sessionId);
              toast(`duplicated → ${r.newSid.slice(0, 8)}`);
              loadData();
              navigate(
                `/w/${encodeURIComponent(w.project)}/s/${encodeURIComponent(r.newSid)}`,
              );
            } catch (err) {
              toast(`duplicate failed: ${(err as Error).message}`);
            }
          },
        },
        {
          icon: <LinkIcon size={14} aria-hidden="true" />,
          label: 'Copy share link',
          onClick: async () => {
            try {
              const { token } = await api.createShare(w.project, s.sessionId);
              // A recipient needs an origin that serves the UI AND answers
              // /api/public: hosted mode (api base set) must use the server's
              // own origin — a docs-origin /app link has no server bound and
              // can never resolve. Local/tunnel keeps the browser's origin +
              // app base so it works over LAN/tunnel, not just the server's
              // 127.0.0.1 root bind.
              const server = getApiBase();
              const url = server ? `${server}/#/share/${token}` : `${window.location.origin}${assetUrl('/')}#/share/${token}`;
              await navigator.clipboard.writeText(url);
              toast('share link copied');
            } catch (err) {
              toast(`share failed: ${(err as Error).message}`);
            }
          },
        },
        {
          icon: <Unlink size={14} aria-hidden="true" />,
          label: 'Unshare',
          onClick: async () => {
            try {
              const { ok } = await api.revokeShare(w.project, s.sessionId);
              toast(ok ? 'share link revoked' : 'was not shared');
            } catch (err) {
              toast(`unshare failed: ${(err as Error).message}`);
            }
          },
        },
    ];
    if (wt) {
      items.push('separator', {
        icon: <GitMerge size={14} aria-hidden="true" />,
        label: wt.dirty ? 'Merge worktree (commit first)' : 'Merge worktree → base',
        onClick: async () => {
          try {
            await api.mergeWorktree(s.sessionId);
            toast(`merged ${wt.branch} → ${wt.baseBranch}`);
            loadData();
          } catch (err) {
            toast(`merge failed: ${(err as Error).message}`);
          }
        },
      }, {
        icon: <Trash2 size={14} aria-hidden="true" />,
        label: 'Discard worktree',
        danger: true,
        onClick: async () => {
          const attempt = async (force: boolean) => {
            await api.discardWorktree(s.sessionId, force);
            toast(`discarded ${wt.branch}`);
            loadData();
          };
          try {
            await attempt(false);
          } catch (err) {
            // 409 = dirty tree: prompt before force-discarding real work.
            if (!(err instanceof HttpError) || err.status !== 409) {
              toast(`discard failed: ${(err as Error).message}`);
              return;
            }
            const ok = await confirm({
              title: 'Discard dirty worktree?',
              body: `Uncommitted changes on ${wt.branch} will be lost.`,
              confirmLabel: 'Discard',
              destructive: true,
            });
            if (!ok) return;
            try {
              await attempt(true);
            } catch (err2) {
              toast(`discard failed: ${(err2 as Error).message}`);
            }
          }
        },
      });
    }
    items.push('separator', {
          icon: <X size={14} aria-hidden="true" />,
          label: 'Delete Session',
          danger: true,
          onClick: async () => {
            try {
              await api.deleteSession(w.project, s.sessionId);
              // Also unpin from the workspace canvas so the tile disappears
              // — otherwise the tile keeps mounting a Session whose jsonl
              // no longer exists (404s until manually unpinned).
              removeCanvasSid(w.project, s.sessionId);
              toast(`deleted ${s.sessionId.slice(0, 8)}`);
              loadData();
            } catch (err) {
              toast(`delete failed: ${(err as Error).message}`);
            }
          },
    });
    setCtxMenu({ x: e.clientX, y: e.clientY, items });
  };

  return (
    <aside className="sidebar-v2">
      <Link className="sb-brand" to="/" onClick={onNavigate}>
        <img className="sb-logo" src={assetUrl('/mindlab-symbol.svg')} alt="" />
        <div>
          <div className="sb-brand-name">Macaron Artifacts</div>
          <div className="sb-brand-sub">Presented by Mind Lab</div>
        </div>
      </Link>

      <button
        type="button"
        className="sb-search"
        onClick={() => {
          onNavigate?.();
          window.requestAnimationFrame(() => {
            window.dispatchEvent(new CustomEvent('macaron:open-search'));
          });
        }}
        title="Search Claude sessions"
      >
        <span className="sb-search-icon"><Search size={16} aria-hidden="true" /></span>
        <span className="sb-search-label">Search sessions</span>
      </button>
      <Link className={'sb-nav-link' + (location.pathname === '/examples' ? ' active' : '')} to="/examples" onClick={onNavigate}>
        <span>Examples</span>
      </Link>

      <div className="sb-label">
        <span>WORKSPACES</span>
        <div className="sb-label-actions">
          <button
            type="button"
            className="sb-new-project"
            onClick={() => {
              onNavigate?.();
              setShowNewProject(true);
            }}
            title="New project (create dir or clone a repo)"
            aria-label="New project"
          >
            + new
          </button>
        </div>
      </div>

      <div className="sb-ws-list">
        {workspaces.map((w) => {
          const name = w.name || basename(w.cwd) || w.project;
          const isExpanded = expanded.has(w.project);
          const isActive = activeProject === w.project;
          const runCount = w.sessions.filter((s) => sessStatus(s.mtime) === 'running').length;

          return (
            <div key={w.project} className={'sb-ws' + (isActive ? ' active' : '')}>
              <div
                className="sb-ws-head"
                onContextMenu={(e) => wsMenu(w, e)}
              >
                <button
                  type="button"
                  className="sb-ws-main"
                  aria-expanded={isExpanded}
                  onClick={() => {
                    toggleExpand(w.project);
                    navigate(`/w/${encodeURIComponent(w.project)}`, {
                      state: { keepClaudeDrawerOpen: true },
                    });
                  }}
                >
                  <span className="sb-arrow">{isExpanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}</span>
                  <span className="sb-ws-name">{name}</span>
                  <span className="sb-spacer" />
                  {runCount > 0 && !isExpanded && (
                    <span className="sb-badge sb-badge-running">{runCount}</span>
                  )}
                </button>
                <button
                  type="button"
                  className="sb-dots"
                  onClick={(e) => wsMenu(w, e)}
                  title="Workspace actions"
                  aria-label={`${name} actions`}
                >
                  ···
                </button>
              </div>
              {isExpanded && (
                <div className="sb-ws-sessions">
                  {w.sessions.map((s) => {
                    const st = sessStatus(s.mtime);
                    const pinned = (canvasBy[w.project] || []).includes(s.sessionId);
                    return (
                      <div
                        key={s.sessionId}
                        className={'sb-sess' + (pinned ? ' pinned' : '')}
                        onContextMenu={(e) => sessMenu(w, s, e)}
                      >
                        {renamingSid === s.sessionId ? (
                          <div className="sb-sess-main">
                            <span className={'sb-sess-dot sb-sess-dot-' + st} />
                            <input
                              className="sb-sess-rename"
                              value={renameDraft}
                              autoFocus
                              placeholder={s.preview || s.sessionId.slice(0, 8)}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => setRenameDraft(e.target.value)}
                              onBlur={() => commitRename(w.project, s.sessionId)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitRename(w.project, s.sessionId);
                                else if (e.key === 'Escape') {
                                  renameDoneRef.current = true;
                                  setRenamingSid('');
                                }
                              }}
                            />
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="sb-sess-main"
                            onClick={() => {
                              // First click adds to canvas. Subsequent clicks
                              // focus the existing tile.
                              if (!pinned) toggleCanvasSid(w.project, s.sessionId);
                              else focusCanvasSid(w.project, s.sessionId);
                              if (activeProject !== w.project) {
                                navigate(`/w/${encodeURIComponent(w.project)}`);
                              }
                              window.dispatchEvent(
                                new CustomEvent('macaron:focus-tile', {
                                  detail: { project: w.project, sid: s.sessionId },
                                }),
                              );
                              onNavigate?.();
                            }}
                          >
                            <span className={'sb-sess-dot sb-sess-dot-' + st} />
                            <span className="sb-sess-name">
                              {sessionTitle(s)}
                            </span>
                          </button>
                        )}
                        <button
                          type="button"
                          className={'sb-sess-pin' + (pinned ? ' pinned' : '')}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleCanvasSid(w.project, s.sessionId);
                            if (activeProject !== w.project) {
                              navigate(`/w/${encodeURIComponent(w.project)}`);
                            }
                            onNavigate?.();
                          }}
                          title={pinned ? 'Remove from canvas' : 'Add to canvas'}
                          aria-label={`${pinned ? 'Remove' : 'Add'} ${sessionTitle(s)} ${pinned ? 'from' : 'to'} canvas`}
                        >
                          {pinned ? <Check size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
                        </button>
                      </div>
                    );
                  })}
                  {w.sessions.length === 0 && (
                    <div className="sb-sess empty">No sessions</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {workspaces.length === 0 && (
          <div className="sb-empty">No workspaces</div>
        )}
      </div>

      <div className="sb-tools">
        <Link className="sb-settings-link" to="/usage" onClick={onNavigate}>
          <span>Usage</span>
        </Link>

        <button
          type="button"
          className="sb-settings-link sb-shortcuts-btn"
          onClick={() => {
            onNavigate?.();
            window.requestAnimationFrame(() => {
              window.dispatchEvent(new CustomEvent('macaron:shortcuts'));
            });
          }}
          title="Keyboard shortcuts"
        >
          <span>Shortcuts</span>
          <span className="sb-spacer" />
          <kbd className="sb-shortcuts-kbd" aria-hidden="true">?</kbd>
        </button>

        <Link className="sb-settings-link" to="/settings" onClick={onNavigate}>
          <span>Settings</span>
        </Link>
      </div>

      <footer className="sb-footer">
        <RateLimitMeters />
        <div className={'sb-status sb-status-' + status}>
          {status === 'ok'
            ? `online · ${model}`
            : status === 'bad'
              ? 'offline'
              : 'connecting…'}
        </div>
      </footer>

      {ctxMenu && (
        <ContextMenu
          items={ctxMenu.items}
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {showNewProject && (
        <NewProjectModal
          onClose={() => setShowNewProject(false)}
          onCreated={(project) => {
            setShowNewProject(false);
            loadData();
            navigate(`/w/${encodeURIComponent(project)}`);
            onNavigate?.();
          }}
        />
      )}
      {pickerOpen && <DirPicker onPick={onPickDir} onClose={() => setPickerOpen(false)} />}
    </aside>
  );
}
