// Small provider-selection chip shown in the Session input toolbar. Reads
// the current active provider from /api/settings on mount and PUTs the new
// choice to /api/settings/active when the user picks a different one.
//
// Only "usable" providers appear in the dropdown: the built-in System
// default, plus any custom provider whose key is configured. If the user
// wants to add/edit/delete providers they still go to the Settings page.

import { ChevronDown, Monitor } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type PublicSettings } from '../lib/api';
import { useToast } from './Toast';

export function ProviderPicker() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.settings().then(setSettings).catch(() => {/* ignore — chip stays disabled */});
  }, []);

  const options: Array<{ id: string; label: string }> = [];
  if (settings) {
    for (const b of settings.builtins) options.push({ id: b.id, label: b.name });
    for (const p of settings.customProviders) {
      if (p.configured) options.push({ id: p.id, label: p.name });
    }
  }

  const activeId = settings?.activeProviderId || '';
  const activeLabel = options.find((o) => o.id === activeId)?.label || '…';

  const onChange = async (id: string) => {
    if (!settings || busy) return;
    const prevId = settings.activeProviderId;
    setSettings({ ...settings, activeProviderId: id });
    setBusy(true);
    try {
      setSettings(await api.setActiveProvider(id));
    } catch (e) {
      setSettings({ ...settings, activeProviderId: prevId });
      toast(`switch failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="provider-chip" title={`Provider · ${activeLabel}`}>
      <Monitor className="provider-chip-icon" size={14} strokeWidth={2} aria-hidden="true" />
      <span className="provider-chip-label">{activeLabel}</span>
      <ChevronDown className="provider-chip-caret" size={10} strokeWidth={2.5} aria-hidden="true" />
      <select
        className="provider-chip-select"
        value={activeId}
        disabled={!settings || busy}
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
