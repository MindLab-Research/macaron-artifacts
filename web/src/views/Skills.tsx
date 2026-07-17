import { useEffect, useState } from 'react';
import { api, type SkillInfo, type SkillDetail } from '../lib/api';
import { useToast } from '../components/Toast';

type Draft = { name: string; description: string; body: string };
const BLANK_DRAFT: Draft = { name: '', description: '', body: '' };

export function Skills() {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(BLANK_DRAFT);
  const [openDir, setOpenDir] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const toast = useToast();

  useEffect(() => {
    api.skills().then((r) => setSkills(r.skills)).catch((e) => setError((e as Error).message));
  }, []);

  const toggle = async (s: SkillInfo, next: boolean) => {
    setBusy(s.dir);
    try {
      const r = await api.setSkillEnabled(s.dir, next);
      setSkills(r.skills);
      toast(`${s.name} ${next ? 'enabled' : 'disabled'}`);
    } catch (e) {
      toast(`error: ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  };

  const openDetail = async (dir: string) => {
    if (openDir === dir) {
      setOpenDir(null);
      setDetail(null);
      return;
    }
    setOpenDir(dir);
    setDetail(null);
    try {
      setDetail(await api.skill(dir));
    } catch (e) {
      toast(`error: ${(e as Error).message}`);
      setOpenDir(null);
    }
  };

  const create = async () => {
    const name = draft.name.trim();
    const description = draft.description.trim();
    if (!name) return toast('name is required');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return toast('name must be lowercase letters, digits and hyphens');
    if (!description) return toast('description is required');
    setBusy('__create__');
    try {
      const r = await api.createSkill({ name, description, body: draft.body.trim() || undefined });
      setSkills(r.skills);
      setDraft(BLANK_DRAFT);
      setCreating(false);
      toast(`created "${r.dir}"`);
    } catch (e) {
      toast(`error: ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  };

  if (error) {
    return (
      <section className="view">
        <div className="ti-error">error: {error}</div>
      </section>
    );
  }
  if (!skills) {
    return (
      <section className="view">
        <p className="muted">Loading…</p>
      </section>
    );
  }

  const enabledCount = skills.filter((s) => s.enabled).length;

  return (
    <section className="view settings-view">
      <header>
        <h1>Skills</h1>
        <p>
          Browse, enable, and author user-scope Claude Code skills under <code>~/.claude/skills</code>. Toggling writes
          a non-destructive user-scope <code>skillOverrides</code> entry to <code>~/.claude/settings.json</code> — the skill files stay put.
        </p>
      </header>

      <div className="settings-section">
        <div className="settings-row-head">
          <h2 className="sec-title">
            Installed skills {skills.length > 0 && <span className="muted">· {enabledCount}/{skills.length} on</span>}
          </h2>
          <button className="primary small" onClick={() => setCreating((v) => !v)} disabled={busy !== ''}>
            {creating ? 'Cancel' : '+ New skill'}
          </button>
        </div>

        {creating && (
          <div className="skill-editor">
            <div className="settings-field">
              <label htmlFor="s-name">Name</label>
              <input
                id="s-name"
                className="settings-input"
                value={draft.name}
                placeholder="my-skill (lowercase, hyphens)"
                spellCheck={false}
                autoCapitalize="off"
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              />
              <p className="settings-hint">Becomes the directory name and the <code>/{draft.name.trim() || 'name'}</code> command.</p>
            </div>
            <div className="settings-field">
              <label htmlFor="s-desc">Description</label>
              <textarea
                id="s-desc"
                className="settings-input skill-textarea"
                value={draft.description}
                placeholder="What the skill does and when Claude should use it."
                rows={2}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              />
            </div>
            <div className="settings-field">
              <label htmlFor="s-body">Instructions <span className="muted">(optional)</span></label>
              <textarea
                id="s-body"
                className="settings-input skill-textarea"
                value={draft.body}
                placeholder="Markdown body. Leave blank to scaffold a starter."
                rows={5}
                onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
              />
            </div>
            <div className="settings-actions">
              <button className="primary" onClick={create} disabled={busy === '__create__'}>
                {busy === '__create__' ? 'Creating…' : 'Create skill'}
              </button>
            </div>
          </div>
        )}

        <div className="prov-list">
          {skills.map((s) => (
            <div key={s.dir} className={`prov-card skill-card${s.enabled ? '' : ' skill-off'}`}>
              <div className="prov-card-body" onClick={() => openDetail(s.dir)} style={{ cursor: 'pointer' }}>
                <div className="prov-card-head">
                  <span className="prov-name">{s.name}</span>
                  {s.source === 'symlink' && <span className="prov-tag">linked</span>}
                  <span className={`prov-tag ${s.enabled ? 'ok' : 'bad'}`}>{s.enabled ? 'on' : 'off'}</span>
                </div>
                <div className="prov-card-sub skill-desc">{s.description || <span className="muted">No description</span>}</div>
              </div>
              <div className="prov-card-actions">
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => openDetail(s.dir)}
                >
                  {openDir === s.dir ? 'Hide' : 'View'}
                </button>
                <button
                  type="button"
                  className={`skill-switch${s.enabled ? ' on' : ''}`}
                  role="switch"
                  aria-checked={s.enabled}
                  aria-label={s.enabled ? `Disable ${s.name}` : `Enable ${s.name}`}
                  disabled={busy === s.dir}
                  onClick={() => toggle(s, !s.enabled)}
                >
                  <span className="skill-switch-knob" />
                </button>
              </div>
              {openDir === s.dir && (
                <div className="skill-detail">
                  {!detail ? (
                    <p className="muted">Loading…</p>
                  ) : (
                    <>
                      {detail.allowedTools && (
                        <div className="skill-meta-row">
                          <span className="skill-meta-key">allowed-tools</span>
                          <code>{detail.allowedTools}</code>
                        </div>
                      )}
                      <div className="skill-meta-row">
                        <span className="skill-meta-key">path</span>
                        <code>{detail.path}</code>
                      </div>
                      <pre className="skill-body">{detail.body || '(empty body)'}</pre>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
          {skills.length === 0 && (
            <p className="muted" style={{ padding: '10px 4px' }}>
              No skills in <code>~/.claude/skills</code> yet. Click "+ New skill" to author one.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
