import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConfirm } from '../components/Confirm';
import {
  kimiApi,
  type KimiProviderType,
  type PublicKimiBuiltin,
  type PublicKimiProvider,
  type PublicKimiSettings,
} from './api';

const PROVIDER_TYPES = ['kimi', 'anthropic', 'openai'] as const;

const SYSTEM_ID = 'system';

export function KimiSettings() {
  const [settings, setSettings] = useState<PublicKimiSettings | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [msg, setMsg] = useState('');

  const refresh = useCallback(async () => {
    try {
      const s = await kimiApi.config();
      setSettings(s);
      // Keep whatever the user was inspecting; fall back to active on first
      // load or when the previous selection got deleted.
      setSelectedId((cur) => {
        if (cur && (cur === SYSTEM_ID || s.customProviders.some((p) => p.id === cur))) return cur;
        return s.activeProviderId;
      });
    } catch { /* nop */ }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const flash = useCallback((text: string) => {
    setMsg(text);
    window.setTimeout(() => setMsg((cur) => (cur === text ? '' : cur)), 2200);
  }, []);

  if (!settings) return <div className="kx-settings"><div className="kx-settings-loading">Loading…</div></div>;

  const builtin = settings.builtins[0];
  const selected = selectedId === SYSTEM_ID
    ? null
    : settings.customProviders.find((p) => p.id === selectedId) ?? null;

  const setActive = async (id: string) => {
    try {
      const s = await kimiApi.setActive(id);
      setSettings(s);
      flash(id === SYSTEM_ID ? 'Switched to System default' : `Switched to ${s.customProviders.find((p) => p.id === id)?.name ?? id}`);
    } catch (e) {
      flash(`Switch failed: ${(e as Error).message}`);
    }
  };

  const addProvider = async () => {
    try {
      const { id, settings: s } = await kimiApi.createProvider({ name: 'New provider' });
      setSettings(s);
      setSelectedId(id);
      flash('Provider added');
    } catch (e) {
      flash(`Add failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="kx-settings">
      <header className="kx-settings-head">
        <h1>Kimi Settings</h1>
        <div className="kx-settings-sub">
          Pick which provider new threads use, or fall back to System default (your ambient Kimi Code CLI login).
        </div>
      </header>

      <div className="kx-settings-grid">
        <ProviderList
          builtin={builtin!}
          providers={settings.customProviders}
          activeId={settings.activeProviderId}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onSetActive={setActive}
          onAdd={addProvider}
        />
        <div className="kx-settings-pane">
          {selectedId === SYSTEM_ID
            ? <SystemPane builtin={builtin!} isActive={settings.activeProviderId === SYSTEM_ID} onSetActive={() => setActive(SYSTEM_ID)} />
            : selected
              ? <ProviderPane
                  key={selected.id}
                  provider={selected}
                  isActive={settings.activeProviderId === selected.id}
                  onSetActive={() => setActive(selected.id)}
                  onAfterMutate={(next) => setSettings(next)}
                  onDeleted={async () => {
                    await refresh();
                    setSelectedId(settings.activeProviderId);
                  }}
                  flash={flash}
                />
              : <div className="kx-settings-empty">Select a provider on the left.</div>}
        </div>
      </div>

      {msg && <div className="kx-settings-flash">{msg}</div>}
    </div>
  );
}

// -------- Left pane: the provider list --------

function ProviderList({
  builtin,
  providers,
  activeId,
  selectedId,
  onSelect,
  onSetActive,
  onAdd,
}: {
  builtin: PublicKimiBuiltin;
  providers: PublicKimiProvider[];
  activeId: string;
  selectedId: string;
  onSelect: (id: string) => void;
  onSetActive: (id: string) => void;
  onAdd: () => void;
}) {
  const isSel = (id: string) => selectedId === id;
  const isAct = (id: string) => activeId === id;
  return (
    <aside className="kx-settings-list">
      <div className="kx-settings-list-label">BUILT-IN</div>
      <button
        type="button"
        className={'kx-plist-row' + (isSel(SYSTEM_ID) ? ' selected' : '') + (isAct(SYSTEM_ID) ? ' active' : '')}
        onClick={() => onSelect(SYSTEM_ID)}
        onDoubleClick={() => onSetActive(SYSTEM_ID)}
      >
        <div className="kx-plist-row-main">
          <span className="kx-plist-row-name">{builtin.name}</span>
          {isAct(SYSTEM_ID) && <span className="kx-plist-active-badge">active</span>}
        </div>
        <div className="kx-plist-row-sub">
          ambient OAuth login
        </div>
      </button>

      <div className="kx-settings-list-label">CUSTOM</div>
      {providers.length === 0 && <div className="kx-plist-empty">No custom providers yet.</div>}
      {providers.map((p) => (
        <button
          key={p.id}
          type="button"
          className={'kx-plist-row' + (isSel(p.id) ? ' selected' : '') + (isAct(p.id) ? ' active' : '')}
          onClick={() => onSelect(p.id)}
          onDoubleClick={() => onSetActive(p.id)}
        >
          <div className="kx-plist-row-main">
            <span className="kx-plist-row-name">{p.name}</span>
            {isAct(p.id) && <span className="kx-plist-active-badge">active</span>}
            {!p.configured && <span className="kx-plist-warn">no key</span>}
          </div>
          <div className="kx-plist-row-sub">{p.model} · {p.baseUrl || '(no url)'}</div>
        </button>
      ))}

      <button type="button" className="kx-plist-add" onClick={onAdd}>+ Add provider</button>
    </aside>
  );
}

// -------- Right pane: system provider (read-only) --------

function SystemPane({
  builtin,
  isActive,
  onSetActive,
}: {
  builtin: PublicKimiBuiltin;
  isActive: boolean;
  onSetActive: () => void;
}) {
  return (
    <section className="kx-settings-section">
      <div className="kx-section-head">
        <h2>System default</h2>
        {isActive
          ? <span className="kx-active-pill">Active</span>
          : <button className="kx-btn primary" onClick={onSetActive}>Use this</button>}
      </div>
      <p className="kx-section-body">{builtin.description}</p>
      <dl className="kx-kv">
        <dt>Detected model</dt>
        <dd>{builtin.detectedModel || <em>none</em>}</dd>
      </dl>
      <p className="kx-section-note">
        Nothing to edit here — the pass-through provider inherits everything from your existing Kimi Code CLI login.
        Add a Custom provider on the left if you want to override.
      </p>
    </section>
  );
}

// -------- Right pane: custom provider edit --------

function ProviderPane({
  provider,
  isActive,
  onSetActive,
  onAfterMutate,
  onDeleted,
  flash,
}: {
  provider: PublicKimiProvider;
  isActive: boolean;
  onSetActive: () => void;
  onAfterMutate: (next: PublicKimiSettings) => void;
  onDeleted: () => void;
  flash: (msg: string) => void;
}) {
  const [draft, setDraft] = useState<PublicKimiProvider>(provider);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const confirm = useConfirm();
  useEffect(() => { setDraft(provider); setApiKey(''); }, [provider]);

  const set = <K extends keyof PublicKimiProvider>(k: K, v: PublicKimiProvider[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
  };
  const dirty = useMemo(() => {
    const keys: (keyof PublicKimiProvider)[] = ['name', 'model', 'baseUrl', 'providerType'];
    return apiKey.length > 0 || keys.some((k) => draft[k] !== provider[k]);
  }, [draft, provider, apiKey]);

  const save = async () => {
    setSaving(true);
    try {
      const patch: Partial<PublicKimiProvider> & { apiKey?: string } = {
        name: draft.name,
        model: draft.model,
        baseUrl: draft.baseUrl,
        providerType: draft.providerType,
      };
      if (apiKey) patch.apiKey = apiKey;
      const s = await kimiApi.updateProvider(provider.id, patch);
      onAfterMutate(s);
      setApiKey('');
      flash('Saved');
    } catch (e) {
      flash(`Save failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    const ok = await confirm({
      title: 'Delete provider?',
      body: <>Provider <code>{provider.name}</code> will be removed. This can't be undone.</>,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await kimiApi.deleteProvider(provider.id);
      onDeleted();
      flash('Deleted');
    } catch (e) {
      flash(`Delete failed: ${(e as Error).message}`);
    }
  };

  return (
    <section className="kx-settings-section">
      <div className="kx-section-head">
        <h2>{draft.name || 'Custom provider'}</h2>
        {isActive
          ? <span className="kx-active-pill">Active</span>
          : <button className="kx-btn primary" onClick={onSetActive}>Use this</button>}
      </div>

      <div className="kx-field-row">
        <div className="kx-field">
          <label>Name</label>
          <input value={draft.name} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div className="kx-field">
          <label>Provider type</label>
          <select value={draft.providerType} onChange={(e) => set('providerType', e.target.value as KimiProviderType)}>
            {PROVIDER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <small>The API dialect Kimi Code speaks to this endpoint.</small>
        </div>
      </div>

      <div className="kx-field">
        <label>Base URL</label>
        <input
          value={draft.baseUrl}
          onChange={(e) => set('baseUrl', e.target.value)}
          placeholder="https://api.example.com/v1"
        />
        <small>Most OpenAI-compatible proxies require the trailing <code>/v1</code>.</small>
      </div>

      <div className="kx-field">
        <label>API key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={provider.configured ? '••••••• (leave blank to keep current)' : 'Paste your bearer token'}
        />
      </div>

      <div className="kx-field">
        <label>Model</label>
        <input value={draft.model} onChange={(e) => set('model', e.target.value)} />
      </div>

      <div className="kx-section-actions">
        <button className="kx-btn primary" onClick={save} disabled={saving || !dirty}>
          {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
        </button>
        <button className="kx-btn danger" onClick={del}>Delete</button>
      </div>
    </section>
  );
}
