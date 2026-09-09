import { Dialog, DialogPanel, DialogTitle, Tab, TabGroup, TabList, TabPanel, TabPanels } from '@headlessui/react';
import { useEffect, useState } from 'react';
import type { HarnessId, HarnessInfo } from '../../../shared/types';
import type { HarnessProfile, ProfileInput } from '../../../shared/profiles';
import { Button, Field } from '../ui4a-ui';
import { Icon } from '../Icon';
import { HarnessIcon } from '../HarnessIcon';
import { ProfileFields } from '../ProfileFields';
import { useProfileOptions, useProfiles } from './ProfileProvider';

export function ProfileManager({ harnesses, initialHarness, cwd, onClose }: { harnesses: HarnessInfo[]; initialHarness?: HarnessId; cwd: string; onClose(): void }) {
  const { profiles, loading, error, refresh } = useProfiles();
  const [harness, setHarness] = useState(initialHarness ?? harnesses[0]?.id ?? 'claude-code'), [selected, setSelected] = useState<string>(), [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false), [pending, setPending] = useState<(() => void)>();
  const choices = profiles.filter(profile => profile.harness === harness), profile = choices.find(profile => profile.id === selected) ?? (!creating ? choices[0] : undefined);
  const navigate = (action: () => void) => { if (busy) return; if (dirty) setPending(() => action); else action(); };
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (!dirty) return; const prevent = (event: BeforeUnloadEvent) => event.preventDefault(); window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent); }, [dirty]);
  const selectHarness = (index: number) => { if (harnesses[index].id === harness) return; navigate(() => { setHarness(harnesses[index].id); setSelected(undefined); setCreating(false); }); };
  const newProfile = () => { if (creating) return; navigate(() => { setSelected(undefined); setCreating(true); }); };
  const selection = <div className="flex flex-wrap items-center gap-2">
    {choices.map(item => <button key={item.id} type="button" aria-pressed={!creating && profile?.id === item.id} disabled={busy} onClick={() => { if (!creating && profile?.id === item.id) return; navigate(() => { setSelected(item.id); setCreating(false); }); }} className="interactive max-w-full truncate rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface-3 hover:text-fg aria-pressed:bg-surface-3 aria-pressed:font-medium aria-pressed:text-fg">{item.name}</button>)}
    <Button variant="ghost" size="sm" onClick={newProfile} disabled={busy}><Icon name="plus" />新建 Profile</Button>
  </div>;
  return <>
    <Dialog open onClose={() => navigate(onClose)} className="relative z-50"><div className="fixed inset-0 bg-black/40" /><div className="fixed inset-0 flex items-center justify-center p-3 sm:p-6"><DialogPanel className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl sm:max-h-[calc(100dvh-3rem)]">
      <header className="flex shrink-0 items-start justify-between gap-4 px-5 pt-5 sm:px-6"><div><DialogTitle className="text-base font-medium">Profiles</DialogTitle><p className="mt-1 text-xs leading-5 text-muted">保存不同模型与连接配置，在会话中快速切换。</p></div><button type="button" aria-label="关闭 Profiles" disabled={busy} onClick={() => navigate(onClose)} className="interactive grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-3 hover:text-fg"><Icon name="x" /></button></header>
      <TabGroup selectedIndex={Math.max(0, harnesses.findIndex(item => item.id === harness))} onChange={selectHarness} className="mt-4 flex min-h-0 flex-1 flex-col">
        <TabList aria-label="Harness Profiles" className="mx-5 grid shrink-0 grid-cols-4 gap-1 rounded-lg bg-surface-3 p-1 sm:mx-6">{harnesses.map(item => <Tab key={item.id} disabled={busy} className="interactive flex min-w-0 flex-col items-center justify-center gap-1 rounded-md px-1 py-2 text-[11px] sm:flex-row sm:gap-1.5 text-muted data-[selected]:bg-surface data-[selected]:text-fg sm:text-sm"><HarnessIcon harness={item.id} /><span className="truncate">{item.name}</span></Tab>)}</TabList>
        <TabPanels className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 sm:px-6 sm:pb-6">{harnesses.map(item => <TabPanel key={item.id} className="pt-4">
          {error ? <div role="alert" className="mb-4 text-sm text-danger">{error}<Button size="sm" variant="ghost" onClick={() => { void refresh(); }}>重试</Button></div> : null}
          {loading ? <p role="status" className="py-4 text-sm text-muted">正在读取 Profiles…</p> : null}{selection}
          {creating || profile ? <ProfileEditor key={`${harness}:${creating ? 'new' : profile?.id}`} harness={harness} cwd={cwd} busy={busy} onBusy={setBusy} profile={creating ? undefined : profile} onDirty={setDirty} onSaved={saved => { setDirty(false); setSelected(saved.id); setCreating(false); }} onDeleted={() => { setDirty(false); setSelected(undefined); setCreating(false); }} /> : <div className="py-12 text-center"><p className="text-sm text-muted">目前使用 {item.name} 的本机配置。</p><p className="mt-2 text-xs text-muted">新建 Profile 后，即可单独设置模型、推理力度和连接方式。</p></div>}
        </TabPanel>)}</TabPanels>
      </TabGroup>
    </DialogPanel></div></Dialog>
    {pending ? <Dialog open onClose={() => setPending(undefined)} className="relative z-70"><div className="fixed inset-0 bg-black/40" /><div className="fixed inset-0 grid place-items-center p-4"><DialogPanel className="w-full max-w-sm rounded-2xl bg-surface p-5 shadow-2xl"><DialogTitle className="text-base font-medium">放弃未保存的修改？</DialogTitle><p className="mt-2 text-sm text-muted">模型、连接和凭据的修改尚未保存。</p><div className="mt-5 flex justify-end gap-2"><Button autoFocus variant="secondary" onClick={() => setPending(undefined)}>继续编辑</Button><Button variant="danger" onClick={() => { const action = pending; setPending(undefined); setDirty(false); action(); }}>放弃修改</Button></div></DialogPanel></div></Dialog> : null}
  </>;
}

