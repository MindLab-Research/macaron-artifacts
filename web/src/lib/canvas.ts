// Per-workspace canvas state: pinned tiles with their grid geometry +
// which one has visual focus. Persisted to localStorage per project.
//
// Geometry model: a fixed 12-column CSS grid with row cells sized in units
// of `--tile-row-h` (default ~48px). Each tile carries an integer colSpan
// (1–12) and rowSpan (1–20). Auto-flow places tiles in order; a resize
// nudges the numbers, an animation smooths the transition.

import { useCallback, useEffect, useRef, useState } from 'react';
import { newTerminalSid } from './terminal';
import { newFileSid } from './fileTile';

export type TileGeom = { sid: string; colSpan: number; rowSpan: number };

export const CANVAS_COLS = 12;
// New tiles fill the canvas end-to-end by default; users resize down when
// they want two tiles side-by-side. Persisted layouts keep their per-tile
// colSpan from localStorage, so this only affects freshly added tiles.
export const DEFAULT_COL_SPAN = 12;
export const DEFAULT_ROW_SPAN = 10;  // ~480px tall by default
export const MIN_COL_SPAN = 3;
export const MAX_COL_SPAN = 12;
export const MIN_ROW_SPAN = 4;
export const MAX_ROW_SPAN = 24;

// A "draft" tile — a placeholder placed on the canvas BEFORE a real session
// exists. The user types into it, and once the server assigns a real
// sessionId, `promoteDraft(realSid)` swaps this sentinel for the real id in
// place. Only one draft can exist per workspace at a time.
export const DRAFT_SID = '__draft__';
export function isDraftSid(sid: string): boolean {
  return sid === DRAFT_SID;
}

type CanvasState = {
  tiles: TileGeom[];
  focusedSid: string | null;
};

const STORAGE_PREFIX = 'macaron.canvas.';

function storageKey(project: string): string {
  return STORAGE_PREFIX + project;
}

