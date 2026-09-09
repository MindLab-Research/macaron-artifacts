import { Description, Dialog, DialogPanel, DialogTitle, Field as HeadlessField, Label, Radio, RadioGroup } from '@headlessui/react';
import { useState } from 'react';
import type { HarnessId, HarnessInfo } from '../../shared/types';
import { Button, Field } from './ui4a-ui';
import { HarnessIcon } from './HarnessIcon';
import { SessionProfileFields } from './profiles/SessionProfile';
import { ProfileManager } from './profiles/ProfileManager';

export function NewSessionDialog({ harnesses, initialHarness, initialCwd, onClose, onCreate }: { harnesses: HarnessInfo[]; initialHarness?: HarnessId; initialCwd: string; onClose: () => void; onCreate: (input: { harness: HarnessId; cwd: string; model?: string; profileId?: string | null }) => Promise<void> }) {
  const [harness, setHarness] = useState<HarnessId>(harnesses.find(item => item.id === initialHarness && item.available)?.id ?? harnesses.find(item => item.available)?.id ?? 'claude-code');
  const [cwd, setCwd] = useState(initialCwd);
  const [model, setModel] = useState('');
  const [profileId, setProfileId] = useState(''), [profilesOpen, setProfilesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const info = harnesses.find(item => item.id === harness);
  const submit = async () => { if (!cwd.trim() || !info?.available || busy) return; setBusy(true); setError(undefined); try { await onCreate({ harness, cwd: cwd.trim(), profileId: profileId || null, ...(model.trim() ? { model: model.trim() } : {}) }); onClose(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } };
  return <><Dialog open onClose={() => { if (!busy) onClose(); }} className="relative z-50"><div className="fixed inset-0 bg-black/40" /><div className="fixed inset-0 flex items-center justify-center p-3 sm:p-4"><DialogPanel className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl bg-surface p-4 shadow-2xl sm:p-5">
    <DialogTitle className="mb-4 text-base font-medium">新会话</DialogTitle>
    <form aria-busy={busy} onSubmit={event => { event.preventDefault(); void submit(); }} className="flex flex-col gap-4">
      <RadioGroup name="harness" value={harness} onChange={value => { setHarness(value); setProfileId(''); setModel(''); }} disabled={busy} aria-orientation="horizontal" className="flex flex-col gap-2">
        <Label className="text-xs font-medium text-muted">Harness</Label>
        <div className="grid grid-cols-[1.2fr_1fr_1.2fr_.8fr] gap-1.5 sm:grid-cols-4">
          {harnesses.map(item => <HeadlessField key={item.id} disabled={busy || !item.available} className="min-w-0">
            <Radio as="button" type="button" value={item.id} title={item.available ? item.name : `${item.name} · 未安装`} className="interactive flex h-16 w-full min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg border border-control-border px-1 text-xs leading-4 text-fg [&:not([data-checked]):not([data-disabled]):hover]:bg-surface-3 data-[checked]:border-accent data-[checked]:bg-accent data-[checked]:font-semibold data-[checked]:text-accent-fg data-[checked]:hover:bg-accent-hover data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
              <HarnessIcon harness={item.id} />
              <Label as="span" passive>{item.name}</Label>
              {!item.available ? <Description className="text-[10px] leading-3">未安装</Description> : null}
            </Radio>
          </HeadlessField>)}
        </div>
        <Description aria-live="polite" className="min-h-4 text-xs leading-4 text-muted [overflow-wrap:anywhere]">{info?.detail ?? (info ? '' : '没有可用的 Harness')}</Description>
      </RadioGroup>
      <Field autoFocus name="cwd" label="工作区" disabled={busy} value={cwd} onChange={event => setCwd(event.target.value)} placeholder="/path/to/project" required />
      <SessionProfileFields harness={harness} cwd={cwd} profileId={profileId} model={model} onProfile={id => { setProfileId(id); setModel(''); }} onModel={setModel} onManage={() => setProfilesOpen(true)} disabled={busy} />
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      <span role="status" className="sr-only">{busy ? '正在创建会话' : ''}</span>
      <div className="mt-1 flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy || !cwd.trim() || !info?.available}>{busy ? '正在创建…' : '创建会话'}</Button></div>
    </form>
  </DialogPanel></div></Dialog>{profilesOpen ? <ProfileManager harnesses={harnesses} initialHarness={harness} cwd={cwd} onClose={() => setProfilesOpen(false)} /> : null}</>;
}
