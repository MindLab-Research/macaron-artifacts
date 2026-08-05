// Codex workspace canvas — port of Workspace.tsx into the codex namespace.
// Same dnd-kit sortable grid, same pointer-driven SE resize, same tile
// grip / running progress bar / focus-only composer animation. Backed by
// codexApi (workspaces/threads) instead of the claude namespace.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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
import { Copy, FolderOpen, GitBranch, GitPullRequest, Plus, RefreshCw, SquareTerminal, X } from 'lucide-react';
import { codexApi, type CodexThread, type CodexWorkspace as Wk } from './api';
import { CodexChat } from './CodexChat';
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
import { subscribeSystemEvents } from '../lib/systemEvents';
import { sessionTitle } from '../lib/api';
import { FilesPanel } from '../components/FilesPanel';
import { FileTile } from '../components/FileTile';
import { isFileSid, filePath } from '../lib/fileTile';
import { GitPanel } from '../components/GitPanel';
import { Terminal } from '../components/Terminal';
import { isTerminalSid, killTerminal } from '../lib/terminal';
import { CreatePrDialog } from '../components/CreatePrDialog';
import { api, type PrContext } from '../lib/api';
import { useToast } from '../components/Toast';

const ROW_UNIT_PX = 48;

// Edge / corner the user grabbed. Sign of dx / dy for each axis is derived
// from the letters — 'w' inverts dx, 'n' inverts dy, absence means that axis
// doesn't participate for this handle.
type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

type ResizeState = {
  sid: string;
  edge: ResizeEdge;
  startX: number;
  startY: number;
  startColSpan: number;
  startRowSpan: number;
  colPx: number;
};

