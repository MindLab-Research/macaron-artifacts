// Per-turn runtime picker for the Codex composer. Sits next to the provider
// chip and lets a single thread run at a different effort / sandbox /
// approval / web-search than the global Settings default, so two concurrent
// sessions don't have to share one setting. Each unset knob inherits the
// global config on the server. The choice is persisted per workspace.

import { useEffect, useRef, useState } from 'react';
import {
  codexApi,
  type CodexApprovalPolicy,
  type CodexReasoningEffort,
  type CodexRuntimeOverride,
  type CodexSandboxMode,
} from './api';
import { loadRuntimePref, saveRuntimePref } from './runtime-prefs';

const EFFORTS: CodexReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const SANDBOXES: CodexSandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];
const APPROVALS: CodexApprovalPolicy[] = ['never', 'on-request', 'on-failure', 'untrusted'];
const SANDBOX_SHORT: Record<CodexSandboxMode, string> = {
  'read-only': 'read-only',
  'workspace-write': 'write',
  'danger-full-access': 'full-access',
};

type Defaults = { effort: string; sandbox: string; approval: string };

// Read the global config so each "auto" option can name what it inherits.
function useDefaults(): Defaults {
  const [d, setD] = useState<Defaults>({ effort: '', sandbox: '', approval: '' });
  useEffect(() => {
    codexApi.config().then((s) => {
      const active = s.customProviders.find((p) => p.id === s.activeProviderId);
      setD({
        effort: active?.reasoningEffort ?? '',
        sandbox: s.runtime.sandboxMode,
        approval: s.runtime.approvalPolicy,
      });
    }).catch(() => { /* chips still work without labels */ });
  }, []);
  return d;
}

// One labelled native <select> styled as a chip (mirrors CodexProviderPicker).
function Chip({ prefix, label, value, options, autoLabel, disabled, onChange }: {
  prefix: string;
  label: string;
  value: string;
  options: readonly string[];
  autoLabel: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="cx-provider-chip cx-runtime-chip" title={`${prefix} · ${value || (autoLabel ? `auto (${autoLabel})` : 'auto')}`}>
      <span className="cx-provider-chip-label">{label}</span>
      <select
        className="cx-provider-chip-select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-label={prefix}
      >
        <option value="">auto{autoLabel ? ` · ${autoLabel}` : ''}</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

export function CodexRuntimePicker({ project, onChange, disabled }: {
  project: string;
  onChange: (ov: CodexRuntimeOverride) => void;
  disabled?: boolean;
}) {
  const defaults = useDefaults();
  const [ov, setOv] = useState<CodexRuntimeOverride>({});
  const prevProjectRef = useRef<string | null>(null);
  const editedRef = useRef(false);

  // Load the persisted choice whenever the workspace changes, and surface it
  // to the parent so the very first turn already carries the override.
  useEffect(() => {
    const prev = prevProjectRef.current;
    prevProjectRef.current = project;
    // On the standalone /t/:sid route `project` starts '' and flips to the
    // real id once codexApi.thread(sid) resolves — re-firing this effect. Skip
    // that async flip when the user already toggled a chip so we don't stomp
    // their visible choice (and re-push a stale override to the parent). A
    // genuine workspace switch (real → real) still reloads that project's pref.
    if (prev === '' && project !== '' && editedRef.current) return;
    const pref = loadRuntimePref(project);
    setOv(pref);
    onChange(pref);
  }, [project, onChange]);

  const patch = (next: CodexRuntimeOverride) => {
    editedRef.current = true;
    setOv(next);
    saveRuntimePref(project, next);
    onChange(next);
  };

  const webValue = ov.webSearchEnabled === true ? 'on' : ov.webSearchEnabled === false ? 'off' : '';

  return (
    <div className="cx-runtime-chips">
      <Chip prefix="Effort" label={`Effort · ${ov.reasoningEffort ?? 'auto'}`} value={ov.reasoningEffort ?? ''} options={EFFORTS} autoLabel={defaults.effort} disabled={disabled}
        onChange={(v) => patch({ ...ov, reasoningEffort: (v || undefined) as CodexReasoningEffort | undefined })} />
      <Chip prefix="Sandbox" label={`Sandbox · ${ov.sandboxMode ? SANDBOX_SHORT[ov.sandboxMode] : 'auto'}`} value={ov.sandboxMode ?? ''} options={SANDBOXES} autoLabel={defaults.sandbox} disabled={disabled}
        onChange={(v) => patch({ ...ov, sandboxMode: (v || undefined) as CodexSandboxMode | undefined })} />
      <Chip prefix="Approval" label={`Approval · ${ov.approvalPolicy ?? 'auto'}`} value={ov.approvalPolicy ?? ''} options={APPROVALS} autoLabel={defaults.approval} disabled={disabled}
        onChange={(v) => patch({ ...ov, approvalPolicy: (v || undefined) as CodexApprovalPolicy | undefined })} />
      <Chip prefix="Web search" label={`Web · ${webValue || 'auto'}`} value={webValue} options={['on', 'off']} autoLabel="" disabled={disabled}
        onChange={(v) => patch({ ...ov, webSearchEnabled: v === 'on' ? true : v === 'off' ? false : undefined })} />
    </div>
  );
}
