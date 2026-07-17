import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ChevronDown, ChevronRight, Circle, File, Folder } from 'lucide-react';
import { api, type FileEntry } from '../lib/api';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/Confirm';

// Monaco is heavy — only load it once a file is actually opened.
const CodeEditor = lazy(() => import('../components/CodeEditor'));

// One node in the lazy file tree. Directories fetch their children the first
// time they're expanded; files just report clicks up to the editor pane.
function TreeNode({
  entry,
  project,
  depth,
  selectedPath,
  onSelect,
}: {
  entry: FileEntry;
  project: string;
  depth: number;
  selectedPath: string;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const toggle = useCallback(() => {
    if (entry.type === 'file') return onSelect(entry.path);
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
  }, [entry, open, children, loading, project, onSelect]);

  const isDir = entry.type === 'dir';
  const selected = selectedPath === entry.path;
  return (
    <div className="fx-node">
      <button
        className={`fx-row${selected ? ' selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={toggle}
        title={entry.path}
      >
        <span className="fx-caret">{isDir ? (open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />) : ''}</span>
        <span className="fx-icon">{isDir ? <Folder size={14} aria-hidden="true" /> : <File size={14} aria-hidden="true" />}</span>
        <span className="fx-name">{entry.name}</span>
      </button>
      {isDir && open && (
        <div className="fx-children">
          {loading && <div className="fx-hint" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>Loading…</div>}
          {error && <div className="fx-hint error" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>{error}</div>}
          {children?.map((c) => (
            <TreeNode
              key={c.path}
              entry={c}
              project={project}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
          {children && children.length === 0 && (
            <div className="fx-hint" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>empty</div>
          )}
        </div>
      )}
    </div>
  );
}

export function FileExplorer() {
  const { project = '' } = useParams();
  const toast = useToast();
  const confirm = useConfirm();
  const [roots, setRoots] = useState<FileEntry[] | null>(null);
  const [rootError, setRootError] = useState('');

  const [openPath, setOpenPath] = useState('');
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [openError, setOpenError] = useState(''); // binary / too-large / read fail
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);

  const dirty = openPath !== '' && !openError && content !== original;

  useEffect(() => {
    api
      .listFiles(project, '')
      .then((d) => setRoots(d.entries))
      .catch((e) => setRootError((e as Error).message));
  }, [project]);

  const openFile = useCallback(
    async (path: string) => {
      if (path === openPath) return;
      if (dirty) {
        const ok = await confirm({
          title: 'Discard unsaved changes?',
          body: 'You have edits in the current file that haven\'t been saved. Opening a new file will drop them.',
          confirmLabel: 'Discard',
          destructive: true,
        });
        if (!ok) return;
      }
      setOpenPath(path);
      setLoadingFile(true);
      setOpenError('');
      api
        .readFile(project, path)
        .then((d) => {
          setContent(d.content);
          setOriginal(d.content);
        })
        .catch((e) => {
          setContent('');
          setOriginal('');
          setOpenError((e as Error).message);
        })
        .finally(() => setLoadingFile(false));
    },
    [project, openPath, dirty, confirm],
  );

  const save = useCallback(() => {
    if (!openPath || openError || saving) return;
    setSaving(true);
    api
      .writeFile(project, openPath, content)
      .then(() => {
        setOriginal(content);
        toast('Saved');
      })
      .catch((e) => toast(`Save failed: ${(e as Error).message}`))
      .finally(() => setSaving(false));
  }, [openPath, openError, saving, project, content, toast]);

  // Cmd/Ctrl+S saves the open file. Bound to window so it fires regardless of
  // where focus sits (tree, editor, or the Save button).
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <section className="fx">
      <header className="fx-head">
        <Link className="ghost small" to={`/w/${encodeURIComponent(project)}`}>
          <ArrowLeft size={14} aria-hidden="true" /> Workspace
        </Link>
        <span className="fx-path">{openPath || 'Files'}</span>
        {dirty && <span className="fx-dirty" title="Unsaved changes"><Circle size={8} fill="currentColor" aria-hidden="true" /></span>}
        <div className="fx-head-actions">
          <button className="ghost small" disabled={!dirty || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </header>
      <div className="fx-body">
        <aside className="fx-tree">
          {rootError && <div className="fx-hint error">{rootError}</div>}
          {!roots && !rootError && <div className="fx-hint">Loading…</div>}
          {roots?.map((e) => (
            <TreeNode
              key={e.path}
              entry={e}
              project={project}
              depth={0}
              selectedPath={openPath}
              onSelect={openFile}
            />
          ))}
        </aside>
        <div className="fx-editor">
          {!openPath && <div className="fx-placeholder">Select a file to view or edit.</div>}
          {openPath && loadingFile && <div className="fx-placeholder">Loading…</div>}
          {openPath && !loadingFile && openError && (
            <div className="fx-placeholder">Can’t open this file: {openError}</div>
          )}
          {openPath && !loadingFile && !openError && (
            <Suspense fallback={<div className="fx-placeholder">Loading editor…</div>}>
              <CodeEditor value={content} onChange={setContent} path={openPath} />
            </Suspense>
          )}
        </div>
      </div>
    </section>
  );
}
