import { LayoutGrid, MessageSquare, Pencil, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { SEARCH_HL_CLOSE, SEARCH_HL_OPEN } from '@macaron/shared';
import { api, basename, sessionTitle, fmtAgo, type MessageSearchHit, type SessionListItem, type Workspace } from '../lib/api';
import { addDraftSid } from '../lib/canvas';
import { hasActiveModal } from '../lib/modal';

// Dependency-free subsequence score: every query char must appear in order.
// Contiguous + early matches rank higher. Returns -1 for no match. Good
// enough for a palette over a few hundred sessions — no fuzzy lib needed.
function fuzzyScore(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastIdx = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += lastIdx === ti - 1 ? 3 : 1; // reward contiguous runs
      if (ti < 12) score += 1; // reward matches near the start
      lastIdx = ti;
      qi++;
    }
  }
  return qi === q.length ? score : -1;
}

type Item =
  | { kind: 'command'; id: string; title: string; subtitle?: string; run: () => void | Promise<void> }
  | { kind: 'session'; project: string; sid: string; title: string; subtitle: string; mtime: number }
  | { kind: 'workspace'; project: string; title: string; subtitle: string }
  | { kind: 'message'; project: string; sid: string; uuid?: string; title: string; snippet: string; mtime: number };

type WsWithSessions = Workspace & { sessions: SessionListItem[] };