function basename(p: string): string {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

export function CodexWorkspace() {
  const { project = '', sid: sidFromUrl = '' } = useParams();
  const navigate = useNavigate();
  const [workspace, setWorkspace] = useState<Wk | null>(null);
  const [sessions, setSessions] = useState<CodexThread[] | null>(null);
  const [error, setError] = useState('');
  const [filesOpen, setFilesOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [prDialog, setPrDialog] = useState<{ ctx: PrContext; title: string; body: string; busy: boolean } | null>(null);
  const toast = useToast();
  const canvas = useCanvas(project);
  const gridRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<ResizeState | null>(null);

  const load = useCallback(() => {
    codexApi
      .workspace(project)
      .then((d) => {
        setWorkspace(d.workspace);
        setSessions(d.sessions);
      })
      .catch((e) => setError((e as Error).message));
  }, [project]);

  useEffect(() => {
    setWorkspace(null);
    setSessions(null);
    load();
    const t = setInterval(load, 15_000);
    // Live-refresh on a codex disk change (e.g. a terminal-started rollout in
    // this workspace) so the list picks up external sessions without a manual
    // refresh — mirrors the claude Workspace. Interval stays as a fallback.
    const unsub = subscribeSystemEvents((ev) => {
      if (ev.engine === 'codex') load();
    });
    return () => {
      clearInterval(t);
      unsub();
    };
  }, [project, load]);

  // Deep-link support: /w/:project/t/:sid pins + focuses, then rewrites URL.
  useEffect(() => {
    if (!sidFromUrl) return;
    if (!canvas.isOnCanvas(sidFromUrl)) canvas.add(sidFromUrl);
    canvas.focus(sidFromUrl);
    navigate(`/w/${encodeURIComponent(project)}`, { replace: true });
  }, [sidFromUrl, project, canvas, navigate]);

  const name = workspace?.name || basename(workspace?.cwd || '') || project;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const sids = useMemo(() => canvas.tiles.map((t) => t.sid), [canvas.tiles]);

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = sids.indexOf(String(active.id));
    const to = sids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    canvas.reorder(from, to);
  };

  const onResizeMove = useCallback((e: PointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    // W/N edges flip the sign so dragging outward always grows the tile and
    // inward shrinks it; E/S handles grow/shrink in the natural direction.
    const dxSign = r.edge.includes('w') ? -1 : r.edge.includes('e') ? 1 : 0;
    const dySign = r.edge.includes('n') ? -1 : r.edge.includes('s') ? 1 : 0;
    const dCols = Math.round(((e.clientX - r.startX) * dxSign) / (r.colPx + 12));
    const dRows = Math.round(((e.clientY - r.startY) * dySign) / (ROW_UNIT_PX + 12));
    const nextCol = dxSign === 0 ? r.startColSpan : Math.max(MIN_COL_SPAN, Math.min(MAX_COL_SPAN, r.startColSpan + dCols));
    const nextRow = dySign === 0 ? r.startRowSpan : Math.max(MIN_ROW_SPAN, Math.min(MAX_ROW_SPAN, r.startRowSpan + dRows));
    canvas.resize(r.sid, { colSpan: nextCol, rowSpan: nextRow });
  }, [canvas]);

  const onResizeEnd = useCallback(() => {
    resizeRef.current = null;
    window.removeEventListener('pointermove', onResizeMove);
  }, [onResizeMove]);

  const startResize = (sid: string, edge: ResizeEdge, e: React.PointerEvent) => {
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
      edge,
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

  if (error) return <div className="cx-canvas-error">Error: {error}</div>;
  if (!sessions) return <div className="cx-canvas-loading">Loading…</div>;

  return (
    <section className="cx-canvas">
      <header className="cx-canvas-head">
        <div className="cx-canvas-title">
          <span className="cx-canvas-name">{name}</span>
          <span className="cx-canvas-meta">
            {canvas.tiles.length} pinned · {sessions.length} in workspace
          </span>
        </div>
        <div className="cx-canvas-actions">
          <button
            type="button"
            className={'cx-canvas-action' + (gitOpen ? ' active' : '')}
            onClick={() => setGitOpen((v) => !v)}
            title={gitOpen ? 'Close source control' : 'Source control'}
          >
            <GitBranch size={14} aria-hidden="true" />
            <span>Git</span>
          </button>
          <button
            type="button"
            className="cx-canvas-action"
            onClick={async () => {
              try {
                const ctx = await api.prContextForProject(project);
                setPrDialog({ ctx, title: '', body: '', busy: false });
              } catch (e) {
                toast(`PR context failed: ${(e as Error).message}`);
              }
            }}
            title="Open a pull request from this workspace"
          >
            <GitPullRequest size={14} aria-hidden="true" />
            <span>PR</span>
          </button>
          <button
            type="button"
            className="cx-canvas-action"
            onClick={() => canvas.addTerminal()}
            title="Pin a terminal to the canvas"
          >
            <SquareTerminal size={14} aria-hidden="true" />
            <span>Terminal</span>
          </button>
          <button
            type="button"
            className={'cx-canvas-action' + (filesOpen ? ' active' : '')}
            onClick={() => setFilesOpen((v) => !v)}
            title={filesOpen ? 'Close files panel' : 'Browse files in this workspace'}
          >
            <FolderOpen size={14} aria-hidden="true" />
            <span>Files</span>
          </button>
          <button
            type="button"
            className="cx-canvas-action"
            onClick={() => canvas.addDraft()}
            title="Start a new thread in this workspace"
          >
            <Plus size={14} aria-hidden="true" />
            <span>Thread</span>
          </button>
        </div>
      </header>

      {gitOpen && <GitPanel project={project} onClose={() => setGitOpen(false)} />}

      {prDialog && (
        <CreatePrDialog
          ctx={prDialog.ctx}
          initialTitle={prDialog.title}
          initialBody={prDialog.body}
          busy={prDialog.busy}
          onCancel={() => setPrDialog(null)}
          onSubmit={async (input) => {
            setPrDialog((cur) => (cur ? { ...cur, busy: true } : cur));
            try {
              const r = await api.createPrForProject(project, input);
              toast(r.created ? 'Pull request opened' : 'PR already exists — opening it');
              window.open(r.url, '_blank', 'noopener,noreferrer');
              setPrDialog(null);
            } catch (e) {
              toast(`PR failed: ${(e as Error).message}`);
              setPrDialog((cur) => (cur ? { ...cur, busy: false } : cur));
            }
          }}
        />
      )}

      <div className={'cx-canvas-body' + (filesOpen ? ' with-files' : '')}>
        {filesOpen && (
          <FilesPanel
            project={project}
            onClose={() => setFilesOpen(false)}
            focusedPath={canvas.focusedSid && isFileSid(canvas.focusedSid) ? filePath(canvas.focusedSid) : ''}
            onOpen={(p) => {
              canvas.addFile(p);
              if (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches) setFilesOpen(false);
            }}
          />
        )}
        <div className="cx-canvas-main">
      {canvas.tiles.length === 0 ? (
        <div className="cx-canvas-empty">
          <p>Canvas is empty.</p>
          <p className="muted">
            Pick threads from the sidebar (click one to pin it) or start a
            new one.
          </p>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={sids} strategy={rectSortingStrategy}>
            <div
              className="cx-canvas-grid"
              ref={gridRef}
              style={{
                gridTemplateColumns: `repeat(${CANVAS_COLS}, 1fr)`,
                gridAutoRows: `${ROW_UNIT_PX}px`,
              }}
            >
              {canvas.tiles.map((tile) => {
                const file = isFileSid(tile.sid);
                const terminal = isTerminalSid(tile.sid);
                const draft = isDraftSid(tile.sid);
                const meta = file || terminal || draft ? undefined : sessions.find((x) => x.sessionId === tile.sid);
                const isFocused = canvas.focusedSid === tile.sid;
                const label = draft
                  ? 'New thread'
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
                    isFile={file}
                    isTerminal={terminal}
                    isDraft={draft}
                    onDraftPromoted={(newSid) => {
                      canvas.promoteDraft(newSid);
                      load();
                    }}
                    onFocus={() => canvas.focus(tile.sid)}
                    onRemove={() => {
                      if (terminal) killTerminal(project, tile.sid);
                      canvas.remove(tile.sid);
                    }}
                    onResizeStart={(edge, e) => startResize(tile.sid, edge, e)}
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

function SortableTile({
  tile,
  label,
  isFocused,
  project,
  isFile,
  isTerminal,
  isDraft,
  onDraftPromoted,
  onFocus,
  onRemove,
  onResizeStart,
}: {
  tile: TileGeom;
  label: string;
  isFocused: boolean;
  project: string;
  isFile: boolean;
  isTerminal: boolean;
  isDraft: boolean;
  onDraftPromoted: (newSid: string) => void;
  onFocus: () => void;
  onRemove: () => void;
  onResizeStart: (edge: ResizeEdge, e: React.PointerEvent) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tile.sid });
  const [isRunning, setIsRunning] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const style: React.CSSProperties = {
    gridColumn: `span ${tile.colSpan}`,
    gridRow: `span ${tile.rowSpan}`,
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 5 : undefined,
    opacity: isDragging ? 0.85 : 1,
  };

  const copyResume = () => {
    void navigator.clipboard.writeText(`codex resume ${tile.sid}`);
  };

  return (
    <div
      ref={setNodeRef}
      className={`cx-tile${isFocused ? ' focused' : ''}${isDragging ? ' dragging' : ''}${isRunning ? ' running' : ''}`}
      style={style}
      onClick={() => { if (!isFocused) onFocus(); }}
    >
      {isRunning && <div className="cx-tile-runbar" aria-hidden />}
      <div className="cx-tile-grip" {...attributes} {...listeners} title="Drag to reorder">
        <span className="cx-tile-grip-dots">⋮⋮</span>
        <span className="cx-tile-grip-label">{label}</span>
        {!isFile && !isTerminal && !isDraft && (
          <button
            type="button"
            className="cx-tile-action"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); copyResume(); }}
            title="Copy `codex resume` command"
            aria-label="Copy resume command"
          >
            <Copy size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="cx-tile-action"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); setRefreshKey((k) => k + 1); }}
          title="Refresh"
          aria-label="Refresh"
        >
          <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="cx-tile-action cx-tile-action-danger"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          title="Remove from canvas"
          aria-label="Remove from canvas"
        >
          <X size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      <div className="cx-tile-body">
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
          <CodexChat
            // Draft tiles carry the sentinel sid; passing '' flips CodexChat
            // into `isNew` mode so the composer starts a fresh thread. Real
            // sid takes over once onCreated fires and the parent promotes.
            sid={isDraft ? '' : tile.sid}
            focused={isFocused}
            hideBar
            refreshKey={refreshKey}
            onSendingChange={setIsRunning}
            onCreated={isDraft ? onDraftPromoted : undefined}
          />
        )}
      </div>
      {/* Edge + corner resize handles. Each handle stops event propagation so
          dnd-kit doesn't start a reorder drag when the user grabs an edge. */}
      <div className="cx-tile-edge n" onPointerDown={(e) => onResizeStart('n', e)} title="Drag to resize" aria-label="Resize top" />
      <div className="cx-tile-edge s" onPointerDown={(e) => onResizeStart('s', e)} title="Drag to resize" aria-label="Resize bottom" />
      <div className="cx-tile-edge e" onPointerDown={(e) => onResizeStart('e', e)} title="Drag to resize" aria-label="Resize right" />
      <div className="cx-tile-edge w" onPointerDown={(e) => onResizeStart('w', e)} title="Drag to resize" aria-label="Resize left" />
      <div className="cx-tile-corner nw" onPointerDown={(e) => onResizeStart('nw', e)} aria-label="Resize top-left" />
      <div className="cx-tile-corner ne" onPointerDown={(e) => onResizeStart('ne', e)} aria-label="Resize top-right" />
      <div className="cx-tile-corner sw" onPointerDown={(e) => onResizeStart('sw', e)} aria-label="Resize bottom-left" />
      <div className="cx-tile-corner se cx-tile-resize" onPointerDown={(e) => onResizeStart('se', e)} title="Drag to resize" aria-label="Resize bottom-right" />
    </div>
  );
}
