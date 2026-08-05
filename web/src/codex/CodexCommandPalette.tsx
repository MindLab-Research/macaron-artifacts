import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LayoutGrid, MessageSquare, Settings, Zap } from 'lucide-react';
import { hasActiveModal } from '../lib/modal';
import { codexApi, type CodexWorkspace, type CodexThread } from './api';
import { sessionTitle } from '../lib/api';

// Codex-scoped command palette (Cmd+K / Ctrl+K). The Claude bundle's palette
// searches ~/.claude/projects sessions AND indexed message bodies — that
// vocabulary doesn't map to Codex's rollout-jsonl world without new server
// endpoints, so this version stays minimal: nav commands (Settings, Skills,
// Prompts, …) + jump-to-workspace. Fits a Codex user's mental model without
// showing them Claude sessions they didn't ask for.

// Tiny subsequence scorer — same shape as the Claude palette's fuzzyScore,
// pulled inline so this bundle doesn't drag in the whole CommandPalette module.
function fuzzyScore(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastIdx = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += lastIdx === ti - 1 ? 3 : 1;
      if (ti < 12) score += 1;
      lastIdx = ti;
      qi++;
    }
  }
  return qi === q.length ? score : -1;
}

type Item =
  | { kind: 'command'; id: string; title: string; subtitle?: string; run: () => void }
  | { kind: 'workspace'; project: string; title: string; subtitle: string }
  | { kind: 'thread'; project: string; sid: string; title: string; subtitle: string };

function itemLabel(it: Item): string {
  return it.kind === 'command' ? it.title : `${it.title} ${it.subtitle}`;
}

type WsWithThreads = CodexWorkspace & { sessions: CodexThread[] };

