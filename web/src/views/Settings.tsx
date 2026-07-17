import { ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api, type PublicSettings, type PublicCustomProvider, type ProviderInput, type TunnelProvider, type TunnelState, type ConfigFileMeta, type DefaultPermissionMode } from '../lib/api';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/Confirm';
import { useTheme, setTheme, type Theme } from '../lib/theme';
import { getPushState, subscribeToPush, unsubscribeFromPush, type PushState } from '../lib/pwa';
import {
  SOUND_EVENTS,
  SOUND_PACKS,
  previewSound,
  setSoundPrefs,
  useSoundPrefs,
} from '../lib/sound';

const BLANK_INPUT: ProviderInput = { name: '', endpoint: '', model: '', apiKey: '' };

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

// Matches the per-session picker in StatusBar.tsx — same labels, same tone
// vocabulary — so the global default reads as "the value each new session
// starts at". `blurb` is the one-line explanation shown under the picker.
const PERMISSION_MODE_OPTIONS: Array<{
  value: DefaultPermissionMode;
  label: string;
  blurb: string;
  tone: 'ok' | 'warn' | 'bad';
}> = [
  { value: 'default', label: 'Default (ask)', blurb: 'Prompt for every tool call. Safest — nothing runs without your click.', tone: 'ok' },
  { value: 'acceptEdits', label: 'Accept edits', blurb: 'File edits auto-approve; shell + network + MCP calls still ask.', tone: 'ok' },
  { value: 'plan', label: 'Plan mode', blurb: 'Read-only. The model plans but can\'t change anything until you accept the plan.', tone: 'ok' },
  { value: 'bypassPermissions', label: 'Bypass all', blurb: 'All tool calls auto-approve. Same as the old YOLO — safe only when you trust the workspace.', tone: 'bad' },
];

