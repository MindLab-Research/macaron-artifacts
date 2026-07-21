import { useEffect, useState } from 'react';
import { api, fmtAgo, type Schedule, type ScheduleInput, type SessionKind } from '../lib/api';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/Confirm';

const BLANK: ScheduleInput = { name: '', prompt: '', engine: 'claude', cwd: '', pattern: '', oneShot: false };

// claude project encoding mirrors the CLI: every non-alphanumeric char in the
// cwd becomes '-' (e.g. '/a/.codex' → '-a--codex'), not just '/'. Best-effort so
// the last-run deep-link points at the right workspace tile.
function encodeProject(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function fmtWhen(ms: number | null): string {
  if (!ms) return '—';
  const d = Math.floor((ms - Date.now()) / 1000);
  if (d < 0) return 'now';
  if (d < 60) return `in ${d}s`;
  const m = Math.floor(d / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h`;
  return new Date(ms).toLocaleString();
}

export function Schedules() {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  // This launcher only runs its own engine's schedules — the others' SDKs aren't
  // installed. Lock the form to it so a foreign schedule can't be created.
  const [engine, setEngine] = useState<SessionKind>('claude');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<{ id: string | null; draft: ScheduleInput } | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  const load = () => api.schedules().then((r) => { setSchedules(r.schedules); setError(''); }).catch((e) => setError((e as Error).message));

  useEffect(() => {
    load();
    api.engine().then((r) => setEngine(r.engine)).catch(() => {});
    // Poll so nextRunAt / lastStatus reflect the tick as it fires.
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  const openCreate = () => setEditing({ id: null, draft: { ...BLANK, engine } });
  const openEdit = (s: Schedule) =>
    setEditing({ id: s.id, draft: { name: s.name, prompt: s.prompt, engine: s.engine, cwd: s.cwd, pattern: s.pattern, oneShot: s.oneShot } });

  const save = async () => {
    if (!editing) return;
    const d = editing.draft;
    if (!d.name.trim()) return toast('name is required');
    if (!d.prompt.trim()) return toast('prompt is required');
    if (!d.cwd.trim()) return toast('working dir is required');
    if (!d.pattern.trim()) return toast('cron or datetime is required');
    setBusy(true);
    try {
      if (editing.id === null) {
        await api.createSchedule(d);
        toast(`created "${d.name.trim()}"`);
      } else {
        await api.updateSchedule(editing.id, d);
        toast(`updated "${d.name.trim()}"`);
      }
      setEditing(null);
      await load();
    } catch (e) {
      toast(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: Schedule) => {
    const ok = await confirm({
      title: 'Delete schedule?',
      body: <><code>{s.name}</code><div className="confirm-sub">Removes it permanently. Any running session it started keeps running.</div></>,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.deleteSchedule(s.id);
      toast(`deleted "${s.name}"`);
      await load();
    } catch (e) {
      toast(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); await load(); }
    catch (e) { toast(`error: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  if (error) return <section className="view"><div className="ti-error">error: {error}</div></section>;
  if (!schedules) return <section className="view"><p className="muted">Loading…</p></section>;

  return (
    <section className="view settings-view">
      <header>
        <h1>Schedules</h1>
        <p>Run a prompt on a schedule — a cron cadence or a one-time datetime. Each fire starts a fresh session in the target working dir, unattended.</p>
      </header>

      <div className="settings-section">
        <div className="settings-row-head">
          <h2 className="sec-title">Scheduled prompts</h2>
          <button className="primary small" onClick={openCreate} disabled={busy || editing !== null}>+ New schedule</button>
        </div>

        <div className="prov-list">
          {schedules.map((s) => (
            <div key={s.id} className={`prov-card${s.status === 'active' ? ' active' : ''}`}>
              <div className="prov-card-body">
                <div className="prov-card-head">
                  <span className="prov-name">{s.name}</span>
                  <span className="prov-tag">{s.engine}</span>
                  <span className="prov-tag">{s.oneShot ? 'one-time' : 'recurring'}</span>
                  <span className={`prov-tag ${s.status === 'active' ? 'ok' : 'bad'}`}>{s.status}</span>
                </div>
                <div className="prov-card-sub"><code>{s.pattern}</code></div>
                <div className="prov-card-sub">{s.cwd}</div>
                <div className="prov-card-sub">
                  {s.status === 'active' ? `next ${fmtWhen(s.nextRunAt)}` : s.status}
                  {s.lastRunAt && (
                    <> · last run {fmtAgo(s.lastRunAt)} (
                      {s.lastSessionId
                        ? <a href={`#/w/${encodeProject(s.cwd)}/s/${s.lastSessionId}`}>{s.lastStatus}</a>
                        : s.lastStatus}
                    )</>
                  )}
                </div>
              </div>
              <div className="prov-card-actions">
                {s.status === 'active'
                  ? <button type="button" className="ghost small" onClick={() => void act(() => api.pauseSchedule(s.id), 'paused')} disabled={busy}>Pause</button>
                  : s.status === 'paused'
                    ? <button type="button" className="ghost small" onClick={() => void act(() => api.resumeSchedule(s.id), 'resumed')} disabled={busy}>Resume</button>
                    : null}
                <button type="button" className="ghost small" onClick={() => void act(() => api.runScheduleNow(s.id), 'run started')} disabled={busy}>Run now</button>
                <button type="button" className="ghost small" onClick={() => openEdit(s)} disabled={busy || editing !== null}>Edit</button>
                <button type="button" className="ghost small prov-danger" onClick={() => void remove(s)} disabled={busy || editing !== null}>Delete</button>
              </div>
            </div>
          ))}

          {schedules.length === 0 && (
            <p className="muted" style={{ padding: '10px 4px' }}>No schedules yet. Click "+ New schedule" to add one.</p>
          )}
        </div>
      </div>

      {editing && (
        <div className="settings-section prov-editor">
          <h2 className="sec-title">{editing.id === null ? 'New schedule' : 'Edit schedule'}</h2>
          <ScheduleForm draft={editing.draft} onChange={(patch) => setEditing((cur) => (cur ? { ...cur, draft: { ...cur.draft, ...patch } } : cur))} />
          <div className="settings-actions">
            <button className="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : editing.id === null ? 'Create' : 'Save'}</button>
            <button className="ghost" onClick={() => setEditing(null)} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}

function ScheduleForm({ draft, onChange }: { draft: ScheduleInput; onChange: (patch: Partial<ScheduleInput>) => void }) {
  return (
    <>
      <div className="settings-field">
        <label htmlFor="s-name">Name</label>
        <input id="s-name" className="settings-input" value={draft.name} placeholder="e.g. Nightly changelog" onChange={(e) => onChange({ name: e.target.value })} />
      </div>
      <div className="settings-field">
        <label htmlFor="s-prompt">Prompt</label>
        <textarea id="s-prompt" className="settings-input" rows={3} value={draft.prompt} placeholder="What the session should do when it fires" onChange={(e) => onChange({ prompt: e.target.value })} />
      </div>
      <div className="settings-field">
        <label htmlFor="s-cwd">Working directory</label>
        <input id="s-cwd" className="settings-input" value={draft.cwd} placeholder="/abs/path/to/project" spellCheck={false} autoCapitalize="off" onChange={(e) => onChange({ cwd: e.target.value })} />
        <p className="settings-hint">Absolute path. The session spawns here, same as running <code>claude</code> in that dir.</p>
      </div>
      <div className="settings-field">
        <label htmlFor="s-engine">Engine</label>
        <input id="s-engine" className="settings-input" value={draft.engine} readOnly disabled />
        <p className="settings-hint">Fixed to this launcher's engine — it only runs its own engine's sessions.</p>
      </div>
      <div className="settings-field">
        <label>Schedule type</label>
        <div className="settings-input-row">
          <label className="sched-radio"><input type="radio" name="oneShot" checked={!draft.oneShot} onChange={() => onChange({ oneShot: false, pattern: '' })} /> Recurring (cron)</label>
          <label className="sched-radio"><input type="radio" name="oneShot" checked={draft.oneShot} onChange={() => onChange({ oneShot: true, pattern: '' })} /> One-time</label>
        </div>
      </div>
      <div className="settings-field">
        <label htmlFor="s-pattern">{draft.oneShot ? 'Run at (datetime)' : 'Cron expression'}</label>
        {draft.oneShot ? (
          <input id="s-pattern" type="datetime-local" className="settings-input" value={draft.pattern} onChange={(e) => onChange({ pattern: e.target.value })} />
        ) : (
          <input id="s-pattern" className="settings-input" value={draft.pattern} placeholder="e.g. 0 9 * * 1-5  (weekdays 9am)" spellCheck={false} onChange={(e) => onChange({ pattern: e.target.value })} />
        )}
        <p className="settings-hint">{draft.oneShot ? 'Fires once at this local time, then marks itself done.' : '5-field cron in server-local time. Missed runs (server was down) are skipped — only the next slot fires.'}</p>
      </div>
    </>
  );
}
