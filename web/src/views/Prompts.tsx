import { useEffect, useState } from 'react';
import { api, type SavedCommand, type CommandInput } from '../lib/api';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/Confirm';

type Draft = { name: string; description: string; argumentHint: string; body: string };

const BLANK: Draft = { name: '', description: '', argumentHint: '', body: '' };

// Editor is open when editing !== null. `name` is fixed once created (it's the
// filename → the `/slash` name), so rename = delete + recreate, out of scope
// for this slice. `isNew` distinguishes create (name editable) from edit.
type Editing = { isNew: boolean; draft: Draft };

export function Prompts() {
  const [commands, setCommands] = useState<SavedCommand[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  const load = () => api.savedCommands().then((r) => setCommands(r.commands)).catch((e) => setError((e as Error).message));
  useEffect(() => { load(); }, []);

  const openCreate = () => setEditing({ isNew: true, draft: { ...BLANK } });
  const openEdit = (c: SavedCommand) =>
    setEditing({ isNew: false, draft: { name: c.name, description: c.description, argumentHint: c.argumentHint, body: c.body } });

  const save = async () => {
    if (!editing) return;
    const d = editing.draft;
    if (!d.body.trim()) return toast('prompt body is required');
    const input: CommandInput = { description: d.description.trim(), argumentHint: d.argumentHint.trim(), body: d.body };
    setBusy(true);
    try {
      if (editing.isNew) {
        const name = d.name.trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(name) || name.length > 64) {
          setBusy(false);
          return toast('name: lowercase letters, digits, dash or underscore, max 64 chars');
        }
        await api.createCommand(name, input);
        toast(`saved /${name}`);
      } else {
        await api.updateCommand(d.name, input);
        toast(`updated /${d.name}`);
      }
      setEditing(null);
      load();
    } catch (e) {
      toast(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c: SavedCommand) => {
    const ok = await confirm({
      title: 'Delete prompt?',
      body: (
        <>
          <code>/{c.name}</code>
          <div className="confirm-sub">
            Removes <code>~/.claude/commands/{c.name}.md</code>. Cannot be undone.
          </div>
        </>
      ),
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.deleteCommand(c.name);
      toast(`deleted /${c.name}`);
      load();
    } catch (e) {
      toast(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <section className="view">
        <div className="ti-error">error: {error}</div>
      </section>
    );
  }
  if (!commands) {
    return (
      <section className="view">
        <p className="muted">Loading…</p>
      </section>
    );
  }

  return (
    <section className="view settings-view">
      <header>
        <h1>Prompts</h1>
        <p>
          Saved prompts and custom slash commands. Each is a <code>.md</code> file in <code>~/.claude/commands/</code>, invoked as <code>/name</code> in any session. Use <code>$ARGUMENTS</code> (or <code>$1</code>, <code>$2</code>) in the body to interpolate what the user types after the command.
        </p>
      </header>

      <div className="settings-section">
        <div className="settings-row-head">
          <h2 className="sec-title">Library</h2>
          <button className="primary small" onClick={openCreate} disabled={busy || editing !== null}>
            + New prompt
          </button>
        </div>

        <div className="prov-list">
          {commands.map((c) => (
            <div key={c.name} className="prov-card">
              <div className="prov-card-body">
                <div className="prov-card-head">
                  <span className="prov-name">/{c.name}</span>
                  {c.argumentHint && <span className="prov-tag">{c.argumentHint}</span>}
                </div>
                <div className="prov-card-sub">{c.description || <span className="muted-inline">No description</span>}</div>
              </div>
              <div className="prov-card-actions">
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => openEdit(c)}
                  disabled={busy || editing !== null}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="ghost small prov-danger"
                  onClick={() => void remove(c)}
                  disabled={busy || editing !== null}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}

          {commands.length === 0 && (
            <p className="muted" style={{ padding: '10px 4px' }}>
              No saved prompts yet. Click "+ New prompt" to author one.
            </p>
          )}
        </div>
      </div>

      {editing && (
        <div className="settings-section prov-editor">
          <h2 className="sec-title">{editing.isNew ? 'New prompt' : `Edit /${editing.draft.name}`}</h2>
          <PromptForm
            draft={editing.draft}
            isNew={editing.isNew}
            onChange={(patch) => setEditing((cur) => (cur ? { ...cur, draft: { ...cur.draft, ...patch } } : cur))}
          />
          <div className="settings-actions">
            <button className="primary" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : editing.isNew ? 'Create' : 'Save'}
            </button>
            <button className="ghost" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function PromptForm({
  draft,
  isNew,
  onChange,
}: {
  draft: Draft;
  isNew: boolean;
  onChange: (patch: Partial<Draft>) => void;
}) {
  return (
    <>
      <div className="settings-field">
        <label htmlFor="c-name">Command name</label>
        <input
          id="c-name"
          className="settings-input"
          value={draft.name}
          placeholder="e.g. review-pr, explain-bug"
          spellCheck={false}
          autoCapitalize="off"
          disabled={!isNew}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <p className="settings-hint">
          {isNew
            ? <>Invoked as <code>/{draft.name.trim() || 'name'}</code>. Lowercase letters, digits, dash or underscore, max 64 chars.</>
            : <>Rename isn't supported yet — delete and recreate to change the name.</>}
        </p>
      </div>
      <div className="settings-field">
        <label htmlFor="c-desc">Description</label>
        <input
          id="c-desc"
          className="settings-input"
          value={draft.description}
          placeholder="Shown in the / palette — e.g. Review a PR for correctness and risk"
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </div>
      <div className="settings-field">
        <label htmlFor="c-hint">Argument hint</label>
        <input
          id="c-hint"
          className="settings-input"
          value={draft.argumentHint}
          placeholder="e.g. <PR number or URL>"
          spellCheck={false}
          onChange={(e) => onChange({ argumentHint: e.target.value })}
        />
        <p className="settings-hint">Optional. Placeholder shown next to the command name.</p>
      </div>
      <div className="settings-field">
        <label htmlFor="c-body">Prompt</label>
        <textarea
          id="c-body"
          className="settings-input prompt-body"
          value={draft.body}
          rows={10}
          placeholder={'Review pull request $ARGUMENTS.\n\nFor each changed file, read the surrounding code and flag correctness, style, and risk issues.'}
          spellCheck={false}
          onChange={(e) => onChange({ body: e.target.value })}
        />
        <p className="settings-hint">
          The prompt template. <code>$ARGUMENTS</code> expands to everything typed after the command; <code>$1</code>, <code>$2</code> to positional args.
        </p>
      </div>
    </>
  );
}
