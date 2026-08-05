import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConfirm } from '../components/Confirm';
import {
  codexApi,
  type CodexApprovalPolicy,
  type CodexReasoningEffort,
  type CodexRuntimeOptions,
  type CodexSandboxMode,
  type PublicCodexBuiltin,
  type PublicCodexProvider,
  type PublicCodexSettings,
} from './api';
// Engine-agnostic Preferences sections reused from the Claude Settings view.
// They talk to user-scope endpoints (/api/tunnel, /api/config-files,
// /api/push) that both bundles' users share on the same machine, so a Codex
// user can flip theme / push / tunnel / config files without leaving the app.
import { RemoteAccess, ConfigFilesSection, SoundSettings } from '../views/Settings';
import { useTheme, setTheme, type Theme } from '../lib/theme';
import { getPushState, subscribeToPush, unsubscribeFromPush, type PushState } from '../lib/pwa';
import { useToast } from '../components/Toast';

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const REASONING = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const SANDBOX = ['read-only', 'workspace-write', 'danger-full-access'] as const;
const APPROVAL = ['never', 'on-request', 'on-failure', 'untrusted'] as const;
const WIRE = ['responses', 'chat'] as const;

const SYSTEM_ID = 'system';

export function CodexSettings() {
  const [settings, setSettings] = useState<PublicCodexSettings | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [msg, setMsg] = useState('');

  const refresh = useCallback(async () => {
    try {
      const s = await codexApi.config();
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

  if (!settings) return <div className="cx-settings"><div className="cx-settings-loading">Loading…</div></div>;

  const builtin = settings.builtins[0];
  const selected = selectedId === SYSTEM_ID
    ? null
    : settings.customProviders.find((p) => p.id === selectedId) ?? null;

  const setActive = async (id: string) => {
    try {
      const s = await codexApi.setActive(id);
      setSettings(s);
      flash(id === SYSTEM_ID ? 'Switched to System default' : `Switched to ${s.customProviders.find((p) => p.id === id)?.name ?? id}`);
    } catch (e) {
      flash(`Switch failed: ${(e as Error).message}`);
    }
  };

  const addProvider = async () => {
    try {
      const { id, settings: s } = await codexApi.createProvider({ name: 'New provider' });
      setSettings(s);
      setSelectedId(id);
      flash('Provider added');
    } catch (e) {
      flash(`Add failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="cx-settings">
      <header className="cx-settings-head">
        <h1>Codex Settings</h1>
        <div className="cx-settings-sub">
          Pick which provider new threads use, or fall back to System default (your <code>~/.codex/config.toml</code>).
          Sandbox and approval apply to both.
        </div>
      </header>

      <div className="cx-settings-grid">
        <ProviderList
          builtin={builtin!}
          providers={settings.customProviders}
          activeId={settings.activeProviderId}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onSetActive={setActive}
          onAdd={addProvider}
        />
        <div className="cx-settings-pane">
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
              : <div className="cx-settings-empty">Select a provider on the left.</div>}
          <RuntimePane runtime={settings.runtime} onAfterMutate={setSettings} flash={flash} />
          <PreferencesPane />
        </div>
      </div>

      {msg && <div className="cx-settings-flash">{msg}</div>}
    </div>
  );
}

// The Preferences pane bundles engine-agnostic settings that the Claude side
// has as top-level sections (Appearance / Notifications / Sound / Remote
// access / Config files). They live under the Codex Settings' right pane so
// a Codex-only user gets the same toggles without having to open the Claude
// bundle.
function PreferencesPane() {
  const { theme, resolved } = useTheme();
  const [pushState, setPushState] = useState<PushState>('unsupported');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    void getPushState().then(setPushState);
  }, []);

  const togglePush = async (next: boolean) => {
    setBusy(true);
    try {
      const s = next ? await subscribeToPush() : await unsubscribeFromPush();
      setPushState(s);
      if (next && s === 'denied') toast('notifications blocked — enable them for this site in your browser');
      else if (next && s === 'subscribed') toast('push notifications on');
      else if (!next) toast('push notifications off');
    } catch (e) {
      toast(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const pushLabel = pushState === 'subscribed' ? 'On' : pushState === 'denied' ? 'Blocked' : pushState === 'unsupported' ? 'Unavailable' : 'Off';

  return (
    <>
      <section className="cx-settings-section">
        <div className="cx-section-head"><h2>Appearance</h2></div>
        <div className="cx-field">
          <div className="cx-theme-seg" role="radiogroup" aria-label="Theme">
            {THEME_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={theme === o.value}
                className={'cx-theme-seg-btn' + (theme === o.value ? ' active' : '')}
                onClick={() => setTheme(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className="cx-field-hint">
            {theme === 'system' ? `Following your system preference (currently ${resolved}).` : `Always ${theme}.`}
          </p>
        </div>
      </section>

      <section className="cx-settings-section">
        <div className="cx-section-head"><h2>Notifications</h2></div>
        <div className="cx-field">
          <label className="cx-toggle-row">
            <input
              type="checkbox"
              checked={pushState === 'subscribed'}
              disabled={busy || pushState === 'unsupported' || pushState === 'denied'}
              onChange={(e) => void togglePush(e.target.checked)}
            />
            <span>Push notifications ({pushLabel})</span>
          </label>
          <p className="cx-field-hint">
            Get a system notification when a session finishes a turn or needs a permission decision — even with the tab closed.
            {pushState === 'unsupported' && ' Unavailable here (needs HTTPS or a mobile home-screen install).'}
            {pushState === 'denied' && ' Blocked. Re-enable notifications for this site in your browser settings, then reload.'}
          </p>
        </div>
      </section>

      {/* SoundSettings / RemoteAccess / ConfigFilesSection are imported from
          the Claude Settings view; they already render their own headers and
          call engine-agnostic /api endpoints, so they drop in unchanged. */}
      <section className="cx-settings-section cx-settings-borrowed">
        <SoundSettings />
      </section>

      <section className="cx-settings-section cx-settings-borrowed">
        <RemoteAccess />
      </section>

      <section className="cx-settings-section cx-settings-borrowed">
        <ConfigFilesSection />
      </section>
    </>
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
  builtin: PublicCodexBuiltin;
  providers: PublicCodexProvider[];
  activeId: string;
  selectedId: string;
  onSelect: (id: string) => void;
  onSetActive: (id: string) => void;
  onAdd: () => void;
}) {
  const isSel = (id: string) => selectedId === id;
  const isAct = (id: string) => activeId === id;
  return (
    <aside className="cx-settings-list">
      <div className="cx-settings-list-label">BUILT-IN</div>
      <button
        type="button"
        className={'cx-plist-row' + (isSel(SYSTEM_ID) ? ' selected' : '') + (isAct(SYSTEM_ID) ? ' active' : '')}
        onClick={() => onSelect(SYSTEM_ID)}
        onDoubleClick={() => onSetActive(SYSTEM_ID)}
      >
        <div className="cx-plist-row-main">
          <span className="cx-plist-row-name">{builtin.name}</span>
          {isAct(SYSTEM_ID) && <span className="cx-plist-active-badge">active</span>}
        </div>
        <div className="cx-plist-row-sub">
          {builtin.detectedEndpoint || '~/.codex/config.toml (unset)'}
        </div>
      </button>

      <div className="cx-settings-list-label">CUSTOM</div>
      {providers.length === 0 && <div className="cx-plist-empty">No custom providers yet.</div>}
      {providers.map((p) => (
        <button
          key={p.id}
          type="button"
          className={'cx-plist-row' + (isSel(p.id) ? ' selected' : '') + (isAct(p.id) ? ' active' : '')}
          onClick={() => onSelect(p.id)}
          onDoubleClick={() => onSetActive(p.id)}
        >
          <div className="cx-plist-row-main">
            <span className="cx-plist-row-name">{p.name}</span>
            {isAct(p.id) && <span className="cx-plist-active-badge">active</span>}
            {!p.configured && <span className="cx-plist-warn">no key</span>}
          </div>
          <div className="cx-plist-row-sub">{p.model} · {p.baseUrl || '(no url)'}</div>
        </button>
      ))}

      <button type="button" className="cx-plist-add" onClick={onAdd}>+ Add provider</button>
    </aside>
  );
}

// -------- Right pane: system provider (read-only) --------

function SystemPane({
  builtin,
  isActive,
  onSetActive,
}: {
  builtin: PublicCodexBuiltin;
  isActive: boolean;
  onSetActive: () => void;
}) {
  return (
    <section className="cx-settings-section">
      <div className="cx-section-head">
        <h2>System default</h2>
        {isActive
          ? <span className="cx-active-pill">Active</span>
          : <button className="cx-btn primary" onClick={onSetActive}>Use this</button>}
      </div>
      <p className="cx-section-body">{builtin.description}</p>
      <dl className="cx-kv">
        <dt>Detected endpoint</dt>
        <dd>{builtin.detectedEndpoint || <em>none</em>}</dd>
        <dt>Detected model</dt>
        <dd>{builtin.detectedModel || <em>none</em>}</dd>
      </dl>
      <p className="cx-section-note">
        Nothing to edit here — the pass-through provider inherits everything from your existing Codex CLI config.
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
  provider: PublicCodexProvider;
  isActive: boolean;
  onSetActive: () => void;
  onAfterMutate: (next: PublicCodexSettings) => void;
  onDeleted: () => void;
  flash: (msg: string) => void;
}) {
  const [draft, setDraft] = useState<PublicCodexProvider>(provider);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const confirm = useConfirm();
  useEffect(() => { setDraft(provider); setApiKey(''); }, [provider]);

  const set = <K extends keyof PublicCodexProvider>(k: K, v: PublicCodexProvider[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
  };
  const dirty = useMemo(() => {
    const keys: (keyof PublicCodexProvider)[] = [
      'name', 'baseUrl', 'model', 'wireApi', 'modelProvider', 'reasoningEffort',
      'webSearchEnabled', 'contextWindow', 'autoCompactTokenLimit', 'disableResponseStorage',
    ];
    return apiKey.length > 0 || keys.some((k) => draft[k] !== provider[k]);
  }, [draft, provider, apiKey]);

  const save = async () => {
    setSaving(true);
    try {
      const patch: Partial<PublicCodexProvider> & { apiKey?: string } = {
        name: draft.name,
        baseUrl: draft.baseUrl,
        model: draft.model,
        wireApi: draft.wireApi,
        modelProvider: draft.modelProvider,
        reasoningEffort: draft.reasoningEffort,
        webSearchEnabled: draft.webSearchEnabled,
        contextWindow: draft.contextWindow,
        autoCompactTokenLimit: draft.autoCompactTokenLimit,
        disableResponseStorage: draft.disableResponseStorage,
      };
      if (apiKey) patch.apiKey = apiKey;
      const s = await codexApi.updateProvider(provider.id, patch);
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
      await codexApi.deleteProvider(provider.id);
      onDeleted();
      flash('Deleted');
    } catch (e) {
      flash(`Delete failed: ${(e as Error).message}`);
    }
  };

  return (
    <section className="cx-settings-section">
      <div className="cx-section-head">
        <h2>{draft.name || 'Custom provider'}</h2>
        {isActive
          ? <span className="cx-active-pill">Active</span>
          : <button className="cx-btn primary" onClick={onSetActive}>Use this</button>}
      </div>

      <div className="cx-field-row">
        <div className="cx-field">
          <label>Name</label>
          <input value={draft.name} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div className="cx-field">
          <label>Provider ID</label>
          <input value={draft.modelProvider} onChange={(e) => set('modelProvider', e.target.value)} />
          <small>Recorded in rollout metadata; drives <code>model_providers.&lt;id&gt;</code> config keys.</small>
        </div>
      </div>

      <div className="cx-field">
        <label>Base URL</label>
        <input
          value={draft.baseUrl}
          onChange={(e) => set('baseUrl', e.target.value)}
          placeholder="https://api.example.com/v1"
        />
        <small>Most OpenAI-compatible proxies require the trailing <code>/v1</code>.</small>
      </div>

      <div className="cx-field">
        <label>API key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={provider.configured ? '••••••• (leave blank to keep current)' : 'Paste your bearer token'}
        />
      </div>

      <div className="cx-field-row">
        <div className="cx-field">
          <label>Model</label>
          <input value={draft.model} onChange={(e) => set('model', e.target.value)} />
        </div>
        <div className="cx-field">
          <label>Wire API</label>
          <select value={draft.wireApi} onChange={(e) => set('wireApi', e.target.value as 'responses' | 'chat')}>
            {WIRE.map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        </div>
        <div className="cx-field">
          <label>Reasoning</label>
          <select value={draft.reasoningEffort} onChange={(e) => set('reasoningEffort', e.target.value as CodexReasoningEffort)}>
            {REASONING.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
      </div>

      <div className="cx-field-row">
        <div className="cx-field">
          <label>Context window (tokens)</label>
          <input type="number" value={draft.contextWindow} onChange={(e) => set('contextWindow', Number(e.target.value) || 0)} />
        </div>
        <div className="cx-field">
          <label>Auto-compact at</label>
          <input type="number" value={draft.autoCompactTokenLimit} onChange={(e) => set('autoCompactTokenLimit', Number(e.target.value) || 0)} />
        </div>
      </div>

      <div className="cx-field cx-toggle">
        <input id="cx-web" type="checkbox" checked={draft.webSearchEnabled} onChange={(e) => set('webSearchEnabled', e.target.checked)} />
        <label htmlFor="cx-web">Enable web search tool</label>
      </div>
      <div className="cx-field cx-toggle">
        <input id="cx-drs" type="checkbox" checked={draft.disableResponseStorage} onChange={(e) => set('disableResponseStorage', e.target.checked)} />
        <label htmlFor="cx-drs">Disable server-side response storage</label>
      </div>

      <div className="cx-section-actions">
        <button className="cx-btn primary" onClick={save} disabled={saving || !dirty}>
          {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
        </button>
        <button className="cx-btn danger" onClick={del}>Delete</button>
      </div>
    </section>
  );
}

// -------- Runtime knobs (apply to system + custom alike) --------

function RuntimePane({
  runtime,
  onAfterMutate,
  flash,
}: {
  runtime: CodexRuntimeOptions;
  onAfterMutate: (next: PublicCodexSettings) => void;
  flash: (msg: string) => void;
}) {
  const commit = async (patch: Partial<CodexRuntimeOptions>) => {
    try {
      const s = await codexApi.setRuntime(patch);
      onAfterMutate(s);
      flash('Runtime updated');
    } catch (e) {
      flash(`Update failed: ${(e as Error).message}`);
    }
  };
  return (
    <section className="cx-settings-section">
      <div className="cx-section-head">
        <h2>Runtime</h2>
      </div>
      <p className="cx-section-body">
        Applied to every thread regardless of the active provider — a common override so switching to System
        default doesn’t clobber your sandbox/approval preferences.
      </p>
      <div className="cx-field-row">
        <div className="cx-field">
          <label>Sandbox</label>
          <select value={runtime.sandboxMode} onChange={(e) => commit({ sandboxMode: e.target.value as CodexSandboxMode })}>
            {SANDBOX.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="cx-field">
          <label>Approval policy</label>
          <select value={runtime.approvalPolicy} onChange={(e) => commit({ approvalPolicy: e.target.value as CodexApprovalPolicy })}>
            {APPROVAL.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
      </div>
    </section>
  );
}
