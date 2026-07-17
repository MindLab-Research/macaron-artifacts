import { useEffect, useState } from 'react';
import { api, type AgentFile, type AgentInput } from '../lib/api';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/Confirm';

const BLANK: AgentInput = { name: '', description: '', tools: [], model: '', prompt: '' };

export function Agents() {
  const [agents, setAgents] = useState<AgentFile[] | null>(null);
  const [error, setError] = useState('');
  // Editor state — creating (id === null) or editing an existing agent (id =
  // its name). null = editor closed.
  const [editing, setEditing] = useState<null | { name: string | null; draft: AgentInput }>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  useEffect(() => {
    api.agents().then((r) => setAgents(r.agents)).catch((e) => setError((e as Error).message));
  }, []);

  const openCreate = () => setEditing({ name: null, draft: { ...BLANK } });

  const openEdit = (a: AgentFile) =>
    setEditing({
      name: a.name,
      draft: { name: a.name, description: a.description, tools: a.tools, model: a.model, prompt: a.prompt },
    });

  const save = async () => {
    if (!editing) return;
    const d = editing.draft;
    if (editing.name === null && !d.name.trim()) return toast('name is required');
    if (editing.name === null && !/^[a-z0-9][a-z0-9-]*$/.test(d.name.trim())) {
      return toast('name must be lowercase letters, digits, and hyphens');
    }
    if (!d.description.trim()) return toast('description is required');
    setBusy(true);
    try {
      if (editing.name === null) {
        const r = await api.createAgent({ ...d, name: d.name.trim(), description: d.description.trim() });
        setAgents(r.agents);
        toast(`created "${d.name.trim()}"`);
      } else {
        const r = await api.updateAgent(editing.name, {
          description: d.description.trim(),
          tools: d.tools,
          model: d.model.trim(),
          prompt: d.prompt,
        });
        setAgents(r.agents);
        toast(`updated "${editing.name}"`);
      }
      setEditing(null);
    } catch (e) {
      toast(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: AgentFile) => {
    const ok = await confirm({
      title: 'Delete subagent?',
      body: (
        <>
          <code>{a.name}</code>
          <div className="confirm-sub">
            Removes <code>~/.claude/agents/{a.name}.md</code>. Claude Code will no longer offer this subagent. Cannot be undone.
          </div>
        </>
      ),
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      setAgents((await api.deleteAgent(a.name)).agents);
      toast(`deleted "${a.name}"`);
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
  if (!agents) {
    return (
      <section className="view">
        <p className="muted">Loading…</p>
      </section>
    );
  }

  return (
    <section className="view settings-view">
      <header>
        <h1>Subagents</h1>
        <p>Custom subagents from <code>~/.claude/agents</code>. Each runs with its own system prompt and tool allowlist; Claude Code spawns one when a task matches its description.</p>
      </header>

      <div className="settings-section">
        <div className="settings-row-head">
          <h2 className="sec-title">Agents</h2>
          <button className="primary small" onClick={openCreate} disabled={busy || editing !== null}>
            + New subagent
          </button>
        </div>

        <div className="prov-list">
          {agents.map((a) => (
            <div key={a.name} className="prov-card">
              <div className="prov-card-body">
                <div className="prov-card-head">
                  <span className="prov-name">{a.name}</span>
                  {a.model && <span className="prov-tag">{a.model}</span>}
                  <span className="prov-tag ok">{a.tools.length ? `${a.tools.length} tools` : 'all tools'}</span>
                </div>
                <div className="prov-card-sub">{a.description || <span className="muted">no description</span>}</div>
              </div>
              <div className="prov-card-actions">
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => openEdit(a)}
                  disabled={busy || editing !== null}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="ghost small prov-danger"
                  onClick={() => void remove(a)}
                  disabled={busy || editing !== null}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}

          {agents.length === 0 && (
            <p className="muted" style={{ padding: '10px 4px' }}>
              No subagents yet. Click "+ New subagent" to create one.
            </p>
          )}
        </div>
      </div>

      {editing && (
        <div className="settings-section prov-editor">
          <h2 className="sec-title">{editing.name === null ? 'New subagent' : `Edit ${editing.name}`}</h2>
          <AgentForm
            draft={editing.draft}
            isNew={editing.name === null}
            onChange={(patch) =>
              setEditing((cur) => (cur ? { ...cur, draft: { ...cur.draft, ...patch } } : cur))
            }
          />
          <div className="settings-actions">
            <button className="primary" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : editing.name === null ? 'Create' : 'Save'}
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

function AgentForm({
  draft,
  isNew,
  onChange,
}: {
  draft: AgentInput;
  isNew: boolean;
  onChange: (patch: Partial<AgentInput>) => void;
}) {
  return (
    <>
      <div className="settings-field">
        <label htmlFor="a-name">Name</label>
        <input
          id="a-name"
          className="settings-input"
          value={draft.name}
          placeholder="e.g. code-reviewer"
          spellCheck={false}
          autoCapitalize="off"
          disabled={!isNew}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        {isNew ? (
          <p className="settings-hint">Lowercase letters, digits, and hyphens. Becomes the filename.</p>
        ) : (
          <p className="settings-hint">Name is the filename and can't be changed.</p>
        )}
      </div>
      <div className="settings-field">
        <label htmlFor="a-desc">Description</label>
        <input
          id="a-desc"
          className="settings-input"
          value={draft.description}
          placeholder="When should Claude delegate to this agent?"
          onChange={(e) => onChange({ description: e.target.value })}
        />
        <p className="settings-hint">Claude reads this to decide when to spawn the subagent.</p>
      </div>
      <div className="settings-field">
        <label htmlFor="a-tools">Tools</label>
        <input
          id="a-tools"
          className="settings-input"
          value={draft.tools.join(', ')}
          placeholder="Read, Grep, Glob, Bash  (blank = inherit all)"
          spellCheck={false}
          onChange={(e) => onChange({ tools: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
        />
        <p className="settings-hint">Comma-separated allowlist. Leave blank to inherit all tools.</p>
      </div>
      <div className="settings-field">
        <label htmlFor="a-model">Model</label>
        <input
          id="a-model"
          className="settings-input"
          value={draft.model}
          placeholder="sonnet, opus, haiku, inherit  (optional)"
          spellCheck={false}
          onChange={(e) => onChange({ model: e.target.value })}
        />
      </div>
      <div className="settings-field">
        <label htmlFor="a-prompt">System prompt</label>
        <textarea
          id="a-prompt"
          className="settings-input agent-prompt"
          value={draft.prompt}
          placeholder="You are a focused code-review agent. …"
          rows={10}
          onChange={(e) => onChange({ prompt: e.target.value })}
        />
        <p className="settings-hint">The markdown body — becomes the subagent's system prompt.</p>
      </div>
    </>
  );
}
