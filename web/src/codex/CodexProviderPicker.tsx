// Inline provider chip for the Codex composer. Reads /api/codex/config and
// lets the user switch active provider without navigating to Settings.
// Adding / editing providers still lives on the Settings page — this chip
// only exposes the "which one runs the next turn" switch.

import { ChevronDown, Monitor } from 'lucide-react';
import { useEffect, useState } from 'react';
import { codexApi, type PublicCodexSettings } from './api';

const SYSTEM_ID = 'system';

export function CodexProviderPicker() {
  const [settings, setSettings] = useState<PublicCodexSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    codexApi.config().then(setSettings).catch(() => { /* chip stays hidden */ });
  }, []);

  if (!settings) return null;

  const options: Array<{ id: string; label: string; usable: boolean }> = [];
  for (const b of settings.builtins) {
    options.push({ id: b.id, label: b.name, usable: true });
  }
  for (const p of settings.customProviders) {
    // Only surface custom providers with a key set — a keyless entry would
    // 401 on send and confuse the user.
    if (p.configured) options.push({ id: p.id, label: p.name, usable: true });
  }

  const activeId = settings.activeProviderId;
  const activeLabel =
    options.find((o) => o.id === activeId)?.label
    ?? (activeId === SYSTEM_ID ? 'System default' : '(unconfigured)');

  const onChange = async (id: string) => {
    if (busy || id === activeId) return;
    setBusy(true);
    setErr('');
    const prev = settings;
    setSettings({ ...settings, activeProviderId: id });
    try {
      setSettings(await codexApi.setActive(id));
    } catch (e) {
      setSettings(prev);
      setErr((e as Error).message);
      window.setTimeout(() => setErr(''), 2200);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={'cx-provider-chip' + (busy ? ' busy' : '')} title={err ? `Switch failed: ${err}` : `Provider · ${activeLabel}`}>
      <Monitor size={13} strokeWidth={2} aria-hidden="true" />
      <span className="cx-provider-chip-label">{activeLabel}</span>
      <ChevronDown className="cx-provider-chip-caret" size={9} strokeWidth={2.5} aria-hidden="true" />
      <select
        className="cx-provider-chip-select"
        value={activeId}
        disabled={busy}
        onChange={(e) => void onChange(e.target.value)}
        aria-label="Provider"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}
