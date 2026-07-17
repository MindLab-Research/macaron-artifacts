// Right-side files drawer over the workspace canvas. Two modes: a lazy
// tree of the project cwd (fast, honours .gitignore), and a search mode
// that flips to filename or content match depending on the input. Clicking
// any file calls onOpen(path) — the canvas turns it into a FileTile.
//
// Mirrors GitPanel's slide-in shell (fixed backdrop + right-side panel
// via the .above-modal escape hatch so it stacks over the composer).

import { ChevronDown, ChevronRight, File, Folder, FolderOpen, Search, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type FileEntry, type FileContentSearchResponse } from '../lib/api';

type Mode = 'tree' | 'name' | 'content';

// One lazy directory row. Files bubble their click up; directories fetch
// their children the first time they're expanded.
function TreeRow({
  entry,
  project,
  depth,
  onOpen,
  focusedPath,
}: {
  entry: FileEntry;
  project: string;
  depth: number;
  onOpen: (path: string) => void;
  focusedPath: string;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const toggle = useCallback(() => {
    if (entry.type === 'file') return onOpen(entry.path);
    const next = !open;
    setOpen(next);
    if (next && children === null && !loading) {
      setLoading(true);
      api
        .listFiles(project, entry.path)
        .then((d) => setChildren(d.entries))
        .catch((e) => setError((e as Error).message))
        .finally(() => setLoading(false));
    }
  }, [entry, open, children, loading, project, onOpen]);

  const isDir = entry.type === 'dir';
  const focused = focusedPath === entry.path;
  return (
    <div>
      <button
        type="button"
        className={'fp-row' + (focused ? ' focused' : '') + (isDir ? ' dir' : ' file')}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={toggle}
        title={entry.path}
      >
        <span className="fp-caret">{isDir ? (open ? <ChevronDown size={10} aria-hidden="true" /> : <ChevronRight size={10} aria-hidden="true" />) : ' '}</span>
        <span className="fp-file-icon" aria-hidden="true">
          {isDir ? <Folder size={13} /> : <File size={13} />}
        </span>
        <span className="fp-name">{entry.name}</span>
      </button>
      {isDir && open && (
        <div>
          {loading && <div className="fp-hint" style={{ paddingLeft: 8 + (depth + 1) * 12 }}>Loading…</div>}
          {error && <div className="fp-hint err" style={{ paddingLeft: 8 + (depth + 1) * 12 }}>{error}</div>}
          {children?.map((c) => (
            <TreeRow
              key={c.path}
              entry={c}
              project={project}
              depth={depth + 1}
              onOpen={onOpen}
              focusedPath={focusedPath}
            />
          ))}
          {children && children.length === 0 && (
            <div className="fp-hint" style={{ paddingLeft: 8 + (depth + 1) * 12 }}>empty</div>
          )}
        </div>
      )}
    </div>
  );
}

export function FilesPanel({
  project,
  onOpen,
  onClose,
  focusedPath,
}: {
  project: string;
  onOpen: (path: string) => void;
  onClose: () => void;
  focusedPath: string;
}) {
  const [mode, setMode] = useState<Mode>('tree');
  const [query, setQuery] = useState('');
  const [roots, setRoots] = useState<FileEntry[] | null>(null);
  const [rootError, setRootError] = useState('');
  const [nameHits, setNameHits] = useState<string[]>([]);
  const [contentHits, setContentHits] = useState<FileContentSearchResponse['results']>([]);
  const [searching, setSearching] = useState(false);
  const searchGenRef = useRef(0);

  useEffect(() => {
    api.listFiles(project, '')
      .then((d) => setRoots(d.entries))
      .catch((e) => setRootError((e as Error).message));
  }, [project]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Debounced search — flips mode based on prefix. Bare text → filename;
  // `> foo` → content. Empty input reverts to tree.
  useEffect(() => {
    const q = query.trim();
    if (!q) { setMode('tree'); setNameHits([]); setContentHits([]); return; }
    const isContent = q.startsWith('>');
    const needle = isContent ? q.slice(1).trim() : q;
    if (!needle) return;
    setMode(isContent ? 'content' : 'name');
    setSearching(true);
    const gen = ++searchGenRef.current;
    const timer = window.setTimeout(async () => {
      try {
        if (isContent) {
          const r = await api.searchFileContent(project, needle);
          if (gen === searchGenRef.current) setContentHits(r.results);
        } else {
          const r = await api.searchFiles(project, needle);
          if (gen === searchGenRef.current) setNameHits(r.results);
        }
      } catch {
        if (gen === searchGenRef.current) {
          isContent ? setContentHits([]) : setNameHits([]);
        }
      } finally {
        if (gen === searchGenRef.current) setSearching(false);
      }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [project, query]);

  return (
    <aside className="fp-panel" aria-label="Files panel">
        <div className="fp-head">
          <div className="fp-title"><FolderOpen size={15} aria-hidden="true" /> Files</div>
          <button className="fp-close" onClick={onClose} title="Close" aria-label="Close"><X size={14} aria-hidden="true" /></button>
        </div>
        <div className="fp-search">
          <Search className="fp-search-icon" size={14} aria-hidden="true" />
          <input
            type="text"
            className="fp-input"
            name="file-search"
            aria-label="Search files"
            autoComplete="off"
            placeholder="Search files"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus={typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 769px)').matches}
          />
          {searching && <span className="fp-hint">…</span>}
        </div>

        <div className="fp-body">
          {mode === 'tree' && (
            <>
              {rootError && <div className="fp-hint err">{rootError}</div>}
              {!roots && !rootError && <div className="fp-hint">Loading…</div>}
              {roots?.map((e) => (
                <TreeRow
                  key={e.path}
                  entry={e}
                  project={project}
                  depth={0}
                  onOpen={onOpen}
                  focusedPath={focusedPath}
                />
              ))}
            </>
          )}

          {mode === 'name' && (
            <div>
              {nameHits.length === 0 && !searching && (
                <div className="fp-hint">No files match "{query.trim()}".</div>
              )}
              {nameHits.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={'fp-row file' + (p === focusedPath ? ' focused' : '')}
                  onClick={() => onOpen(p)}
                  title={p}
                >
                  <span className="fp-name">{p}</span>
                </button>
              ))}
            </div>
          )}

          {mode === 'content' && (
            <div>
              {contentHits.length === 0 && !searching && (
                <div className="fp-hint">No matches for "{query.trim().slice(1).trim()}".</div>
              )}
              {contentHits.map((h) => (
                <div key={h.path} className="fp-hit-group">
                  <button
                    type="button"
                    className={'fp-row file hit-head' + (h.path === focusedPath ? ' focused' : '')}
                    onClick={() => onOpen(h.path)}
                    title={h.path}
                  >
                    <span className="fp-name">{h.path}</span>
                    <span className="fp-hit-count">{h.matches.length}</span>
                  </button>
                  {h.matches.map((m) => (
                    <button
                      key={m.line}
                      type="button"
                      className="fp-hit-line"
                      onClick={() => onOpen(h.path)}
                      title={`${h.path}:${m.line}`}
                    >
                      <span className="fp-hit-lineno">{m.line}</span>
                      <span className="fp-hit-text">{m.text.trim()}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

    </aside>
  );
}
