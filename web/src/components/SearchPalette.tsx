import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SEARCH_HL_OPEN, SEARCH_HL_CLOSE } from '@macaron/shared';
import { api, basename, type SearchHit } from '../lib/api';
import { hasActiveModal } from '../lib/modal';

// Split a server snippet on the highlight delimiters and render matched runs as
// <mark>. We never set innerHTML, so message text can't inject markup — the
// delimiters are control chars that can't occur in real content.
function Highlighted({ snippet }: { snippet: string }) {
  const parts = useMemo(() => {
    const out: Array<{ hl: boolean; text: string }> = [];
    let rest = snippet;
    while (rest.length) {
      const open = rest.indexOf(SEARCH_HL_OPEN);
      if (open === -1) {
        out.push({ hl: false, text: rest });
        break;
      }
      if (open > 0) out.push({ hl: false, text: rest.slice(0, open) });
      const close = rest.indexOf(SEARCH_HL_CLOSE, open + 1);
      if (close === -1) {
        out.push({ hl: false, text: rest.slice(open + 1) });
        break;
      }
      out.push({ hl: true, text: rest.slice(open + 1, close) });
      rest = rest.slice(close + 1);
    }
    return out;
  }, [snippet]);
  return (
    <>
      {parts.map((p, i) => (p.hl ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </>
  );
}

export function SearchPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setHits([]);
    setActive(0);
  }, []);

  // Open on the sidebar search-button event (macaron:open-search). Don't stack
  // over another open modal (e.g. CommandPalette) — matches ShortcutsHelp.
  useEffect(() => {
    const onOpen = () => setOpen((v) => v || !hasActiveModal());
    window.addEventListener('macaron:open-search', onOpen);
    return () => window.removeEventListener('macaron:open-search', onOpen);
  }, []);

  useEffect(() => {
    if (open) queueMicrotask(() => inputRef.current?.focus());
  }, [open]);

  // Debounced search as the user types. A stale-guard drops out-of-order
  // responses so the list always reflects the latest query.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const r = await api.search(q);
        if (cancelled) return;
        setEnabled(r.enabled);
        setHits(r.hits);
        setActive(0);
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 140);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [query, open]);

  const go = useCallback(
    (h: SearchHit) => {
      close();
      navigate(`/w/${encodeURIComponent(h.project)}/s/${encodeURIComponent(h.sessionId)}`);
    },
    [close, navigate],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, Math.max(hits.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const h = hits[active];
      if (h) go(h);
    }
  };

  if (!open) return null;

  return (
    <div className="search-backdrop" onClick={close}>
      <div className="search-palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <input
          ref={inputRef}
          className="search-input"
          placeholder="Search Claude sessions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
        />
        <div className="search-results">
          {!enabled && (
            <div className="search-empty">Search is unavailable in this runtime or disabled by MACARON_SEARCH=0.</div>
          )}
          {enabled && query.trim() && !loading && hits.length === 0 && (
            <div className="search-empty">No matches for “{query.trim()}”.</div>
          )}
          {enabled && !query.trim() && (
            <div className="search-empty">Type to search across Claude session messages.</div>
          )}
          {hits.map((h, i) => (
            <button
              type="button"
              key={`${h.sessionId}:${h.uuid}:${i}`}
              className={'search-hit' + (i === active ? ' active' : '')}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(h)}
            >
              <div className="search-hit-head">
                <span className={'search-hit-role role-' + h.role}>{h.role}</span>
                <span className="search-hit-cwd">{basename(h.cwd) || h.sessionId.slice(0, 8)}</span>
              </div>
              <div className="search-hit-snippet">
                <Highlighted snippet={h.snippet} />
              </div>
            </button>
          ))}
        </div>
        <div className="search-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