export function Settings() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [error, setError] = useState('');
  // Editor state — either editing an existing provider (id set) or creating
  // a new one (id === null). null = editor closed.
  const [editing, setEditing] = useState<
    | null
    | { id: string | null; draft: ProviderInput; existingConfigured: boolean }
  >(null);
  const [busy, setBusy] = useState(false);
  const [pushState, setPushState] = useState<PushState>('unsupported');
  const toast = useToast();
  const confirm = useConfirm();
  const { theme, resolved } = useTheme();

  useEffect(() => {
    api.settings().then(setSettings).catch((e) => setError((e as Error).message));
  }, []);

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

  const activate = async (providerId: string) => {
    if (!settings) return;
    setBusy(true);
    try {
      setSettings(await api.setActiveProvider(providerId));
    } catch (e) {
      toast(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const openCreate = () =>
    setEditing({ id: null, draft: { ...BLANK_INPUT }, existingConfigured: false });

  const openEdit = (p: PublicCustomProvider) =>
    setEditing({
      id: p.id,
      draft: { name: p.name, endpoint: p.endpoint, model: p.model, apiKey: '' },
      existingConfigured: p.configured,
    });

  const save = async () => {
    if (!editing) return;
    const d = editing.draft;
    if (!d.name.trim()) return toast('name is required');
    if (!d.endpoint.trim()) return toast('endpoint is required');
    if (!d.model.trim()) return toast('model is required');
    if (editing.id === null && !d.apiKey?.trim()) return toast('API key is required for a new provider');
    setBusy(true);
    try {
      if (editing.id === null) {
        const r = await api.addProvider({
          name: d.name.trim(),
          endpoint: d.endpoint.trim(),
          model: d.model.trim(),
          apiKey: (d.apiKey || '').trim(),
        });
        setSettings(r.settings);
        toast(`added "${d.name.trim()}"`);
      } else {
        const patch: Partial<ProviderInput> = {
          name: d.name.trim(),
          endpoint: d.endpoint.trim(),
          model: d.model.trim(),
        };
        // Empty key = keep existing on server (matches placeholder text).
        if ((d.apiKey || '').trim().length > 0) patch.apiKey = d.apiKey!.trim();
        setSettings(await api.updateProvider(editing.id, patch));
        toast(`updated "${d.name.trim()}"`);
      }
      setEditing(null);
    } catch (e) {
      toast(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: PublicCustomProvider) => {
    const ok = await confirm({
      title: 'Delete provider?',
      body: (
        <>
          <code>{p.name}</code>
          <div className="confirm-sub">
            Removes it from <code>~/.claude/macaron-config.json</code>. If it's currently active, the provider falls back to Anthropic default. Cannot be undone.
          </div>
        </>
      ),
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      setSettings(await api.deleteProvider(p.id));
      toast(`deleted "${p.name}"`);
    } catch (e) {
      toast(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const changeDefaultPermissionMode = async (next: DefaultPermissionMode) => {
    if (!settings || next === settings.defaultPermissionMode) return;
    // Only 'bypassPermissions' needs a confirm — the other three are all
    // strictly safer than the current SDK default. Skipping the modal on those
    // makes the picker feel like a real chip, not a landmine.
    if (next === 'bypassPermissions') {
      const ok = await confirm({
        title: 'Set default to Bypass all?',
        body: (
          <>
            <div className="confirm-sub">
              Every new session will start with <code>permissionMode: 'bypassPermissions'</code> — <strong>all tool calls auto-approve</strong>. Existing sessions keep whatever mode they were on; this only sets what fresh sessions initialise to.
            </div>
            <div className="confirm-sub">
              A single session can still cycle to a safer mode via its own permission chip (or <kbd>Shift</kbd>+<kbd>Tab</kbd>).
            </div>
          </>
        ),
        confirmLabel: 'Set default',
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      setSettings(await api.setDefaultPermissionMode(next));
      const label = PERMISSION_MODE_OPTIONS.find((o) => o.value === next)?.label ?? next;
      toast(`Default permission mode → ${label}`);
    } catch (e) {
      toast(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleFollowups = async (next: boolean) => {
    setBusy(true);
    try {
      setSettings(await api.setFollowupSuggestions(next));
      toast(next ? 'follow-up suggestions on' : 'follow-up suggestions off');
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
  if (!settings) {
    return (
      <section className="view">
        <p className="muted">Loading…</p>
      </section>
    );
  }

  const active = settings.activeProviderId;

  return (
    <section className="view settings-view">
      <header>
        <h1>Settings</h1>
        <p>Manage the Anthropic-compatible LLM providers Claude Code sessions can route through. One is active at a time.</p>
      </header>

      <div className="settings-section">
        <div className="settings-row-head">
          <h2 className="sec-title">Appearance</h2>
        </div>
        <div className="theme-row">
          <div className="theme-seg" role="radiogroup" aria-label="Theme">
            {THEME_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={theme === o.value}
                className={`theme-seg-btn${theme === o.value ? ' active' : ''}`}
                onClick={() => setTheme(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className="settings-hint">
            {theme === 'system' ? `Following your system preference (currently ${resolved}).` : `Always ${theme}.`}
          </p>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-row-head">
          <h2 className="sec-title">Providers</h2>
          <button className="primary small" onClick={openCreate} disabled={busy || editing !== null}>
            + Add provider
          </button>
        </div>

        <div className="prov-list">
          {settings.builtins.map((b) => (
            <label
              key={b.id}
              className={`prov-card${active === b.id ? ' active' : ''}`}
            >
              <input
                type="radio"
                name="provider"
                checked={active === b.id}
                onChange={() => activate(b.id)}
                disabled={busy}
              />
              <div className="prov-card-body">
                <div className="prov-card-head">
                  <span className="prov-name">{b.name}</span>
                  <span className="prov-tag">built-in</span>
                  {b.detectedEndpoint && (
                    <span className="prov-tag ok">env override detected</span>
                  )}
                </div>
                <div className="prov-card-sub">{b.description}</div>
                {b.detectedEndpoint && (
                  <div className="prov-card-sub">
                    <code>ANTHROPIC_BASE_URL={b.detectedEndpoint}</code>
                  </div>
                )}
              </div>
            </label>
          ))}

          {settings.customProviders.map((p) => (
            <label
              key={p.id}
              className={`prov-card${active === p.id ? ' active' : ''}`}
            >
              <input
                type="radio"
                name="provider"
                checked={active === p.id}
                onChange={() => p.configured && activate(p.id)}
                disabled={busy || !p.configured}
              />
              <div className="prov-card-body">
                <div className="prov-card-head">
                  <span className="prov-name">{p.name}</span>
                  <span className={`prov-tag ${p.configured ? 'ok' : 'bad'}`}>
                    {p.configured ? 'key saved' : 'no key'}
                  </span>
                </div>
                <div className="prov-card-sub">
                  <code>{p.endpoint}</code>
                  <span className="prov-model">· {p.model}</span>
                </div>
              </div>
              <div className="prov-card-actions">
                <button
                  type="button"
                  className="ghost small"
                  onClick={(e) => { e.preventDefault(); openEdit(p); }}
                  disabled={busy || editing !== null}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="ghost small prov-danger"
                  onClick={(e) => { e.preventDefault(); void remove(p); }}
                  disabled={busy || editing !== null}
                >
                  Delete
                </button>
              </div>
            </label>
          ))}

          {settings.customProviders.length === 0 && !editing && (
            <p className="muted" style={{ padding: '10px 4px' }}>
              No custom providers yet. Click "+ Add provider" to add one.
            </p>
          )}

          {editing && (
            <div className="prov-editor-inline">
              <h3 className="prov-editor-title">
                {editing.id === null ? 'Add provider' : 'Edit provider'}
              </h3>
              <ProviderForm
                draft={editing.draft}
                existingConfigured={editing.existingConfigured}
                isNew={editing.id === null}
                onChange={(patch) =>
                  setEditing((cur) => (cur ? { ...cur, draft: { ...cur.draft, ...patch } } : cur))
                }
              />
              <div className="settings-actions">
                <button className="primary" onClick={save} disabled={busy}>
                  {busy ? 'Saving…' : editing.id === null ? 'Create' : 'Save'}
                </button>
                <button className="ghost" onClick={() => setEditing(null)} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-row-head">
          <h2 className="sec-title">Permissions</h2>
        </div>
        {(() => {
          const active = PERMISSION_MODE_OPTIONS.find((o) => o.value === settings.defaultPermissionMode)
            ?? PERMISSION_MODE_OPTIONS[0]!;
          return (
            <div className={`prov-card perm-mode-card${settings.defaultPermissionMode === 'bypassPermissions' ? ' active' : ''}`}>
              <div className="prov-card-body">
                <div className="prov-card-head perm-mode-head">
                  <span className="prov-name">Default permission mode</span>
                  {/* Same provider-chip pill as the in-session permission
                      picker, so the two controls read as siblings. */}
                  <div className={`provider-chip${busy ? ' disabled' : ''}`} title={`Default · ${active.label}`}>
                    <span className="provider-chip-label">{active.label}</span>
                    <ChevronDown className="provider-chip-caret" size={8} strokeWidth={2.5} aria-hidden="true" />
                    <select
                      className="provider-chip-select"
                      value={settings.defaultPermissionMode}
                      disabled={busy}
                      onChange={(e) => void changeDefaultPermissionMode(e.target.value as DefaultPermissionMode)}
                      aria-label="Default permission mode"
                    >
                      {PERMISSION_MODE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                  <span className={`prov-tag ${active.tone}`}>{active.value === 'bypassPermissions' ? 'all tools auto-approve' : active.value}</span>
                </div>
                <div className="prov-card-sub">
                  {active.blurb}
                </div>
                <div className="prov-card-sub">
                  Applied to <strong>new sessions</strong>. A single session can still cycle its picker (<kbd>Shift</kbd>+<kbd>Tab</kbd> or the in-composer chip) to override for that session only.
                </div>
              </div>
            </div>
          );
        })()}
      </div>

      <ConfigFilesSection />
      <RemoteAccess />

      <SoundSettings />

      <div className="settings-section">
        <div className="settings-row-head">
          <h2 className="sec-title">Suggestions</h2>
        </div>
        <label className={`prov-card${settings.followupSuggestions ? ' active' : ''}`}>
          <input
            type="checkbox"
            checked={settings.followupSuggestions}
            onChange={(e) => void toggleFollowups(e.target.checked)}
            disabled={busy}
          />
          <div className="prov-card-body">
            <div className="prov-card-head">
              <span className="prov-name">Follow-up questions</span>
              <span className={`prov-tag ${settings.followupSuggestions ? 'ok' : 'bad'}`}>
                {settings.followupSuggestions ? 'on' : 'off'}
              </span>
            </div>
            <div className="prov-card-sub">
              After a clean Claude turn, run one extra throwaway model call to suggest next questions. Off by default because it spends tokens.
            </div>
          </div>
        </label>
      </div>

      <div className="settings-section">
        <div className="settings-row-head">
          <h2 className="sec-title">Notifications</h2>
        </div>
        <label className={`prov-card${pushState === 'subscribed' ? ' active' : ''}`}>
          <input
            type="checkbox"
            checked={pushState === 'subscribed'}
            onChange={(e) => void togglePush(e.target.checked)}
            disabled={busy || pushState === 'unsupported' || pushState === 'denied'}
          />
          <div className="prov-card-body">
            <div className="prov-card-head">
              <span className="prov-name">Push notifications</span>
              <span className={`prov-tag ${pushState === 'subscribed' ? 'ok' : 'bad'}`}>
                {pushState === 'subscribed' ? 'on' : pushState === 'denied' ? 'blocked' : pushState === 'unsupported' ? 'unavailable' : 'off'}
              </span>
            </div>
            <div className="prov-card-sub">
              Get a system notification when a session finishes a turn or needs a permission decision — even with the tab closed.
            </div>
            {pushState === 'unsupported' && (
              <div className="prov-card-sub">
                Unavailable here. Web Push needs a secure (HTTPS) origin; on iOS you must first <strong>Add to Home Screen</strong> and open the installed app.
              </div>
            )}
            {pushState === 'denied' && (
              <div className="prov-card-sub">
                Blocked. Re-enable notifications for this site in your browser settings, then reload.
              </div>
            )}
          </div>
        </label>
      </div>

    </section>
  );
}

const PROVIDER_LABELS: Record<TunnelProvider, string> = {
  cloudflared: 'Cloudflare',
  ngrok: 'ngrok',
};

// Zero-config remote access: pick a tunnel CLI, start it, and share the public
// URL (with a QR code) so a phone or second machine can reach this session.
function RemoteAccess() {
  const [state, setState] = useState<TunnelState | null>(null);
  const [provider, setProvider] = useState<TunnelProvider>('cloudflared');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    const tick = () => api.tunnelStatus().then((s) => { if (alive) setState(s); }).catch(() => {});
    tick();
    // Poll while a tunnel is coming up or live so a URL / crash surfaces on its own.
    const t = setInterval(() => {
      if (state?.status === 'starting' || state?.status === 'running') tick();
    }, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [state?.status]);

  const start = async () => {
    setBusy(true);
    try {
      setState(await api.startTunnel(provider));
    } catch (e) {
      toast(`error: ${(e as Error).message}`);
      api.tunnelStatus().then(setState).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      setState(await api.stopTunnel());
    } catch (e) {
      toast(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const status = state?.status ?? 'stopped';
  const live = status === 'running' && state?.url;
  const starting = status === 'starting';
  // The share URL carries NO token — a URL leaks via history/referrer/proxy logs.
  // Opening it lands on the AuthGate login screen; the operator pastes the token
  // (shown below) there. Never fold the credential into the link.
  const shareUrl = (live && state?.url) || '';

  return (
    <div className="settings-section">
      <div className="settings-row-head">
        <h2 className="sec-title">Remote access</h2>
      </div>
      <div className="prov-card tunnel-card">
        <div className="prov-card-body">
          <div className="prov-card-head">
            <span className="prov-name">Public tunnel</span>
            <span className={`prov-tag ${live ? 'ok' : status === 'error' ? 'bad' : ''}`}>
              {live ? `live · ${state?.provider === 'ngrok' ? 'ngrok' : 'Cloudflare'}` : starting ? 'starting…' : status === 'error' ? 'error' : 'off'}
            </span>
          </div>
          <div className="prov-card-sub">
            Expose this local server on a public URL via an installed CLI, so you can drive sessions from your phone or another machine. Cloudflare needs no account; ngrok uses your <code>ngrok</code> authtoken.
          </div>

          {!live && !starting && (
            <div className="tunnel-controls">
              <div className="tunnel-provider-pick">
                {(Object.keys(PROVIDER_LABELS) as TunnelProvider[]).map((p) => (
                  <label key={p} className={`tunnel-radio${provider === p ? ' active' : ''}`}>
                    <input type="radio" name="tunnel-provider" checked={provider === p} onChange={() => setProvider(p)} disabled={busy} />
                    {PROVIDER_LABELS[p]}
                  </label>
                ))}
              </div>
              <button className="primary small" onClick={start} disabled={busy}>
                {busy ? 'Starting…' : 'Start tunnel'}
              </button>
            </div>
          )}

          {(live || starting) && (
            <div className="tunnel-controls">
              <button className="ghost small" onClick={stop} disabled={busy}>Stop tunnel</button>
            </div>
          )}

          {status === 'error' && state?.error && (
            <div className="settings-hint bad">{state.error}</div>
          )}

          {live && state?.url && (
            <div className="tunnel-live">
              <div className="tunnel-url-row">
                <a className="tunnel-url" href={shareUrl} target="_blank" rel="noreferrer">{state.url}</a>
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => { navigator.clipboard.writeText(shareUrl); toast('URL copied'); }}
                >
                  Copy
                </button>
              </div>
              <div className="tunnel-qr">
                <QRCodeSVG value={shareUrl} size={148} marginSize={2} />
              </div>
              <div className="settings-hint">
                {state.token
                  ? <>This server requires an access token: <code>{state.token}</code>. Share it <strong>separately</strong> from the URL (never in the link) with people you trust, and stop the tunnel when you're done.</>
                  : <><strong>This server already requires its access token.</strong> Share the URL together with that token, and stop the tunnel when you're done.</>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ProviderForm({
  draft,
  existingConfigured,
  isNew,
  onChange,
}: {
  draft: ProviderInput;
  existingConfigured: boolean;
  isNew: boolean;
  onChange: (patch: Partial<ProviderInput>) => void;
}) {
  const [showKey, setShowKey] = useState(false);
  return (
    <>
      <div className="settings-field">
        <label htmlFor="p-name">Name</label>
        <input
          id="p-name"
          className="settings-input"
          value={draft.name}
          placeholder="e.g. Macaron, OpenRouter, My server"
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </div>
      <div className="settings-field">
        <label htmlFor="p-endpoint">Endpoint (Anthropic-compatible)</label>
        <input
          id="p-endpoint"
          className="settings-input"
          value={draft.endpoint}
          placeholder="https://…/v1"
          spellCheck={false}
          autoCapitalize="off"
          onChange={(e) => onChange({ endpoint: e.target.value })}
        />
        <p className="settings-hint">Must expose <code>/v1/messages</code>. Claude Code SDK will POST to it.</p>
      </div>
      <div className="settings-field">
        <label htmlFor="p-model">Model</label>
        <input
          id="p-model"
          className="settings-input"
          value={draft.model}
          placeholder="e.g. provider-model-id"
          onChange={(e) => onChange({ model: e.target.value })}
        />
      </div>
      <div className="settings-field">
        <label htmlFor="p-key">API key</label>
        <div className="settings-input-row">
          <input
            id="p-key"
            type={showKey ? 'text' : 'password'}
            className="settings-input"
            value={draft.apiKey || ''}
            placeholder={existingConfigured ? '••••••••  (saved — leave blank to keep)' : 'Paste your API key'}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => onChange({ apiKey: e.target.value })}
          />
          <button
            type="button"
            className="ghost small"
            onClick={() => setShowKey((v) => !v)}
            disabled={!draft.apiKey && !existingConfigured}
          >
            {showKey ? 'Hide' : 'Show'}
          </button>
        </div>
        {isNew ? (
          <p className="settings-hint">Required.</p>
        ) : existingConfigured ? (
          <p className="settings-hint ok">Key saved. Leave blank to keep the current one.</p>
        ) : (
          <p className="settings-hint">No key on file yet.</p>
        )}
      </div>
    </>
  );
}

// Browser editors for the user-scope Claude Code config files under
// ~/.claude: settings.json (JSON, validated server-side before write) and
// CLAUDE.md (free-form memory). Each file loads lazily on first selection;
// the JSON file is checked client-side for parse errors so Save stays
// disabled on obviously-broken input, and the server re-validates as the
// source of truth before any write touches disk.
function ConfigFilesSection() {
  const [files, setFiles] = useState<ConfigFileMeta[] | null>(null);
  const [activeId, setActiveId] = useState<ConfigFileMeta['id'] | null>(null);
  const [original, setOriginal] = useState('');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();

  useEffect(() => {
    api.configFiles().then((r) => {
      setFiles(r.files);
      if (r.files.length > 0) setActiveId(r.files[0]!.id);
    }).catch((e) => setError((e as Error).message));
  }, []);

  const active = files?.find((f) => f.id === activeId) || null;

  // (Re)load the selected file's content whenever the active file changes.
  useEffect(() => {
    if (!activeId) return;
    // Guard against a stale response landing after the user switched tabs —
    // otherwise a slow settings.json load could overwrite the memory draft
    // (and get saved into the wrong file).
    let cancelled = false;
    setLoading(true);
    setError('');
    api.configFile(activeId).then((f) => {
      if (cancelled) return;
      setOriginal(f.content);
      setDraft(f.content);
    }).catch((e) => { if (!cancelled) setError((e as Error).message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeId]);

  const dirty = draft !== original;
  // Cheap client-side JSON guard for the Save button; the server owns the
  // authoritative schema check.
  const jsonError = active?.format === 'json' && draft.trim()
    ? (() => { try { JSON.parse(draft); return ''; } catch (e) { return (e as Error).message; } })()
    : '';

  const save = async () => {
    if (!activeId) return;
    setSaving(true);
    setError('');
    try {
      const saved = await api.saveConfigFile(activeId, draft);
      setOriginal(saved.content);
      setDraft(saved.content);
      setFiles((prev) => prev?.map((f) => (f.id === activeId ? { ...f, exists: true } : f)) ?? prev);
      toast(`saved ${saved.label}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const revert = () => { setDraft(original); setError(''); };

  return (
    <div className="settings-section">
      <div className="settings-row-head">
        <h2 className="sec-title">Config files</h2>
        {active && <span className="cfg-path" title={active.path}>{active.path}</span>}
      </div>
      <p className="settings-hint" style={{ margin: '0 0 12px' }}>
        Edit your user-scope <code>~/.claude</code> files without leaving the browser. JSON is validated before it's written, so a bad edit can't brick your sessions.
      </p>

      {!files && !error && <p className="muted">Loading…</p>}

      {files && (
        <>
          <div className="cfg-tabs">
            {files.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`cfg-tab${f.id === activeId ? ' active' : ''}`}
                onClick={() => setActiveId(f.id)}
                disabled={saving}
              >
                {f.label}
                {!f.exists && <span className="cfg-tab-new">new</span>}
              </button>
            ))}
          </div>

          <textarea
            className="cfg-editor"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={draft}
            placeholder={loading ? 'Loading…' : active?.format === 'json' ? '{\n  \n}' : '# Project memory…'}
            onChange={(e) => setDraft(e.target.value)}
            disabled={loading || saving}
          />

          {jsonError && <p className="settings-hint cfg-bad">Invalid JSON: {jsonError}</p>}
          {error && <p className="settings-hint cfg-bad">{error}</p>}

          <div className="settings-actions">
            <button className="primary" onClick={save} disabled={!dirty || saving || loading || Boolean(jsonError)}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="ghost" onClick={revert} disabled={!dirty || saving || loading}>
              Revert
            </button>
            {dirty && !saving && <span className="settings-hint cfg-dirty">Unsaved changes</span>}
          </div>
        </>
      )}
    </div>
  );
}

// Audio cue preferences (localStorage-backed, see lib/sound.ts). Independent
// of the server-side PublicSettings above — nothing here round-trips to the
// backend, so it renders straight from the useSoundPrefs store.
function SoundSettings() {
  const prefs = useSoundPrefs();
  return (
    <div className="settings-section">
      <div className="settings-row-head">
        <h2 className="sec-title">Sound notifications</h2>
      </div>
      <p className="settings-hint" style={{ marginTop: 0, marginBottom: 12 }}>
        Play a short sound when a session needs attention — handy when the tab is in the background.
      </p>

      <label className={`prov-card${prefs.enabled ? ' active' : ''}`}>
        <input
          type="checkbox"
          checked={prefs.enabled}
          onChange={(e) => setSoundPrefs({ enabled: e.target.checked })}
        />
        <div className="prov-card-body">
          <div className="prov-card-head">
            <span className="prov-name">Enable sounds</span>
            <span className={`prov-tag ${prefs.enabled ? 'ok' : 'bad'}`}>
              {prefs.enabled ? 'on' : 'off'}
            </span>
          </div>
          <div className="prov-card-sub">Master switch for all per-event cues below.</div>
        </div>
      </label>

      <div className="settings-field">
        <label>Sound pack</label>
        <div className="prov-list">
          {SOUND_PACKS.map((pk) => (
            <label key={pk.id} className={`prov-card${prefs.pack === pk.id ? ' active' : ''}`}>
              <input
                type="radio"
                name="sound-pack"
                checked={prefs.pack === pk.id}
                disabled={!prefs.enabled}
                onChange={() => setSoundPrefs({ pack: pk.id })}
              />
              <div className="prov-card-body">
                <div className="prov-card-head">
                  <span className="prov-name">{pk.label}</span>
                </div>
                <div className="prov-card-sub">{pk.hint}</div>
              </div>
              <div className="prov-card-actions">
                <button
                  type="button"
                  className="ghost small"
                  disabled={!prefs.enabled}
                  onClick={(e) => { e.preventDefault(); previewSound('complete', pk.id, prefs.volume); }}
                >
                  Preview
                </button>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="settings-field">
        <label htmlFor="sound-volume">Volume · {Math.round(prefs.volume * 100)}%</label>
        <input
          id="sound-volume"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={prefs.volume}
          disabled={!prefs.enabled}
          onChange={(e) => setSoundPrefs({ volume: Number(e.target.value) })}
        />
      </div>

      <div className="settings-field">
        <label>Per-event</label>
        <div className="prov-list">
          {SOUND_EVENTS.map((ev) => (
            <label
              key={ev.key}
              className={`prov-card${prefs.enabled && prefs.events[ev.key] ? ' active' : ''}`}
            >
              <input
                type="checkbox"
                checked={prefs.events[ev.key]}
                disabled={!prefs.enabled}
                onChange={(e) =>
                  setSoundPrefs({ events: { [ev.key]: e.target.checked } })
                }
              />
              <div className="prov-card-body">
                <div className="prov-card-head">
                  <span className="prov-name">{ev.label}</span>
                </div>
                <div className="prov-card-sub">{ev.hint}</div>
              </div>
              <div className="prov-card-actions">
                <button
                  type="button"
                  className="ghost small"
                  disabled={!prefs.enabled}
                  onClick={(e) => { e.preventDefault(); previewSound(ev.key, prefs.pack, prefs.volume); }}
                >
                  Preview
                </button>
              </div>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