function stripSearchHighlights(text: string): string {
  return text.split(SEARCH_HL_OPEN).join('').split(SEARCH_HL_CLOSE).join('');
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [data, setData] = useState<WsWithSessions[]>([]);
  // Same one-shot toggle the old YOLO command used to do — bounces the global
  // default between 'bypassPermissions' (all tools auto-approve) and 'default'
  // (ask for every call). The full 4-way picker lives in Settings.
  const [bypassDefault, setBypassDefault] = useState(false);
  const [msgHits, setMsgHits] = useState<MessageSearchHit[]>([]);
  const navigate = useNavigate();
  const location = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // The project of the workspace currently open (/w/:project[/s/:sid]), used
  // to scope the "New Session" command. Empty on Dashboard/Settings.
  const currentProject = useMemo(() => {
    const m = location.pathname.match(/^\/w\/([^/]+)/);
    if (!m) return '';
    // A pasted/bookmarked hash with a stray `%` (e.g. #/w/50%off) makes
    // decodeURIComponent throw URIError. This component is mounted at the App
    // root with no ErrorBoundary, so an unguarded throw white-screens the
    // whole SPA on every route — fall back to the raw segment instead.
    try {
      return decodeURIComponent(m[1]!);
    } catch {
      return m[1]!;
    }
  }, [location.pathname]);

  // Global Cmd/Ctrl-K toggles the palette. IME-guarded; only bare Cmd/Ctrl+K
  // (no shift/alt) so we don't shadow other shortcuts. The sidebar search button
  // opens SearchPalette instead (macaron:open-search) — this palette keeps
  // Cmd-K for commands + session/workspace navigation. Don't open over another
  // modal (e.g. an open SearchPalette); matches ShortcutsHelp.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => (v ? false : !hasActiveModal()));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // On open: reset, focus the input, and load the session/workspace list from
  // the same endpoints the sidebar already polls (server mtime-cache keeps it
  // cheap). Also snapshot current YOLO state for the toggle command's label.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    setMsgHits([]);
    queueMicrotask(() => inputRef.current?.focus());
    let cancelled = false;
    (async () => {
      try {
        const d = await api.workspaces();
        const results = await Promise.all(
          d.workspaces.map(async (w) => {
            try {
              return { ...w, sessions: (await api.workspace(w.project)).sessions };
            } catch {
              return { ...w, sessions: [] as SessionListItem[] };
            }
          }),
        );
        if (!cancelled) setData(results);
      } catch {
        /* offline — palette still works for commands */
      }
      try {
        const s = await api.settings();
        if (!cancelled) setBypassDefault(s.defaultPermissionMode === 'bypassPermissions');
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Debounced server-side message search (min 2 chars). Prefer the SQLite FTS
  // index and fall back to the runtime-safe transcript search when unavailable.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setMsgHits([]);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      const fallback = () =>
        api
          .searchMessages(q, 20)
          .then((r) => { if (!stale) setMsgHits(r.hits); })
          .catch(() => { if (!stale) setMsgHits([]); });

      api
        .search(q, 20)
        .then((r) => {
          if (stale) return;
          if (!r.enabled) {
            void fallback();
            return;
          }
          setMsgHits(
            r.hits.map((hit) => ({
              project: hit.project,
              sessionId: hit.sessionId,
              uuid: hit.uuid,
              role: hit.role === 'user' ? 'user' : 'assistant',
              snippet: stripSearchHighlights(hit.snippet),
              preview: `${basename(hit.cwd) || hit.sessionId.slice(0, 8)} · ${hit.role}`,
              mtime: Date.parse(hit.ts) || 0,
            })),
          );
        })
        .catch(() => { void fallback(); });
    }, 250);
    // Guard against out-of-order resolves: without this, typing `de` then
    // `deploy` can let the slower `de` request resolve last and overwrite the
    // fresh `deploy` results (or repopulate after the query drops below 2).
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [query, open]);

  const close = useCallback(() => setOpen(false), []);

  const go = useCallback(
    (project: string, sid?: string) => {
      const base = `/w/${encodeURIComponent(project)}`;
      navigate(sid ? `${base}/s/${encodeURIComponent(sid)}` : base);
      if (sid) {
        // Deep-link already pins + focuses; also nudge the tile to scroll into
        // view + focus its composer (same event the sidebar dispatches).
        window.dispatchEvent(new CustomEvent('macaron:focus-tile', { detail: { project, sid } }));
      }
      close();
    },
    [navigate, close],
  );

  // Build the unified item list, filtered by the query. Sessions/workspaces/
  // commands use the local fuzzy score; message hits come pre-matched from the
  // server and are appended as their own group.
  const items = useMemo<Item[]>(() => {
    const q = query.trim();
    const commands: Item[] = [
      {
        kind: 'command',
        id: 'toggle-bypass-default',
        title: bypassDefault ? 'Reset default permission mode' : 'Set default to Bypass all',
        subtitle: bypassDefault
          ? 'New sessions will start asking for every tool call'
          : 'New sessions will start with all tool permissions auto-approved',
        run: async () => {
          try {
            const s = await api.setDefaultPermissionMode(bypassDefault ? 'default' : 'bypassPermissions');
            setBypassDefault(s.defaultPermissionMode === 'bypassPermissions');
          } catch {
            /* ignore */
          }
        },
      },
      { kind: 'command', id: 'go-dashboard', title: 'Go to Dashboard', run: () => { navigate('/'); close(); } },
      { kind: 'command', id: 'go-settings', title: 'Go to Settings', run: () => { navigate('/settings'); close(); } },
    ];
    if (currentProject) {
      commands.unshift({
        kind: 'command',
        id: 'new-session',
        title: 'New Session',
        subtitle: `in ${currentProject}`,
        run: () => {
          addDraftSid(currentProject);
          navigate(`/w/${encodeURIComponent(currentProject)}`);
          close();
        },
      });
    }

    const sessions: Item[] = [];
    const workspaces: Item[] = [];
    for (const w of data) {
      const name = w.name || basename(w.cwd) || w.project;
      workspaces.push({ kind: 'workspace', project: w.project, title: name, subtitle: w.cwd || w.project });
      for (const s of w.sessions) {
        sessions.push({
          kind: 'session',
          project: w.project,
          sid: s.sessionId,
          title: sessionTitle(s),
          subtitle: `${name} · ${fmtAgo(s.mtime)}`,
          mtime: s.mtime,
        });
      }
    }

    const scored = (arr: Item[], text: (i: Item) => string): Item[] => {
      if (!q) return arr;
      return arr
        .map((i) => ({ i, s: fuzzyScore(q, text(i)) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.i);
    };

    const cmdMatched = scored(commands, (i) => (i.kind === 'command' ? i.title + ' ' + (i.subtitle || '') : ''));
    const sessMatched = scored(sessions, (i) => (i.kind === 'session' ? i.title + ' ' + i.subtitle : '')).slice(0, 30);
    const wsMatched = scored(workspaces, (i) => (i.kind === 'workspace' ? i.title + ' ' + i.subtitle : ''));
    const msgItems: Item[] = msgHits.map((h) => ({
      kind: 'message',
      project: h.project,
      sid: h.sessionId,
      uuid: h.uuid,
      title: h.snippet,
      snippet: h.preview,
      mtime: h.mtime,
    }));

    return [...cmdMatched, ...sessMatched, ...wsMatched, ...msgItems];
  }, [query, data, bypassDefault, msgHits, currentProject, navigate, close]);

  // Clamp the active index whenever the filtered list shrinks.
  useEffect(() => {
    setActive((a) => (a >= items.length ? Math.max(0, items.length - 1) : a));
  }, [items.length]);

  const runItem = useCallback(
    (it: Item | undefined) => {
      if (!it) return;
      if (it.kind === 'command') void it.run();
      else if (it.kind === 'session' || it.kind === 'message') go(it.project, it.sid);
      else if (it.kind === 'workspace') go(it.project);
    },
    [go],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runItem(items[active]);
    }
  };

  // Keep the active row visible as the selection moves.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('.cmdk-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  if (!open) return null;

  const groupLabel = (i: number): string | null => {
    const it = items[i]!;
    const prev = items[i - 1];
    const label = it.kind === 'command' ? 'Actions' : it.kind === 'session' ? 'Sessions' : it.kind === 'workspace' ? 'Workspaces' : 'Messages';
    const prevLabel = prev ? (prev.kind === 'command' ? 'Actions' : prev.kind === 'session' ? 'Sessions' : prev.kind === 'workspace' ? 'Workspaces' : 'Messages') : null;
    return label === prevLabel ? null : label;
  };

  return (
    <div className="cmdk-backdrop" onMouseDown={close}>
      <div className="cmdk-panel" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <input
          ref={inputRef}
          className="cmdk-input"
          placeholder="Search sessions, workspaces, messages, or run an action…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="cmdk-list" ref={listRef}>
          {items.length === 0 && <div className="cmdk-empty">No results</div>}
          {items.map((it, i) => {
            const label = groupLabel(i);
            const key =
              it.kind === 'command'
                ? `c:${it.id}`
                : it.kind === 'workspace'
                  ? `w:${it.project}`
                  : `${it.kind}:${it.project}:${it.sid}:${it.kind === 'message' ? it.uuid || i : ''}`;
            return (
              <div key={key}>
                {label && <div className="cmdk-group">{label}</div>}
                <div
                  className={'cmdk-row' + (i === active ? ' active' : '')}
                  onMouseMove={() => setActive(i)}
                  onClick={() => runItem(it)}
                >
                  <span className={'cmdk-kind cmdk-kind-' + it.kind}>
                    {it.kind === 'command' ? <Zap size={14} aria-hidden="true" /> : it.kind === 'session' ? <MessageSquare size={14} aria-hidden="true" /> : it.kind === 'workspace' ? <LayoutGrid size={14} aria-hidden="true" /> : <Pencil size={14} aria-hidden="true" />}
                  </span>
                  <span className="cmdk-text">
                    <span className="cmdk-title">{it.title}</span>
                    {(() => {
                      const sub = it.kind === 'message' ? it.snippet : it.kind === 'command' ? it.subtitle : it.subtitle;
                      return sub ? <span className="cmdk-sub">{sub}</span> : null;
                    })()}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        <div className="cmdk-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
