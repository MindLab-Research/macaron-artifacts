import { useEffect, useRef, useState } from 'react';
import type { PrContext } from '../lib/api';

// Modal for the "Create PR" action. Confirm can't host inputs, so this is its
// own component. Reuses the .confirm-* backdrop/dialog and .settings-* field
// styles already in styles.css. Title/body arrive prefilled from the session;
// the user can edit before submitting.
export function CreatePrDialog({
  ctx,
  initialTitle,
  initialBody,
  busy,
  onSubmit,
  onCancel,
}: {
  ctx: PrContext;
  initialTitle: string;
  initialBody: string;
  busy: boolean;
  onSubmit: (input: { title: string; body: string; draft: boolean }) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [draft, setDraft] = useState(false);
  const titleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    queueMicrotask(() => titleRef.current?.focus());
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const detached = ctx.branch === 'HEAD';
  const canSubmit =
    title.trim().length > 0 &&
    ctx.ahead !== null &&
    ctx.ahead > 0 &&
    ctx.branch !== ctx.defaultBranch &&
    !detached &&
    !busy;

  return (
    <div className="confirm-backdrop" onClick={onCancel}>
      <div
        className="confirm-dialog pr-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pr-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div id="pr-dialog-title" className="confirm-title">Create pull request</div>

        <div className="pr-branch-line">
          <code>{ctx.branch}</code> <span className="pr-arrow">→</span> <code>{ctx.defaultBranch}</code>
          {ctx.ahead !== null && (
            <span className="pr-ahead">
              · {ctx.ahead} commit{ctx.ahead === 1 ? '' : 's'}
            </span>
          )}
        </div>

        {ctx.existingPrUrl ? (
          <div className="pr-note">
            A PR already exists for this branch —{' '}
            <a href={ctx.existingPrUrl} target="_blank" rel="noreferrer">view it</a>.
          </div>
        ) : (
          <>
            {detached && (
              <div className="pr-note pr-note-warn">
                You're on a detached HEAD — check out a branch to open a PR.
              </div>
            )}
            {ctx.branch === ctx.defaultBranch && (
              <div className="pr-note pr-note-warn">
                You're on the default branch — switch to a feature branch to open a PR.
              </div>
            )}
            {ctx.ahead === null && !detached && ctx.branch !== ctx.defaultBranch && (
              <div className="pr-note pr-note-warn">
                Couldn't resolve the base branch ({ctx.defaultBranch}) to compare against.
              </div>
            )}
            {ctx.ahead === 0 && !detached && ctx.branch !== ctx.defaultBranch && (
              <div className="pr-note pr-note-warn">
                No commits ahead of {ctx.defaultBranch} yet — nothing to include.
              </div>
            )}
            {ctx.dirty && (
              <div className="pr-note pr-note-warn">
                Uncommitted changes won't be included — commit them first if you want them in the PR.
              </div>
            )}

            <div className="settings-field">
              <label className="pr-label">Title</label>
              <input
                ref={titleRef}
                className="settings-input"
                value={title}
                disabled={busy}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Pull request title"
              />
            </div>
            <div className="settings-field">
              <label className="pr-label">Description</label>
              <textarea
                className="settings-input pr-body"
                rows={7}
                value={body}
                disabled={busy}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Describe the change…"
              />
            </div>
            <label className="pr-draft">
              <input type="checkbox" checked={draft} disabled={busy} onChange={(e) => setDraft(e.target.checked)} />
              Create as draft
            </label>
          </>
        )}

        <div className="confirm-actions">
          <button className="ghost" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          {!ctx.existingPrUrl && (
            <button
              className="primary"
              type="button"
              disabled={!canSubmit}
              onClick={() => onSubmit({ title: title.trim(), body, draft })}
            >
              {busy ? 'Creating…' : draft ? 'Create draft PR' : 'Create PR'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
