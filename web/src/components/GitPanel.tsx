import { ArrowDown, ArrowUp, Plus, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type GitFileStatus } from '../lib/api';

// Source-control drawer for a workspace: stage/unstage, per-file diff, commit,
// and branch switch — the same cwd the agent edits, so it shows exactly what
// just changed. Diffs the index/worktree against HEAD (VS Code SCM shape),
// not a review against origin/main.
export function GitPanel({ project, onClose }: { project: string; onClose: () => void }) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.gitStatus>> | null>(null);
  const [branches, setBranches] = useState<Awaited<ReturnType<typeof api.gitBranches>> | null>(null);
  const [sel, setSel] = useState<{ file: string; staged: boolean } | null>(null);
  const [diff, setDiff] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [creating, setCreating] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.gitStatus(project));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [project]);

  const loadBranches = useCallback(async () => {
    try {
      setBranches(await api.gitBranches(project));
    } catch {
      /* non-repo — status already reflects isRepo:false */
    }
  }, [project]);

  useEffect(() => {
    loadStatus();
    loadBranches();
  }, [loadStatus, loadBranches]);

  const staged = useMemo(() => status?.files.filter((f) => f.staged) ?? [], [status]);
  const changes = useMemo(() => status?.files.filter((f) => f.unstaged || f.untracked) ?? [], [status]);

  const openDiff = async (f: GitFileStatus, fromStaged: boolean) => {
    setSel({ file: f.path, staged: fromStaged });
    setDiff('');
    try {
      const r = await api.gitDiff(project, f.path, { staged: fromStaged, untracked: !fromStaged && f.untracked });
      setDiff(r.diff || '(no textual changes — binary or mode-only)');
    } catch (e) {
      setDiff(`# ${(e as Error).message}`);
    }
  };

  const withBusy = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr('');
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stage = (paths: string[]) => withBusy(async () => { await api.gitStage(project, paths); await loadStatus(); });
  const unstage = (paths: string[]) => withBusy(async () => { await api.gitUnstage(project, paths); await loadStatus(); });
  const commit = () => withBusy(async () => {
    await api.gitCommit(project, message.trim(), false);
    setMessage('');
    setSel(null);
    setDiff('');
    await loadStatus();
    await loadBranches();
  });
  const checkout = (branch: string, create: boolean) => withBusy(async () => {
    await api.gitCheckout(project, branch, create);
    setCreating(false);
    setNewBranch('');
    setSel(null);
    setDiff('');
    await loadStatus();
    await loadBranches();
  });

  const fileRow = (f: GitFileStatus, fromStaged: boolean) => (
    <div
      key={(fromStaged ? 's:' : 'c:') + f.path}
      className={`git-file${sel?.file === f.path && sel?.staged === fromStaged ? ' active' : ''}`}
      onClick={() => openDiff(f, fromStaged)}
    >
      <input
        type="checkbox"
        className="git-file-check"
        checked={fromStaged}
        title={fromStaged ? 'Unstage' : 'Stage'}
        onClick={(e) => e.stopPropagation()}
        onChange={() => (fromStaged ? unstage([f.path]) : stage([f.path]))}
      />
      <span className="git-file-name" title={f.renamedFrom ? `${f.renamedFrom} → ${f.path}` : f.path}>
        {f.path}
      </span>
      <span className={`git-file-stat ${statClass(f, fromStaged)}`}>{statChar(f, fromStaged)}</span>
    </div>
  );

  return (
    <div className="git-backdrop" onClick={onClose}>
      <aside className="git-panel" onClick={(e) => e.stopPropagation()}>
        <header className="git-panel-head">
          <div className="git-panel-title">Source Control</div>
          <button className="git-panel-x" onClick={onClose} aria-label="Close git panel" title="Close"><X size={14} aria-hidden="true" /></button>
        </header>

        {status && !status.isRepo ? (
          <div className="git-empty">Not a git repository.</div>
        ) : (
          <>
            <div className="git-branchbar">
              <select
                className="git-branch-select"
                value={status?.branch || branches?.current || ''}
                disabled={busy || status?.detached}
                onChange={(e) => e.target.value && checkout(e.target.value, false)}
              >
                {status?.detached && <option value={status.branch}>{status.branch} (detached)</option>}
                {branches?.branches.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
              {status && (status.ahead > 0 || status.behind > 0) && (
                <span className="git-aheadbehind" title="ahead / behind upstream">
                  {status.ahead > 0 && <><ArrowUp size={12} aria-hidden="true" />{status.ahead}</>}
                  {status.behind > 0 && <><ArrowDown size={12} aria-hidden="true" />{status.behind}</>}
                </span>
              )}
              <button className="git-icon-btn" title="Refresh" onClick={() => { loadStatus(); loadBranches(); }}><RefreshCw size={14} aria-hidden="true" /></button>
              <button className="git-icon-btn" title="New branch" onClick={() => setCreating((v) => !v)}><Plus size={14} aria-hidden="true" /></button>
            </div>

            {creating && (
              <div className="git-branch-new">
                <input
                  type="text"
                  placeholder="new-branch-name"
                  value={newBranch}
                  autoFocus
                  onChange={(e) => setNewBranch(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && newBranch.trim()) checkout(newBranch.trim(), true); }}
                />
                <button className="primary small" disabled={busy || !newBranch.trim()} onClick={() => checkout(newBranch.trim(), true)}>
                  Create
                </button>
              </div>
            )}

            {err && <div className="git-err">{err}</div>}

            <div className="git-lists">
              {staged.length > 0 && (
                <div className="git-group">
                  <div className="git-group-title">
                    <span>Staged Changes</span>
                    <button className="git-group-act" disabled={busy} onClick={() => unstage(staged.map((f) => f.path))}>Unstage all</button>
                  </div>
                  {staged.map((f) => fileRow(f, true))}
                </div>
              )}
              {changes.length > 0 && (
                <div className="git-group">
                  <div className="git-group-title">
                    <span>Changes</span>
                    <button className="git-group-act" disabled={busy} onClick={() => stage(changes.map((f) => f.path))}>Stage all</button>
                  </div>
                  {changes.map((f) => fileRow(f, false))}
                </div>
              )}
              {staged.length === 0 && changes.length === 0 && status?.isRepo && (
                <div className="git-empty">No changes — working tree clean.</div>
              )}
            </div>

            {sel && (
              <div className="git-diff">
                <div className="git-diff-head">{sel.file}{sel.staged ? ' · staged' : ''}</div>
                <pre className="git-diff-body">
                  {diff.split('\n').map((line, i) => <div key={i} className={`git-diff-line ${lineClass(line)}`}>{line || ' '}</div>)}
                </pre>
              </div>
            )}

            <div className="git-commit">
              <textarea
                placeholder="Commit message"
                value={message}
                rows={2}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && message.trim() && staged.length > 0) commit(); }}
              />
              <button className="primary small" disabled={busy || !message.trim() || staged.length === 0} onClick={commit}>
                Commit {staged.length > 0 && `(${staged.length})`}
              </button>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

// Status letter shown on a row. Staged rows report the index code (x),
// unstaged rows the worktree code (y); untracked shows 'U'.
function statChar(f: GitFileStatus, staged: boolean): string {
  if (f.untracked) return 'U';
  const c = staged ? f.x : f.y;
  return c.trim() || '·';
}

function statClass(f: GitFileStatus, staged: boolean): string {
  if (f.untracked) return 'st-add';
  const c = staged ? f.x : f.y;
  if (c === 'A') return 'st-add';
  if (c === 'D') return 'st-del';
  if (c === 'R' || c === 'C') return 'st-ren';
  return 'st-mod';
}

function lineClass(line: string): string {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('rename ') || line.startsWith('similarity ')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return '';
}
