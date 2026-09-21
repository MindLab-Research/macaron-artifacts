import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { useState } from 'react';
import type { HarnessId, SessionSummary } from '../../../shared/types';
import { Select } from '../Select';
import { FreeChoice } from '../ProfileFields';
import { Button } from '../ui4a-ui';
import { useProfileOptions, useProfiles } from './ProfileProvider';

export function SessionProfileFields({ harness, cwd, profileId, model, onProfile, onModel, onManage, disabled }: { harness: HarnessId; cwd: string; profileId: string; model: string; onProfile(id: string): void; onModel(model: string): void; onManage(): void; disabled: boolean }) {
  const { profiles, loading, error, refresh } = useProfiles();
  const choices = profiles.filter(profile => profile.harness === harness), selected = choices.find(profile => profile.id === profileId);
  const catalog = useProfileOptions(harness, cwd, profileId || undefined, selected?.revision);
  return <>
    <div><div className="mb-1.5 flex items-center justify-between gap-2"><span className="text-xs font-medium text-muted">Profile</span><button type="button" onClick={onManage} disabled={disabled} aria-haspopup="dialog" className="interactive rounded text-xs text-muted hover:text-fg disabled:opacity-50">管理 Profiles</button></div>
      <Select label="Profile" value={profileId} options={[{ value: '', label: '继承本机配置' }, ...choices.map(profile => ({ value: profile.id, label: profile.name, disabled: Boolean(profile.error) })), ...(profileId && !selected ? [{ value: profileId, label: 'Profile 已不可用，请重新选择', disabled: true }] : [])]} onChange={onProfile} disabled={disabled || loading} />
      {loading ? <p role="status" className="mt-1.5 text-xs text-muted">正在读取 Profiles…</p> : null}
      {error ? <p role="alert" className="mt-1.5 text-xs text-danger">{error}<button type="button" onClick={() => { void refresh(); }} className="ml-2 underline">重试</button></p> : null}
    </div>
    <FreeChoice label="本会话模型" value={model} options={catalog.options.models.map(item => ({ value: item.id, label: item.name, detail: item.provider }))} onChange={onModel} placeholder={selected?.config.model ? `继承 · ${selected.config.model}` : '继承 Profile 或本机配置'} hint="只覆盖当前会话的主模型；留空跟随所选 Profile。" disabled={disabled} />
    {catalog.options.error ? <p role="status" className="text-xs text-muted">{catalog.options.error}</p> : null}
  </>;
}

export function SessionProfileDialog({ session, running, onClose, onManage, onSave }: { session: SessionSummary; running: boolean; onClose(): void; onManage(): void; onSave(input: { profileId: string | null; model: string | null }): Promise<void> }) {
  const [profileId, setProfileId] = useState(session.profileId ?? ''), [model, setModel] = useState(session.model ?? ''), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const submit = async () => {
    if (busy || running) return; setBusy(true); setError(undefined);
    try { await onSave({ profileId: profileId || null, model: model.trim() || null }); onClose(); }
    catch (error) { setError(error instanceof Error ? error.message : '无法保存会话配置'); } finally { setBusy(false); }
  };
  return <Dialog open onClose={() => { if (!busy) onClose(); }} className="relative z-dialog"><div className="fixed inset-0 bg-black/40" /><div className="fixed inset-0 flex items-center justify-center p-3"><DialogPanel className="theme-widget max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl p-5"><DialogTitle className="text-base font-medium">会话配置</DialogTitle><p className="mt-1 text-xs leading-5 text-muted">切换 Profile 后，下一轮沿用当前会话继续。</p>
    <form onSubmit={event => { event.preventDefault(); void submit(); }} aria-busy={busy} className="mt-5 flex flex-col gap-4">
      <SessionProfileFields harness={session.harness} cwd={session.cwd} profileId={profileId} model={model} onProfile={id => { setProfileId(id); setModel(''); }} onModel={setModel} onManage={onManage} disabled={busy || running} />
      {running ? <p role="status" className="text-xs text-muted">当前一轮正在生成，结束后可切换。</p> : null}{error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      <div className="mt-2 flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy || running}>{busy ? '正在保存…' : '保存配置'}</Button></div>
    </form>
  </DialogPanel></div></Dialog>;
}
