import { CornerLeftUp, Folder } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, type DirListing } from '../lib/api';

// Finder-style folder picker. Browses the server's filesystem via
// GET /api/fs/dirs and resolves with the chosen absolute path. Reuses the
// confirm-backdrop/dialog shell so it inherits the app's modal styling.
export function DirPicker({ onPick, onClose }: { onPick: (cwd: string) => void; onClose: () => void }) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const browse = useCallback((path?: string) => {
    setLoading(true);
    setError('');
    setListing(null);
    api
      .listDirs(path)
      .then((d) => setListing(d))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => browse(), [browse]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const cur = listing?.path ?? '';

  return (
    <div className="confirm-backdrop" onClick={onClose}>
      <div className="confirm-dialog dir-picker" role="dialog" aria-modal="true" aria-label="Choose a folder" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-title">Choose a folder</div>
        <div className="dir-picker-path" title={cur}>{cur || '…'}</div>
        <div className="dir-picker-list">
          {listing?.parent && (
            <button type="button" className="dir-picker-row dir-picker-up" onClick={() => browse(listing.parent!)}>
              <span className="dir-picker-icon"><CornerLeftUp size={13} aria-hidden="true"/></span>
              <span className="dir-picker-name">..</span>
            </button>
          )}
          {listing?.entries.map((d) => (
            <button
              type="button"
              key={d.path}
              className="dir-picker-row"
              onClick={() => browse(d.path)}
              onDoubleClick={() => onPick(d.path)}
              title={d.name}
            >
              <span className="dir-picker-icon"><Folder size={13} aria-hidden="true"/></span>
              <span className="dir-picker-name">{d.name}</span>
            </button>
          ))}
          {error && !loading && <div className="dir-picker-empty">error: {error}</div>}
          {listing && !loading && listing.entries.length === 0 && (
            <div className="dir-picker-empty">No sub-folders here.</div>
          )}
          {loading && <div className="dir-picker-empty">Loading…</div>}
        </div>
        <div className="confirm-actions">
          <button className="ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="button" disabled={!cur} onClick={() => cur && onPick(cur)}>Use this folder</button>
        </div>
      </div>
    </div>
  );
}