function ProfileEditor({ harness, cwd, profile, busy, onBusy: setBusy, onDirty, onSaved, onDeleted }: { harness: HarnessId; cwd: string; profile?: HarnessProfile; busy: boolean; onBusy(busy: boolean): void; onDirty(dirty: boolean): void; onSaved(profile: HarnessProfile): void; onDeleted(): void }) {
  const { save, remove } = useProfiles(), catalog = useProfileOptions(harness, cwd, profile?.id, profile?.revision);
  const initial = () => ({ harness, name: profile?.name ?? '', config: structuredClone(profile?.config ?? {}) });
  const [input, setInput] = useState<ProfileInput>(initial), [baseline, setBaseline] = useState(() => JSON.stringify(initial()));
  const [revision, setRevision] = useState(profile?.revision);
  const [error, setError] = useState<string>(), [notice, setNotice] = useState(''), [deleting, setDeleting] = useState(false);
  const dirty = JSON.stringify(input) !== baseline;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => {
    // A refreshed native file may replace the cached DTO. Only pristine forms follow it automatically.
    if (!profile || dirty || revision === profile.revision) return;
    const next = { harness, name: profile.name, config: profile.config }; setInput(next); setBaseline(JSON.stringify(next)); setRevision(profile.revision);
  }, [profile, dirty, revision, harness]);
  const submit = async () => {
    if (busy) return; setBusy(true); setError(undefined); setNotice('');
    try {
      const saved = await save({ ...input, revision: profile?.pending ? profile.revision : revision }, profile?.id);
      const next = { harness, name: saved.name, config: saved.config }; setInput(next); setBaseline(JSON.stringify(next)); setRevision(saved.revision); onSaved(saved); setNotice('已保存，使用此 Profile 的会话从下一轮开始生效。');
    } catch (error) {
      const pending = (error as { pendingProfile?: HarnessProfile }).pendingProfile;
      if (!profile && pending) onSaved(pending);
      else setError(error instanceof Error ? error.message : '保存失败');
    }
    finally { setBusy(false); }
  };
  const destroy = async () => {
    if (!profile || busy) return; setBusy(true); setError(undefined);
    try { await remove(profile); onDeleted(); } catch (error) { setError(error instanceof Error ? error.message : '删除失败'); setDeleting(false); } finally { setBusy(false); }
  };
  return <><form onSubmit={event => { event.preventDefault(); void submit(); }} aria-busy={busy} className="mt-5 border-t border-border pt-5">
    <div className="mb-5"><Field autoFocus={!profile} label="Profile 名称" value={input.name} onChange={event => setInput({ ...input, name: event.target.value })} maxLength={100} required readOnly={profile?.source === 'codex'} disabled={busy} placeholder={harness === 'codex' ? '例如 work 或 personal' : '例如 工作网关'} hint={harness === 'codex' ? profile ? `原生文件：${profile.name}.config.toml · 文件名保持不变，配置与 Codex CLI 共用。` : '使用字母、数字、连字符或下划线；保存为 Codex 原生 Profile 文件。' : '配置保存在此服务的本地目录，不改写 Harness 的全局设置。'} /></div>
    {profile?.error ? <p role="alert" className="mb-4 text-sm text-danger">{profile.error}</p> : null}
    {catalog.options.error ? <div role="status" className="mb-4 text-xs text-muted">{catalog.options.error}<Button variant="ghost" size="sm" onClick={catalog.retry}>重新读取</Button></div> : null}
    {catalog.loading ? <p role="status" className="mb-4 text-xs text-muted">正在读取本机模型与可选功能…</p> : null}
    <ProfileFields harness={harness} config={input.config} onChange={config => setInput(current => ({ ...current, config }))} credentials={input.credentials} configured={profile?.pending ? { apiKey: false, authToken: false } : profile?.credentials ?? { apiKey: false, authToken: false }} onCredentialsChange={credentials => setInput(current => ({ ...current, credentials }))} disabled={busy || Boolean(profile?.error && !profile.pending)} options={catalog.options} />
    {error ? <p role="alert" className="mt-5 break-words text-sm text-danger">{error}</p> : null}
    <div className="mt-6 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-3">{profile ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDeleting(true)}>删除 Profile</Button> : <p className="text-xs text-muted">未填写的项目继承本机配置。</p>}<Button type="submit" disabled={busy || !input.name.trim() || Boolean(profile?.error && !profile.pending) || !dirty && !profile?.pending}>{busy ? '正在保存…' : '保存 Profile'}</Button></div>
      <p role="status" className="mt-3 text-xs leading-5 text-muted">{notice || '修改从下一轮开始生效；正在生成的回复保持当前配置。'}</p>
    </div>
  </form>
    <Dialog open={deleting} onClose={() => { if (!busy) setDeleting(false); }} className="relative z-70"><div className="fixed inset-0 bg-black/40" /><div className="fixed inset-0 grid place-items-center p-4"><DialogPanel className="w-full max-w-sm rounded-2xl bg-surface p-5 shadow-2xl"><DialogTitle className="text-base font-medium">删除「{profile?.name}」？</DialogTitle><p className="mt-2 text-sm text-muted">{profile?.source === 'codex' ? '对应的 Codex 原生 Profile 文件也会被删除。' : '配置及其保存的凭据将被移除。'}</p><div className="mt-5 flex justify-end gap-2"><Button autoFocus variant="secondary" disabled={busy} onClick={() => setDeleting(false)}>取消</Button><Button variant="danger" disabled={busy} onClick={() => { void destroy(); }}>{busy ? '正在删除…' : '确认删除'}</Button></div></DialogPanel></div></Dialog>
  </>;
}