function loadCanvas(project: string): CanvasState {
  try {
    const raw = localStorage.getItem(storageKey(project));
    if (!raw) return { tiles: [], focusedSid: null };
    const j = JSON.parse(raw) as Partial<CanvasState> & { sids?: string[] };
    // Back-compat: earlier versions stored `sids: string[]`. Convert.
    if (Array.isArray(j.sids) && !Array.isArray(j.tiles)) {
      return {
        tiles: j.sids
          .filter((s): s is string => typeof s === 'string')
          .map((sid) => ({ sid, colSpan: DEFAULT_COL_SPAN, rowSpan: DEFAULT_ROW_SPAN })),
        focusedSid: typeof j.focusedSid === 'string' ? j.focusedSid : null,
      };
    }
    const tiles = Array.isArray(j.tiles)
      ? j.tiles
          .filter((t): t is TileGeom => Boolean(t) && typeof (t as TileGeom).sid === 'string')
          .map((t) => ({
            sid: t.sid,
            colSpan: clamp(t.colSpan ?? DEFAULT_COL_SPAN, MIN_COL_SPAN, MAX_COL_SPAN),
            rowSpan: clamp(t.rowSpan ?? DEFAULT_ROW_SPAN, MIN_ROW_SPAN, MAX_ROW_SPAN),
          }))
      : [];
    return {
      tiles,
      focusedSid: typeof j.focusedSid === 'string' ? j.focusedSid : null,
    };
  } catch {
    return { tiles: [], focusedSid: null };
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function saveCanvas(project: string, state: CanvasState): void {
  try {
    localStorage.setItem(storageKey(project), JSON.stringify(state));
  } catch {
    /* quota exceeded / disabled — silently ignore */
  }
}

const listeners = new Map<string, Set<() => void>>();
function notify(project: string): void {
  listeners.get(project)?.forEach((cb) => cb());
}

// Plain helpers for callers that iterate over many workspaces (sidebar) —
// they can't call the hook once per project. Reads localStorage directly.
export function getCanvasSids(project: string): string[] {
  return loadCanvas(project).tiles.map((t) => t.sid);
}

export function toggleCanvasSid(project: string, sid: string): void {
  const cur = loadCanvas(project);
  const has = cur.tiles.some((t) => t.sid === sid);
  const next: CanvasState = has
    ? (() => {
        const tiles = cur.tiles.filter((t) => t.sid !== sid);
        const focusedSid =
          cur.focusedSid === sid ? tiles[0]?.sid || null : cur.focusedSid;
        return { tiles, focusedSid };
      })()
    : {
        tiles: [
          ...cur.tiles,
          { sid, colSpan: DEFAULT_COL_SPAN, rowSpan: DEFAULT_ROW_SPAN },
        ],
        focusedSid: cur.focusedSid || sid,
      };
  saveCanvas(project, next);
  notify(project);
}

// Plain (non-hook) draft insert for callers outside a Workspace render —
// e.g. the command palette's "New Session". Mirrors the hook's addDraft:
// prepend the sentinel + focus it, or just refocus an existing draft.
export function addDraftSid(project: string): void {
  const cur = loadCanvas(project);
  if (cur.tiles.some((t) => t.sid === DRAFT_SID)) {
    if (cur.focusedSid !== DRAFT_SID) {
      saveCanvas(project, { ...cur, focusedSid: DRAFT_SID });
      notify(project);
    }
    return;
  }
  saveCanvas(project, {
    tiles: [{ sid: DRAFT_SID, colSpan: DEFAULT_COL_SPAN, rowSpan: DEFAULT_ROW_SPAN }, ...cur.tiles],
    focusedSid: DRAFT_SID,
  });
  notify(project);
}

// Remove a sid from the canvas without adding it if absent. Used by callers
// that already know they want it gone (e.g. sidebar's "Delete Session"
// context menu — the session's jsonl is being deleted, so the pinned tile
// must go too or it'd render a Session that 404s forever).
export function removeCanvasSid(project: string, sid: string): void {
  const cur = loadCanvas(project);
  if (!cur.tiles.some((t) => t.sid === sid)) return;
  const tiles = cur.tiles.filter((t) => t.sid !== sid);
  const focusedSid = cur.focusedSid === sid ? tiles[0]?.sid || null : cur.focusedSid;
  saveCanvas(project, { tiles, focusedSid });
  notify(project);
}

export function focusCanvasSid(project: string, sid: string): void {
  const cur = loadCanvas(project);
  if (!cur.tiles.some((t) => t.sid === sid)) return;
  if (cur.focusedSid === sid) return;
  saveCanvas(project, { ...cur, focusedSid: sid });
  notify(project);
}

export function subscribeCanvas(project: string, cb: () => void): () => void {
  let set = listeners.get(project);
  if (!set) {
    set = new Set();
    listeners.set(project, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) listeners.delete(project);
  };
}

export function useCanvas(project: string): {
  tiles: TileGeom[];
  focusedSid: string | null;
  isOnCanvas: (sid: string) => boolean;
  add: (sid: string) => void;
  remove: (sid: string) => void;
  toggle: (sid: string) => void;
  reorder: (fromIdx: number, toIdx: number) => void;
  resize: (sid: string, patch: { colSpan?: number; rowSpan?: number }) => void;
  focus: (sid: string) => void;
  addDraft: () => void;
  addTerminal: () => void;
  addFile: (path: string) => void;
  promoteDraft: (realSid: string) => void;
} {
  const [state, setState] = useState<CanvasState>(() => loadCanvas(project));
  const stateRef = useRef(state);

  useEffect(() => {
    const sync = () => {
      const next = loadCanvas(project);
      stateRef.current = next;
      setState(next);
    };
    sync();
    let set = listeners.get(project);
    if (!set) {
      set = new Set();
      listeners.set(project, set);
    }
    set.add(sync);
    return () => {
      set!.delete(sync);
      if (set!.size === 0) listeners.delete(project);
    };
  }, [project]);

  const update = useCallback(
    (patch: (cur: CanvasState) => CanvasState) => {
      const cur = stateRef.current;
      const next = patch(cur);
      if (next === cur) return;
      stateRef.current = next;
      saveCanvas(project, next);
      setState(next);
      notify(project);
    },
    [project],
  );

  const isOnCanvas = useCallback(
    (sid: string) => state.tiles.some((t) => t.sid === sid),
    [state.tiles],
  );

  const add = useCallback(
    (sid: string) => {
      update((cur) => {
        if (cur.tiles.some((t) => t.sid === sid)) return cur;
        return {
          tiles: [
            ...cur.tiles,
            { sid, colSpan: DEFAULT_COL_SPAN, rowSpan: DEFAULT_ROW_SPAN },
          ],
          focusedSid: cur.focusedSid || sid,
        };
      });
    },
    [update],
  );

  const remove = useCallback(
    (sid: string) => {
      update((cur) => {
        const tiles = cur.tiles.filter((t) => t.sid !== sid);
        const focusedSid =
          cur.focusedSid === sid ? tiles[0]?.sid || null : cur.focusedSid;
        return { tiles, focusedSid };
      });
    },
    [update],
  );

  const toggle = useCallback(
    (sid: string) => {
      update((cur) => {
        if (cur.tiles.some((t) => t.sid === sid)) {
          const tiles = cur.tiles.filter((t) => t.sid !== sid);
          const focusedSid =
            cur.focusedSid === sid ? tiles[0]?.sid || null : cur.focusedSid;
          return { tiles, focusedSid };
        }
        return {
          tiles: [
            ...cur.tiles,
            { sid, colSpan: DEFAULT_COL_SPAN, rowSpan: DEFAULT_ROW_SPAN },
          ],
          focusedSid: cur.focusedSid || sid,
        };
      });
    },
    [update],
  );

  const reorder = useCallback(
    (fromIdx: number, toIdx: number) => {
      update((cur) => {
        if (fromIdx === toIdx) return cur;
        const tiles = cur.tiles.slice();
        const [moved] = tiles.splice(fromIdx, 1);
        if (moved) tiles.splice(toIdx, 0, moved);
        return { ...cur, tiles };
      });
    },
    [update],
  );

  const resize = useCallback(
    (sid: string, patch: { colSpan?: number; rowSpan?: number }) => {
      update((cur) => ({
        ...cur,
        tiles: cur.tiles.map((t) =>
          t.sid !== sid
            ? t
            : {
                sid,
                colSpan:
                  patch.colSpan !== undefined
                    ? clamp(patch.colSpan, MIN_COL_SPAN, MAX_COL_SPAN)
                    : t.colSpan,
                rowSpan:
                  patch.rowSpan !== undefined
                    ? clamp(patch.rowSpan, MIN_ROW_SPAN, MAX_ROW_SPAN)
                    : t.rowSpan,
              },
        ),
      }));
    },
    [update],
  );

  const focus = useCallback(
    (sid: string) => {
      update((cur) => {
        if (!cur.tiles.some((t) => t.sid === sid)) return cur;
        if (cur.focusedSid === sid) return cur;
        return { ...cur, focusedSid: sid };
      });
    },
    [update],
  );

  // Insert a placeholder draft tile at the front and focus it. If a draft
  // already exists we just refocus it — only one draft at a time keeps the
  // sentinel sid unambiguous.
  const addDraft = useCallback(() => {
    update((cur) => {
      if (cur.tiles.some((t) => t.sid === DRAFT_SID)) {
        return cur.focusedSid === DRAFT_SID ? cur : { ...cur, focusedSid: DRAFT_SID };
      }
      return {
        tiles: [
          { sid: DRAFT_SID, colSpan: DEFAULT_COL_SPAN, rowSpan: DEFAULT_ROW_SPAN },
          ...cur.tiles,
        ],
        focusedSid: DRAFT_SID,
      };
    });
  }, [update]);

  // Add a fresh terminal tile at the front and focus it. Its sid is a
  // `term:<uuid>` sentinel the Workspace renders as a <Terminal> instead of
  // a <Session>; the server spawns the PTY on first stream connect.
  const addTerminal = useCallback(() => {
    const sid = newTerminalSid();
    update((cur) => ({
      tiles: [{ sid, colSpan: DEFAULT_COL_SPAN, rowSpan: DEFAULT_ROW_SPAN }, ...cur.tiles],
      focusedSid: sid,
    }));
  }, [update]);

  // Add a file tile at the front (or refocus if already on canvas). The
  // sid is `file:<encoded path>`; Workspace routes it to <FileTile>.
  const addFile = useCallback(
    (path: string) => {
      if (!path) return;
      const sid = newFileSid(path);
      update((cur) => {
        if (cur.tiles.some((t) => t.sid === sid)) {
          return cur.focusedSid === sid ? cur : { ...cur, focusedSid: sid };
        }
        return {
          tiles: [{ sid, colSpan: DEFAULT_COL_SPAN, rowSpan: DEFAULT_ROW_SPAN }, ...cur.tiles],
          focusedSid: sid,
        };
      });
    },
    [update],
  );

  // Swap the draft sentinel for the real sessionId in place — keeps grid
  // position + focus intact so the tile the user was typing in stays put.
  const promoteDraft = useCallback(
    (realSid: string) => {
      if (!realSid || realSid === DRAFT_SID) return;
      update((cur) => {
        const draftIdx = cur.tiles.findIndex((t) => t.sid === DRAFT_SID);
        if (draftIdx < 0) return cur;
        // If the real sid is already on the canvas, drop the draft entry
        // instead of duplicating.
        const dup = cur.tiles.some((t) => t.sid === realSid);
        const tiles = cur.tiles.slice();
        if (dup) {
          tiles.splice(draftIdx, 1);
        } else {
          tiles[draftIdx] = { ...tiles[draftIdx]!, sid: realSid };
        }
        const focusedSid = cur.focusedSid === DRAFT_SID ? realSid : cur.focusedSid;
        return { tiles, focusedSid };
      });
    },
    [update],
  );

  return {
    tiles: state.tiles,
    focusedSid: state.focusedSid,
    isOnCanvas,
    add,
    remove,
    toggle,
    reorder,
    resize,
    focus,
    addDraft,
    addTerminal,
    addFile,
    promoteDraft,
  };
}
