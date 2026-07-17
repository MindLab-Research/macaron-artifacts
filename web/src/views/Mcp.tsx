import { useEffect, useState } from 'react';
import { api, type McpServerInput, type McpTransport, type PublicMcpServer } from '../lib/api';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/Confirm';

type KvRow = { key: string; value: string; saved: boolean };
type Draft = {
  name: string;
  transport: McpTransport;
  command: string;
  argsText: string; // one arg per line
  url: string;
  env: KvRow[];
  headers: KvRow[];
};

const BLANK_DRAFT: Draft = { name: '', transport: 'stdio', command: '', argsText: '', url: '', env: [], headers: [] };

function toDraft(s: PublicMcpServer): Draft {
  const kv = (m?: Record<string, string>): KvRow[] =>
    Object.keys(m || {}).map((key) => ({ key, value: '', saved: true }));
  return {
    name: s.name,
    transport: s.transport,
    command: s.command || '',
    argsText: (s.args || []).join('\n'),
    url: s.url || '',
    env: kv(s.env),
    headers: kv(s.headers),
  };
}

function rowsToRecord(rows: KvRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (k) out[k] = r.value;
  }
  return out;
}

export function Mcp() {
  const [servers, setServers] = useState<PublicMcpServer[] | null>(null);
  const [error, setError] = useState('');
  // editing: { oldName: null } = creating; { oldName: string } = editing.
  const [editing, setEditing] = useState<null | { oldName: string | null; draft: Draft }>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  useEffect(() => {
    api.mcpServers().then((r) => setServers(r.servers)).catch((e) => setError((e as Error).message));
  }, []);

  const openCreate = () => setEditing({ oldName: null, draft: { ...BLANK_DRAFT, env: [], headers: [] } });
  const openEdit = (s: PublicMcpServer) => setEditing({ oldName: s.name, draft: toDraft(s) });

  const patchDraft = (patch: Partial<Draft>) =>
    setEditing((cur) => (cur ? { ...cur, draft: { ...cur.draft, ...patch } } : cur));

  const save = async () => {
    if (!editing) return;
    const d = editing.draft;
    const name = d.name.trim();
    if (!name) return toast('name is required');
    if (d.transport === 'stdio' && !d.command.trim()) return toast('command is required for stdio');
    if (d.transport !== 'stdio' && !d.url.trim()) return toast('url is required');
    const input: McpServerInput = {
      name,
      transport: d.transport,
      command: d.transport === 'stdio' ? d.command.trim() : undefined,
      args: d.transport === 'stdio' ? d.argsText.split('\n').map((a) => a.trim()).filter(Boolean) : undefined,
      url: d.transport !== 'stdio' ? d.url.trim() : undefined,
      env: d.transport === 'stdio' ? rowsToRecord(d.env) : undefined,
      headers: d.transport !== 'stdio' ? rowsToRecord(d.headers) : undefined,
    };
    setBusy(true);
    try {
      const r = editing.oldName === null
        ? await api.addMcpServer(input)
        : await api.updateMcpServer(editing.oldName, input);
      setServers(r.servers);
      toast(editing.oldName === null ? `added "${name}"` : `updated "${name}"`);
      setEditing(null);
    } catch (e) {
      toast(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: PublicMcpServer) => {
    const ok = await confirm({
      title: 'Delete MCP server?',
      body: (
        <>
          <code>{s.name}</code>
          <div className="confirm-sub">
            Removes it from <code>~/.claude.json</code>. Claude Code sessions will no longer load its tools. Cannot be undone.
          </div>
        </>
      ),
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.deleteMcpServer(s.name);
      setServers(r.servers);
      toast(`deleted "${s.name}"`);
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
  if (!servers) {
    return (
      <section className="view">
        <p className="muted">Loading…</p>
      </section>
    );
  }

  return (
    <section className="view settings-view">
      <header>
        <h1>MCP servers</h1>
        <p>Manage the Model Context Protocol servers Claude Code sessions load, stored in <code>~/.claude.json</code>. Secrets in <code>env</code>/<code>headers</code> are hidden — leave a field blank to keep the saved value.</p>
      </header>

      <div className="settings-section">
        <div className="settings-row-head">
          <h2 className="sec-title">Servers</h2>
          <button className="primary small" onClick={openCreate} disabled={busy || editing !== null}>
            + Add server
          </button>
        </div>

        <div className="prov-list">
          {servers.map((s) => (
            <div key={s.name} className="prov-card">
              <div className="prov-card-body">
                <div className="prov-card-head">
                  <span className="prov-name">{s.name}</span>
                  <span className="prov-tag">{s.transport}</span>
                  {s.alwaysLoad && <span className="prov-tag ok">alwaysLoad</span>}
                </div>
                <div className="prov-card-sub">
                  {s.transport === 'stdio' ? (
                    <code>{[s.command, ...(s.args || [])].filter(Boolean).join(' ')}</code>
                  ) : (
                    <code>{s.url}</code>
                  )}
                </div>
                {(() => {
                  const keys = Object.keys((s.transport === 'stdio' ? s.env : s.headers) || {});
                  if (!keys.length) return null;
                  const label = s.transport === 'stdio' ? 'env' : 'headers';
                  return (
                    <div className="prov-card-sub muted">
                      {label}: {keys.map((k) => <code key={k} className="mcp-kv-chip">{k}</code>)}
                    </div>
                  );
                })()}
              </div>
              <div className="prov-card-actions">
                <button type="button" className="ghost small" onClick={() => openEdit(s)} disabled={busy || editing !== null}>
                  Edit
                </button>
                <button type="button" className="ghost small prov-danger" onClick={() => void remove(s)} disabled={busy || editing !== null}>
                  Delete
                </button>
              </div>
            </div>
          ))}

          {servers.length === 0 && (
            <p className="muted" style={{ padding: '10px 4px' }}>
              No MCP servers configured. Click "+ Add server" to add one.
            </p>
          )}
        </div>
      </div>

      {editing && (
        <div className="settings-section prov-editor">
          <h2 className="sec-title">{editing.oldName === null ? 'Add server' : 'Edit server'}</h2>
          <McpForm draft={editing.draft} onChange={patchDraft} />
          <div className="settings-actions">
            <button className="primary" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : editing.oldName === null ? 'Create' : 'Save'}
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

function KvEditor({
  label,
  rows,
  onChange,
}: {
  label: string;
  rows: KvRow[];
  onChange: (rows: KvRow[]) => void;
}) {
  const set = (i: number, patch: Partial<KvRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = () => onChange([...rows, { key: '', value: '', saved: false }]);
  const del = (i: number) => onChange(rows.filter((_, j) => j !== i));
  return (
    <div className="settings-field">
      <label>{label}</label>
      {rows.map((r, i) => (
        <div key={i} className="settings-input-row mcp-kv-row">
          <input
            className="settings-input"
            value={r.key}
            placeholder="KEY"
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => set(i, { key: e.target.value })}
          />
          <input
            className="settings-input"
            type="password"
            value={r.value}
            placeholder={r.saved ? '••••••  (saved — blank keeps it)' : 'value'}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => set(i, { value: e.target.value })}
          />
          <button type="button" className="ghost small prov-danger" onClick={() => del(i)}>Remove</button>
        </div>
      ))}
      <button type="button" className="ghost small" onClick={add}>+ Add {label.replace(/s$/, '')}</button>
    </div>
  );
}

function McpForm({ draft, onChange }: { draft: Draft; onChange: (patch: Partial<Draft>) => void }) {
  return (
    <>
      <div className="settings-field">
        <label htmlFor="m-name">Name</label>
        <input
          id="m-name"
          className="settings-input"
          value={draft.name}
          placeholder="e.g. github, sentry, my-server"
          spellCheck={false}
          autoCapitalize="off"
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <p className="settings-hint">Letters, digits, dot, dash, underscore.</p>
      </div>

      <div className="settings-field">
        <label htmlFor="m-transport">Transport</label>
        <select
          id="m-transport"
          className="settings-input"
          value={draft.transport}
          onChange={(e) => onChange({ transport: e.target.value as McpTransport })}
        >
          <option value="stdio">stdio (local command)</option>
          <option value="http">http (remote URL)</option>
          <option value="sse">sse (remote URL)</option>
        </select>
      </div>

      {draft.transport === 'stdio' ? (
        <>
          <div className="settings-field">
            <label htmlFor="m-command">Command</label>
            <input
              id="m-command"
              className="settings-input"
              value={draft.command}
              placeholder="e.g. npx, uvx, /usr/bin/my-mcp"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => onChange({ command: e.target.value })}
            />
          </div>
          <div className="settings-field">
            <label htmlFor="m-args">Arguments</label>
            <textarea
              id="m-args"
              className="settings-input"
              rows={3}
              value={draft.argsText}
              placeholder={'one per line, e.g.\n-y\nmy-mcp-server'}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => onChange({ argsText: e.target.value })}
            />
            <p className="settings-hint">One argument per line.</p>
          </div>
          <KvEditor label="Environment variables" rows={draft.env} onChange={(env) => onChange({ env })} />
        </>
      ) : (
        <>
          <div className="settings-field">
            <label htmlFor="m-url">URL</label>
            <input
              id="m-url"
              className="settings-input"
              value={draft.url}
              placeholder="https://mcp.example.com/mcp"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => onChange({ url: e.target.value })}
            />
          </div>
          <KvEditor label="Headers" rows={draft.headers} onChange={(headers) => onChange({ headers })} />
        </>
      )}
    </>
  );
}
