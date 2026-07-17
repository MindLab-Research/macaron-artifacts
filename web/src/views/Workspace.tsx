import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useLocation, Link } from 'react-router-dom';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  rectSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Copy,
  FileText,
  FolderOpen,
  GitBranch,
  GripVertical,
  Plus,
  RefreshCw,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react';
import { api, basename, sessionTitle, type SessionListItem, type Workspace as Wk } from '../lib/api';
import {
  useCanvas,
  CANVAS_COLS,
  MIN_COL_SPAN,
  MAX_COL_SPAN,
  MIN_ROW_SPAN,
  MAX_ROW_SPAN,
  isDraftSid,
  type TileGeom,
} from '../lib/canvas';
import { Session } from './Session';
import { peekPendingCwd, peekPendingPrompt } from '../lib/newSession';
import { subscribeSystemEvents } from '../lib/systemEvents';
import { GitPanel } from '../components/GitPanel';
import { useConfirm } from '../components/Confirm';
import { Terminal } from '../components/Terminal';
import { isTerminalSid, killTerminal } from '../lib/terminal';
import { isFileSid, filePath } from '../lib/fileTile';
import { FilesPanel } from '../components/FilesPanel';
import { FileTile } from '../components/FileTile';

// One row cell in the canvas grid (px). CSS grid-auto-rows uses this; a
// tile's rowSpan is a multiplier. Kept in sync with `.ws-canvas-grid-v2`
// in styles.css.
const ROW_UNIT_PX = 48;

// Nominal column pixel width used for translating pixel-based resize deltas
// into integer column-span changes. We recompute from the grid's actual
// bounding rect on each drag so the snap is accurate.
type ResizeState = {
  sid: string;
  startX: number;
  startY: number;
  startColSpan: number;
  startRowSpan: number;
  colPx: number; // width of one grid column at drag start
};