export function CodexCommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [workspaces, setWorkspaces] = useState<WsWithThreads[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  // Global open shortcut (Cmd+K / Ctrl+K). Skip while a modal is up so we
  // don't stack over Confirm etc; skip while a text field is focused so K
  // stays a literal character where the user is typing. Also listens for
  // 'macaron:open-search' so the sidebar's "Search threads" button opens
  // the same palette (mirrors the Claude sidebar's search wiring).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setOpen((v) => (v ? false : !hasActiveModal()));
      } else if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    const onOpenEvent = () => setOpen((v) => v || !hasActiveModal());
    window.addEventListener('keydown', onKey);
    window.addEventListener('macaron:open-search', onOpenEvent);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('macaron:open-search', onOpenEvent);
    };
  }, [open]);

  // Refetch workspaces + threads each time the palette opens so a freshly
  // created workspace / thread is jumpable without a full page refresh.
  // Two-step: list workspaces, then hydrate each with its thread list in
  // parallel. Cheap; both endpoints already back the sidebar every 15s.
  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const d = await codexApi.workspaces();
        const hydrated = await Promise.all(
          d.workspaces.map(async (w) => {
            try {
              const detail = await codexApi.workspace(w.project);
              return { ...w, sessions: detail.sessions } as WsWithThreads;
            } catch {
              return { ...w, sessions: [] } as WsWithThreads;
            }
          }),
        );
        setWorkspaces(hydrated);
      } catch {
        setWorkspaces([]);
      }
    })();
    setQuery('');
    setActive(0);
    queueMicrotask(() => inputRef.current?.focus());
  }, [open]);

  const commands = useMemo<Item[]>(() => ([
    { kind: 'command', id: 'nav-home',      title: 'New thread',       subtitle: '/',          run: () => navigate('/') },
    { kind: 'command', id: 'nav-examples',  title: 'Examples',         subtitle: '/examples',  run: () => navigate('/examples') },
    { kind: 'command', id: 'nav-skills',    title: 'Skills',           subtitle: '/skills',    run: () => navigate('/skills') },
    { kind: 'command', id: 'nav-agents',    title: 'Agents',           subtitle: '/agents',    run: () => navigate('/agents') },
    { kind: 'command', id: 'nav-mcp',       title: 'MCP servers',      subtitle: '/mcp',       run: () => navigate('/mcp') },
    { kind: 'command', id: 'nav-hooks',     title: 'Hooks',            subtitle: '/hooks',     run: () => navigate('/hooks') },
    { kind: 'command', id: 'nav-prompts',   title: 'Prompts',          subtitle: '/prompts',   run: () => navigate('/prompts') },
    { kind: 'command', id: 'nav-schedules', title: 'Schedules',        subtitle: '/schedules', run: () => navigate('/schedules') },
    { kind: 'command', id: 'nav-usage',     title: 'Usage',            subtitle: '/usage',     run: () => navigate('/usage') },
    { kind: 'command', id: 'nav-settings',  title: 'Settings',         subtitle: '/settings',  run: () => navigate('/settings') },
  ]), [navigate]);

  const items = useMemo<Item[]>(() => {
    const wsItems: Item[] = workspaces.map((w) => ({
      kind: 'workspace' as const,
      project: w.project,
      title: w.name || w.project,
      subtitle: w.cwd || w.project,
    }));
    const threadItems: Item[] = workspaces.flatMap((w) =>
      w.sessions.map((s) => ({
        kind: 'thread' as const,
        project: w.project,
        sid: s.sessionId,
        title: sessionTitle(s),
        subtitle: `${w.name || w.project} · ${s.sessionId.slice(0, 8)}`,
      })),
    );
    const all: Item[] = [...commands, ...wsItems, ...threadItems];
    if (!query.trim()) return all;
    const scored = all
      .map((it) => ({ it, s: fuzzyScore(query.trim(), itemLabel(it)) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => b.s - a.s);
    return scored.map((r) => r.it);
  }, [query, commands, workspaces]);

  // Keep the active index in range when the item list shrinks.
  useEffect(() => {
    if (active >= items.length) setActive(Math.max(0, items.length - 1));
  }, [active, items.length]);

  const choose = useCallback((it: Item) => {
    setOpen(false);
    if (it.kind === 'command') it.run();
    else if (it.kind === 'thread') navigate(`/w/${encodeURIComponent(it.project)}/t/${encodeURIComponent(it.sid)}`);
    else navigate(`/w/${encodeURIComponent(it.project)}`);
  }, [navigate]);

  // Close if the route changes underneath us (e.g. because .run() navigated).
  useEffect(() => {
    if (open) setOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  if (!open) return null;

  return (
    <div className="cx-palette-scrim" role="presentation" onClick={() => setOpen(false)}>
      <div
        className="cx-palette"
        role="dialog"
        aria-label="Command palette"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="cx-palette-input"
          placeholder="Jump to a thread, workspace, or command…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(items.length - 1, i + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); const it = items[active]; if (it) choose(it); }
          }}
        />
        <div className="cx-palette-list" role="listbox">
          {items.length === 0 && (
            <div className="cx-palette-empty">No matches</div>
          )}
          {items.map((it, i) => {
            const activeCls = i === active ? ' active' : '';
            const Icon = it.kind === 'command'
              ? (it.id.startsWith('nav-settings') ? Settings : it.id.startsWith('nav-home') ? MessageSquare : Zap)
              : it.kind === 'thread'
                ? MessageSquare
                : LayoutGrid;
            const key = it.kind === 'command'
              ? `c-${it.id}`
              : it.kind === 'thread'
                ? `t-${it.sid}`
                : `w-${it.project}`;
            return (
              <button
                key={key}
                type="button"
                className={'cx-palette-item' + activeCls}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(it)}
              >
                <Icon className="cx-palette-icon" size={14} aria-hidden="true" />
                <span className="cx-palette-title">{it.title}</span>
                <span className="cx-palette-sub">{it.kind === 'command' ? (it.subtitle || '') : it.subtitle}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
