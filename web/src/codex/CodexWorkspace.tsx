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
import { Copy, RefreshCw, X } from 'lucide-react';
import { codexApi, type CodexThread, type CodexWorkspace as Wk } from './api';
import { CodexChat } from './CodexChat';
import {
  useCanvas,
  CANVAS_COLS,
  MIN_COL_SPAN,
  MAX_COL_SPAN,
  MIN_ROW_SPAN,
  MAX_ROW_SPAN,
  type TileGeom,
} from '../lib/canvas';
import { subscribeSystemEvents } from '../lib/systemEvents';
import { sessionTitle } from '../lib/api';

const ROW_UNIT_PX = 48;

type ResizeState = {
  sid: string;
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
    const dxCols = Math.round((e.clientX - r.startX) / (r.colPx + 12));
    const dyRows = Math.round((e.clientY - r.startY) / (ROW_UNIT_PX + 12));
    const nextCol = Math.max(MIN_COL_SPAN, Math.min(MAX_COL_SPAN, r.startColSpan + dxCols));
    const nextRow = Math.max(MIN_ROW_SPAN, Math.min(MAX_ROW_SPAN, r.startRowSpan + dyRows));
    canvas.resize(r.sid, { colSpan: nextCol, rowSpan: nextRow });
  }, [canvas]);

  const onResizeEnd = useCallback(() => {
    resizeRef.current = null;
    window.removeEventListener('pointermove', onResizeMove);
  }, [onResizeMove]);

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
      </header>

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
                const meta = sessions.find((x) => x.sessionId === tile.sid);
                const isFocused = canvas.focusedSid === tile.sid;
                return (
                  <SortableTile
                    key={tile.sid}
                    tile={tile}
                    label={meta ? sessionTitle(meta) : tile.sid.slice(0, 8)}
                    isFocused={isFocused}
                    onFocus={() => canvas.focus(tile.sid)}
                    onRemove={() => canvas.remove(tile.sid)}
                    onResizeStart={(e) => startResize(tile.sid, e)}
                  />
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </section>
  );
}

function SortableTile({
  tile,
  label,
  isFocused,
  onFocus,
  onRemove,
  onResizeStart,
}: {
  tile: TileGeom;
  label: string;
  isFocused: boolean;
  onFocus: () => void;
  onRemove: () => void;
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
        <CodexChat
          sid={tile.sid}
          focused={isFocused}
          hideBar
          refreshKey={refreshKey}
          onSendingChange={setIsRunning}
        />
      </div>
      <div
        className="cx-tile-resize"
        onPointerDown={onResizeStart}
        title="Drag to resize"
        aria-label="Resize"
      />
    </div>
  );
}