export function Workspace() {
  const { project = '', sid: sidFromUrl = '' } = useParams();
  const navigate = useNavigate();
  const [workspace, setWorkspace] = useState<Wk | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [error, setError] = useState('');
  const canvas = useCanvas(project);
  const gridRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  // Track which real sids were just promoted from a draft — Session tiles
  // read this to know they should treat the first turn as "in-flight" and
  // subscribe to the liveStore instead of trying to load the (nonexistent)
  // jsonl. Cleared after the tile picks it up.
  const [pendingSids, setPendingSids] = useState<Set<string>>(new Set());
  const [gitOpen, setGitOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);

  const load = useCallback(() => {
    api
      .workspace(project)
      .then((d) => {
        setWorkspace(d.workspace);
        setSessions(d.sessions);
        setError('');
      })
      .catch((e) => setError((e as Error).message));
  }, [project]);

  useEffect(() => {
    setWorkspace(null);
    setSessions(null);
    load();
    const t = setInterval(load, 15_000);
    // Live-refresh on a claude disk change (e.g. a terminal-started session
    // in this workspace) so its tile picks up new turns without a manual
    // refresh.
    const unsub = subscribeSystemEvents((ev) => {
      if (ev.engine === 'claude') load();
    });
    return () => {
      clearInterval(t);
      unsub();
    };
  }, [project, load]);

  // Back-compat: URLs like /w/:project/s/:sid pin + focus + rewrite.
  // If the caller passed `state: { pending: true }` (Home landing dispatched
  // a fresh startNewSession + navigated straight to the real sid), mark the
  // sid as pending BEFORE the URL rewrite so Session's tile picks up
  // initialPending=true and hooks into the already-buffered live stream.
  const location = useLocation();
  useEffect(() => {
    if (!sidFromUrl) return;
    if (!canvas.isOnCanvas(sidFromUrl)) canvas.add(sidFromUrl);
    canvas.focus(sidFromUrl);
    const pending = Boolean((location.state as { pending?: boolean } | null)?.pending);
    if (pending) {
      setPendingSids((cur) => {
        if (cur.has(sidFromUrl)) return cur;
        const next = new Set(cur);
        next.add(sidFromUrl);
        return next;
      });
    }
    navigate(`/w/${encodeURIComponent(project)}`, { replace: true });
  }, [sidFromUrl, project, canvas, navigate, location.state]);

  // Landed here from the directory picker OR the Demos gallery: a cwd or
  // seed prompt is staged for this project but no session exists yet.
  // Auto-open a draft tile so the chosen folder / demo drops straight into
  // a composer — but only once per project. The pending state lingers until
  // the first successful send, so without this guard a user who dismisses
  // the draft (×) would have it re-added on the next render.
  const autoDrafted = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (autoDrafted.current.has(project)) return;
    if (!peekPendingCwd(project) && !peekPendingPrompt(project)) return;
    if (canvas.tiles.some((t) => isDraftSid(t.sid))) return;
    autoDrafted.current.add(project);
    canvas.addDraft();
  }, [project, canvas]);

  const name = workspace?.name || basename(workspace?.cwd || '') || project;

  // "+ New Session" now just adds an empty draft tile — the user types the
  // first prompt inside the tile's own composer. The draft's sid is swapped
  // for the real one once the server assigns it (see promoteDraft below).
  const handleNewSession = () => {
    canvas.addDraft();
  };

  // Called by a draft tile's Session when startNewSession returns a real
  // sid. We swap the draft sentinel in place and mark the new sid as
  // "pending" so the tile's next mount subscribes to the liveStore stream
  // instead of racing to GET the (not-yet-flushed) jsonl.
  const handleDraftPromoted = useCallback(
    (newSid: string) => {
      setPendingSids((cur) => {
        if (cur.has(newSid)) return cur;
        const next = new Set(cur);
        next.add(newSid);
        return next;
      });
      canvas.promoteDraft(newSid);
      // Refresh the session list in the background so the sidebar picks up
      // the new entry once the jsonl exists.
      load();
    },
    [canvas, load],
  );

  const clearPending = useCallback((sid: string) => {
    setPendingSids((cur) => {
      if (!cur.has(sid)) return cur;
      const next = new Set(cur);
      next.delete(sid);
      return next;
    });
  }, []);

  // dnd-kit reorder. rectSortingStrategy handles multi-column grids; the
  // sortable transform + transition on each tile give the FLIP animation
  // as siblings slide into place. Pointer sensor with a 6px activation
  // distance keeps the resize handle click from starting a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const sids = useMemo(() => canvas.tiles.map((t) => t.sid), [canvas.tiles]);

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = sids.indexOf(String(active.id));
    const to = sids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    canvas.reorder(from, to);
  };

  // Pointer-driven resize on the SE handle. dnd-kit doesn't cover resizing
  // — we bind pointermove/pointerup to `window` so the drag survives past
  // the tile bounds. Grid geometry (`colPx`) is captured at drag start.
  const startResize = (sid: string, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const tile = canvas.tiles.find((t) => t.sid === sid);
    if (!tile) return;
    const grid = gridRef.current;
    if (!grid) return;
    const gridRect = grid.getBoundingClientRect();
    const gapPx = 12;
    const colPx = (gridRect.width - gapPx * (CANVAS_COLS - 1)) / CANVAS_COLS;
    resizeRef.current = {
      sid,
      startX: e.clientX,
      startY: e.clientY,
      startColSpan: tile.colSpan,
      startRowSpan: tile.rowSpan,
      colPx,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    window.addEventListener('pointermove', onResizeMove);
    window.addEventListener('pointerup', onResizeEnd, { once: true });
  };

  const onResizeMove = useCallback(
    (e: PointerEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const dxCols = Math.round((e.clientX - r.startX) / (r.colPx + 12));
      const dyRows = Math.round((e.clientY - r.startY) / (ROW_UNIT_PX + 12));
      const nextCol = Math.max(MIN_COL_SPAN, Math.min(MAX_COL_SPAN, r.startColSpan + dxCols));
      const nextRow = Math.max(MIN_ROW_SPAN, Math.min(MAX_ROW_SPAN, r.startRowSpan + dyRows));
      canvas.resize(r.sid, { colSpan: nextCol, rowSpan: nextRow });
    },
    [canvas],
  );

  const onResizeEnd = useCallback(() => {
    resizeRef.current = null;
    window.removeEventListener('pointermove', onResizeMove);
  }, [onResizeMove]);

  if (error) {
    return (
      <section className="view">
        <div className="placeholder">Error: {error}</div>
      </section>
    );
  }

  if (!sessions) {
    return (
      <section className="view">
        <div className="muted">Loading…</div>
      </section>
    );
  }

  return (
    <section className="ws-canvas-v2">
      <header className="ws-canvas-head">
        <div className="ws-canvas-title">
          <span className="ws-canvas-name">{name}</span>
          <span className="ws-canvas-meta">
            {canvas.tiles.length} pinned · {sessions.length} in workspace
          </span>
        </div>
        <div className="ws-canvas-actions">
          <button className="ghost small ws-canvas-action" onClick={() => setGitOpen(true)} title="Source control">
            <GitBranch size={14} aria-hidden="true" />
            <span>Git</span>
          </button>
          <button className="ghost small ws-canvas-action" onClick={() => canvas.addTerminal()} title="Open terminal">
            <SquareTerminal size={14} aria-hidden="true" />
            <span>Terminal</span>
          </button>
          <button className="ghost small ws-canvas-action" onClick={() => setFilesOpen(true)} title="Browse files">
            <FolderOpen size={14} aria-hidden="true" />
            <span>Files</span>
          </button>
          <button className="ghost small ws-canvas-action" onClick={handleNewSession} title="New session">
            <Plus size={14} aria-hidden="true" />
            <span>Session</span>
          </button>
        </div>
      </header>

      {gitOpen && <GitPanel project={project} onClose={() => setGitOpen(false)} />}

      <div className={'ws-canvas-body' + (filesOpen ? ' with-files' : '')}>
        {filesOpen && (
          <FilesPanel
            project={project}
            onClose={() => setFilesOpen(false)}
            focusedPath={canvas.focusedSid && isFileSid(canvas.focusedSid) ? filePath(canvas.focusedSid) : ''}
            onOpen={(p) => {
              canvas.addFile(p);
              // A phone-sized canvas needs the full width for the artifact.
              if (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches) setFilesOpen(false);
            }}
          />
        )}
        <div className="ws-canvas-main">
      {canvas.tiles.length === 0 ? (
        <div className="ws-canvas-empty">
          <p>Canvas is empty.</p>
          <p className="muted">
            Pick sessions from the sidebar (hover a session and click <code>+</code>) or
            start a new one.
          </p>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={sids} strategy={rectSortingStrategy}>
            <div
              className="ws-canvas-grid-v2"
              ref={gridRef}
              style={{
                gridTemplateColumns: `repeat(${CANVAS_COLS}, 1fr)`,
                gridAutoRows: `${ROW_UNIT_PX}px`,
              }}
            >
              {canvas.tiles.map((tile) => {
                const draft = isDraftSid(tile.sid);
                const terminal = isTerminalSid(tile.sid);
                const file = isFileSid(tile.sid);
                const meta = draft || terminal || file ? undefined : sessions.find((x) => x.sessionId === tile.sid);
                const isFocused = canvas.focusedSid === tile.sid;
                const label = draft
                  ? 'New session'
                  : terminal
                    ? 'Terminal'
                    : file
                      ? filePath(tile.sid).split('/').pop() || 'File'
                      : meta ? sessionTitle(meta) : tile.sid.slice(0, 8);
                return (
                  <SortableTile
                    key={tile.sid}
                    tile={tile}
                    label={label}
                    isFocused={isFocused}
                    project={project}
                    isDraft={draft}
                    isTerminal={terminal}
                    isFile={file}
                    initialPending={pendingSids.has(tile.sid)}
                    onPendingConsumed={() => clearPending(tile.sid)}
                    onCreated={handleDraftPromoted}
                    onFocus={() => canvas.focus(tile.sid)}
                    onRemove={() => {
                      if (terminal) killTerminal(project, tile.sid);
                      canvas.remove(tile.sid);
                    }}
                    onDelete={draft || terminal || file ? undefined : () => {
                      // Same "delete the underlying session + unpin" flow
                      // as the sidebar's Delete Session context menu — kept
                      // reachable from the tile too so a user working on
                      // the canvas doesn't have to hunt in the sidebar.
                      void (async () => {
                        try {
                          await api.deleteSession(project, tile.sid);
                          canvas.remove(tile.sid);
                          load();
                        } catch {
                          // swallow — the caller (Workspace) already
                          // surfaces API errors via top-level `error`.
                        }
                      })();
                    }}
                    onResizeStart={(e) => startResize(tile.sid, e)}
                  />
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      )}
        </div>
      </div>
    </section>
  );
}

// Individual sortable tile. Wraps Session in a grid item that responds to
// dnd-kit's drag transform. The whole grip bar is the drag handle; the SE
// corner is the resize handle.
function SortableTile({
  tile,
  label,
  isFocused,
  project,
  isDraft,
  isTerminal,
  isFile,
  initialPending,
  onPendingConsumed,
  onCreated,
  onFocus,
  onRemove,
  onDelete,
  onResizeStart,
}: {
  tile: TileGeom;
  label: string;
  isFocused: boolean;
  project: string;
  isDraft: boolean;
  isTerminal: boolean;
  isFile: boolean;
  initialPending: boolean;
  onPendingConsumed: () => void;
  onCreated: (newSid: string) => void;
  onFocus: () => void;
  onRemove: () => void;
  /** Delete the underlying session (jsonl) and unpin. Omitted for drafts
   *  and terminals — those have nothing on disk to delete. */
  onDelete?: () => void;
  onResizeStart: (e: React.PointerEvent) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tile.sid });
  // Incremented by the tile's refresh button — Session watches this prop
  // and re-runs its jsonl load, saving us from cross-component refs.
  const [refreshKey, setRefreshKey] = useState(0);
  // Flipped by Session while a turn is streaming — drives the flowing-light
  // border animation so a running tile stands out on a busy canvas.
  const [isRunning, setIsRunning] = useState(false);
  const confirm = useConfirm();
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const setRef = useCallback(
    (n: HTMLDivElement | null) => {
      nodeRef.current = n;
      setNodeRef(n);
    },
    [setNodeRef],
  );

  // Sidebar → tile focus intent. Scrolls this tile into view and focuses
  // its composer textarea when a matching event fires. Uses querySelector
  // rather than an imperative handle since Session already lives behind
  // props — simpler and one-shot.
  useEffect(() => {
    const onFocusEvent = (ev: Event) => {
      const d = (ev as CustomEvent<{ project: string; sid: string }>).detail;
      if (!d || d.project !== project || d.sid !== tile.sid) return;
      const node = nodeRef.current;
      if (!node) return;
      node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      // Delay the focus until after the input-area expansion transition
      // (grid-template-rows 300ms) — otherwise the textarea's caret jumps
      // while the container is still animating open.
      window.setTimeout(() => {
        const ta = node.querySelector<HTMLTextAreaElement>('.session-input textarea');
        ta?.focus();
      }, 320);
    };
    window.addEventListener('macaron:focus-tile', onFocusEvent);
    return () => window.removeEventListener('macaron:focus-tile', onFocusEvent);
  }, [project, tile.sid]);

  const style: React.CSSProperties = {
    gridColumn: `span ${tile.colSpan}`,
    gridRow: `span ${tile.rowSpan}`,
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 5 : undefined,
    opacity: isDragging ? 0.85 : 1,
  };

  const copyResume = () => {
    void navigator.clipboard.writeText(`claude --resume ${tile.sid}`);
  };

  return (
    <div
      ref={setRef}
      className={`ws-tile${isFocused ? ' focused' : ''}${isDragging ? ' dragging' : ''}${isRunning ? ' running' : ''}`}
      style={style}
      role="group"
      tabIndex={0}
      aria-label={`${isFile ? 'File' : isTerminal ? 'Terminal' : 'Session'}: ${label}`}
      onClick={() => {
        if (!isFocused) onFocus();
      }}
      onFocus={() => {
        if (!isFocused) onFocus();
      }}
    >
      {isRunning && (
        <div className="ws-tile-running-bar" aria-hidden>
          {/* Indeterminate progress bead — CSS handles the slide. Sits
              on top of the grip bar so it's visible even when the tile
              is scrolled to the top. */}
        </div>
      )}
      <div className="ws-tile-grip" {...attributes} {...listeners} title="Drag to reorder">
        <span className="ws-tile-grip-dots" aria-hidden="true"><GripVertical size={14} /></span>
        <span className="ws-tile-grip-label">
          {isFile ? (
            <span className="ws-tile-kind"><FileText size={13} aria-hidden="true" /> File</span>
          ) : label}
        </span>
        {!isDraft && !isTerminal && !isFile && (
        <button
          className="ws-tile-action"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            copyResume();
          }}
          title="Copy claude --resume command"
          aria-label="Copy resume command"
        >
          <Copy size={13} strokeWidth={2} aria-hidden="true" />
        </button>
        )}
        {!isDraft && !isTerminal && !isFile && (
        <button
          className="ws-tile-action"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (isRunning) return;
            setRefreshKey((k) => k + 1);
          }}
          title="Refresh"
          aria-label="Refresh"
          disabled={isRunning}
        >
          <RefreshCw size={13} strokeWidth={2} aria-hidden="true" />
        </button>
        )}
        {onDelete && (
          <button
            className="ws-tile-action ws-tile-delete"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={async (e) => {
              e.stopPropagation();
              const ok = await confirm({
                title: 'Delete session?',
                body: (
                  <>
                    Session <code>{tile.sid.slice(0, 8)}</code> will be removed
                    from the canvas and its jsonl file will be deleted on disk.
                    This can't be undone.
                  </>
                ),
                confirmLabel: 'Delete',
                destructive: true,
              });
              if (ok) onDelete();
            }}
            title="Delete session (removes jsonl on disk)"
            aria-label="Delete session"
          >
            <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
        <button
          className="ws-tile-x"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          title="Remove from canvas (does not delete the session)"
          aria-label="Remove from canvas"
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>
      <div className="ws-tile-body">
        {isTerminal ? (
          <Terminal project={project} sid={tile.sid} focused={isFocused} />
        ) : isFile ? (
          <FileTile
            project={project}
            path={filePath(tile.sid)}
            focused={isFocused}
            refreshKey={refreshKey}
          />
        ) : (
          <Session
            project={project}
            // A draft tile has no real sid yet — Session's `isNew` branch is
            // driven by `!sid`, so pass an empty string until promoteDraft
            // swaps the sentinel for a real id (this whole tile then remounts
            // with the real sid + `initialPending`).
            sid={isDraft ? '' : tile.sid}
            focused={isFocused}
            onFocus={onFocus}
            hideBar
            refreshKey={refreshKey}
            onSendingChange={setIsRunning}
            initialPending={initialPending}
            onPendingConsumed={onPendingConsumed}
            onCreated={onCreated}
          />
        )}
      </div>
      <div
        className="ws-tile-resize"
        onPointerDown={onResizeStart}
        title="Drag to resize"
      />
    </div>
  );
}
