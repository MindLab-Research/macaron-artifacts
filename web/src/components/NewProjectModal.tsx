import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { DirPicker } from './DirPicker';

type Mode = 'create' | 'clone';

// Modal wizard: create an empty project dir or clone a GitHub repo into the
// workspace root, then hand the new project id back so the caller can open a
// session there. Reuses the confirm-* / settings-input styles.
export function NewProjectModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (project: string) => void;
}) {
  const [mode, setMode] = useState<Mode>('create');
  const [name, setName] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Parent dir: where the new project folder gets created. Defaults to the
  // server's PROJECTS_ROOT (typically ~/macaron-projects). User can pick any
  // existing directory via DirPicker. Empty string = "use server default".
  const [parent, setParent] = useState<string>('');
  const [defaultParent, setDefaultParent] = useState<string>('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const firstInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    api.defaultProjectParent().then((r) => setDefaultParent(r.path)).catch(() => {});
  }, []);

  useEffect(() => {
    queueMicrotask(() => firstInputRef.current?.focus());
    setError('');
  }, [mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const canSubmit = mode === 'create' ? name.trim().length > 0 : gitUrl.trim().length > 0;

  const submit = async () => {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError('');
    try {
      const base = mode === 'create'
        ? { name: name.trim() }
        : { gitUrl: gitUrl.trim(), ...(name.trim() ? { name: name.trim() } : {}) };
      const body = parent ? { ...base, parent } : base;
      const r = await api.createProject(body);
      onCreated(r.project);
    } catch (e) {
      // Clone can take a while; surface the server's message verbatim.
      setError((e as Error).message);
      setBusy(false);
    }
  };

  // Portal to body: without this, the modal renders inside whatever
  // called it (Sidebar / Dashboard) and gets trapped under stacking
  // contexts created by the composer's `transform`. Fixed position alone
  // isn't enough — z-index only competes within the current stacking
  // context, and Sidebar/session-input each create their own.
  return createPortal(
    <>
      <div className="confirm-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="confirm-dialog np-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="np-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div id="np-title" className="confirm-title">New Project</div>

        <div className="np-tabs">
          <button
            type="button"
            className={'np-tab' + (mode === 'create' ? ' active' : '')}
            onClick={() => setMode('create')}
            disabled={busy}
          >
            Create new
          </button>
          <button
            type="button"
            className={'np-tab' + (mode === 'clone' ? ' active' : '')}
            onClick={() => setMode('clone')}
            disabled={busy}
          >
            Clone GitHub repo
          </button>
        </div>

        <div className="np-body">
          {mode === 'clone' && (
            <label className="np-field">
              <span>Repository URL</span>
              <input
                ref={firstInputRef}
                className="settings-input"
                placeholder="https://github.com/owner/repo.git"
                value={gitUrl}
                onChange={(e) => setGitUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && submit()}
                disabled={busy}
                spellCheck={false}
                autoCapitalize="off"
              />
            </label>
          )}
          <label className="np-field">
            <span>
              {mode === 'create' ? 'Project name' : 'Folder name'}
              {mode === 'clone' && <em className="np-optional"> (optional — defaults to the repo name)</em>}
            </span>
            <input
              ref={mode === 'create' ? firstInputRef : undefined}
              className="settings-input"
              placeholder={mode === 'create' ? 'my-project' : 'repo'}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && submit()}
              disabled={busy}
              spellCheck={false}
              autoCapitalize="off"
            />
          </label>
          <div className="np-field">
            <span>Location</span>
            <div className="np-location">
              <code className="np-location-path" title={parent || defaultParent}>
                {parent || defaultParent || '(loading…)'}
              </code>
              <button
                type="button"
                className="np-location-btn"
                onClick={() => setPickerOpen(true)}
                disabled={busy}
              >
                Change
              </button>
              {parent && (
                <button
                  type="button"
                  className="np-location-btn ghost"
                  onClick={() => setParent('')}
                  disabled={busy}
                  title="Reset to default"
                >
                  Reset
                </button>
              )}
            </div>
          </div>
          <p className="np-hint">
            {mode === 'create'
              ? 'Creates an empty directory inside the location above, then opens a session there.'
              : 'Clones the repo into the location above over HTTPS/SSH, then opens a session there.'}
          </p>
          {error && <p className="np-error">{error}</p>}
        </div>

        <div className="confirm-actions">
          <button className="ghost" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" type="button" onClick={submit} disabled={!canSubmit || busy}>
            {busy ? (mode === 'clone' ? 'Cloning…' : 'Creating…') : mode === 'clone' ? 'Clone & open' : 'Create & open'}
          </button>
        </div>
      </div>
    </div>
    {/* Rendered AFTER the modal so DOM paint order puts it on top when both
        share the same z-index tier. Also gets --z-modal-nested via the
        .above-modal class so a triple-nest could raise it further. */}
    {pickerOpen && (
      <div className="above-modal">
        <DirPicker
          onPick={(p) => { setParent(p); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
        />
      </div>
    )}
    </>,
    document.body,
  );
}
