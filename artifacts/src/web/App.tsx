import { useEffect, useState } from 'react';
import type { HarnessId } from '../shared/types';
import { useWorkspace } from './chat/WorkspaceProvider';
import { useTheme } from './theme/ThemeProvider';
import { Conversation } from './components/chat/Conversation';
import { Sidebar, SidebarDrawer } from './components/Sidebar';
import { NewSessionDialog } from './components/NewSessionDialog';
import { ArtifactPanel } from './components/ArtifactPanel';
import { Icon } from './components/Icon';
import { Select } from './components/Select';
import { Button } from './components/ui4a-ui';
import { SplitHandle, useSplit } from './components/useSplit';
import { AppearanceDialog } from './components/ThemePicker';
import { ProfileManager } from './components/profiles/ProfileManager';
import { SessionProfileDialog } from './components/profiles/SessionProfile';
import { useProfiles } from './components/profiles/ProfileProvider';

export default function App() {
  const { state, actions } = useWorkspace();
  const { appearance, preferences, error: themeError } = useTheme();
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false), [sessionSettings, setSessionSettings] = useState<string>();
  const { profiles } = useProfiles();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [newSession, setNewSession] = useState<{ harness?: HarnessId } | null>(null);
  const [emptyCanvasOpen, setEmptyCanvasOpen] = useState(false);
  const split = useSplit();
  const session = actions.active();
  const chat = session ? actions.chat(session.id) : undefined;
  const settingsSession = state.sessions.find(item => item.id === sessionSettings);
  const activeProfile = profiles.find(profile => profile.id === session?.profileId);
  const selectedArtifact = session ? actions.selectedArtifact(session.id) : undefined;
  const artifacts = session ? actions.artifacts(session.id) : [];
  const canvasOpen = Boolean(selectedArtifact) || emptyCanvasOpen;
  const create = () => setNewSession({ harness: session?.harness });
  useEffect(() => { document.title = session ? `${session.title} · Macaron Artifacts` : 'Macaron Artifacts'; }, [session?.title]);
  useEffect(() => { setEmptyCanvasOpen(false); }, [session?.id]);
  useEffect(() => {
    const warm = () => { void import('./ui4a/Ui4aSurface').then(module => module.warmUi4aRuntime()).catch(error => console.warn('[artifacts] renderer warmup failed', error)); };
    if ('requestIdleCallback' in window) { const handle = requestIdleCallback(warm); return () => cancelIdleCallback(handle); }
    const timer = setTimeout(warm, 0); return () => clearTimeout(timer);
  }, []);
  const sidebar = { sessions: state.sessions, activeId: state.activeId, cwd: session?.cwd ?? actions.defaultCwd(), onSelect: (id: string) => { void actions.select(id); }, onCreate: create, onDelete: (id: string) => { void actions.remove(id).catch(actions.fail); }, onAppearance: () => setAppearanceOpen(true), onProfiles: () => setProfilesOpen(true) };
  const closeCanvas = () => { if (session) actions.closeArtifact(session.id); setEmptyCanvasOpen(false); };
  const toggleCanvas = () => { if (canvasOpen) closeCanvas(); else if (session && artifacts.length) actions.openArtifact(session.id, artifacts[0].path); else setEmptyCanvasOpen(true); };

  return <main className="@container/shell flex h-dvh flex-col overflow-x-clip">
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3"><button type="button" onClick={() => setSidebarOpen(true)} title="会话" aria-label="打开会话列表" className="interactive grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-3 hover:text-fg @[960px]/shell:hidden"><Icon name="menu" /></button><span className="min-w-0 flex-1 truncate text-sm font-medium">{session?.title ?? 'Macaron Artifacts'}</span>
      {state.harnesses.length ? <div className="ml-auto w-28 shrink-0 @md:w-36"><Select label="选择 Harness" value={session?.harness ?? state.harnesses.find(item => item.available)?.id ?? state.harnesses[0].id} options={state.harnesses.map(item => ({ value: item.id, label: item.name, disabled: !item.available }))} onChange={harness => setNewSession({ harness })} /></div> : null}
      {session ? <button type="button" title="会话配置" aria-label="会话配置" aria-haspopup="dialog" onClick={() => setSessionSettings(session.id)} className="interactive flex size-8 shrink-0 items-center justify-center gap-2 rounded-lg text-sm text-muted hover:bg-surface-3 hover:text-fg @xl:w-auto @xl:max-w-48 @xl:px-3"><Icon name="sliders" /><span className="hidden truncate @xl:block">{activeProfile?.name ?? session.model ?? '会话配置'}</span></button> : null}
      <button type="button" onClick={() => setAppearanceOpen(true)} title="外观设置" aria-label="外观设置" aria-haspopup="dialog" className="interactive grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-3 hover:text-fg"><Icon name={preferences.mode === 'system' ? 'monitor' : appearance.dark ? 'moon' : 'sun'} /></button><button type="button" onClick={toggleCanvas} aria-pressed={canvasOpen} className={`interactive shrink-0 rounded-lg px-2 py-1 text-xs ${canvasOpen ? 'bg-surface-3 text-fg' : 'text-muted hover:bg-surface-3'}`}>Canvas</button>
    </header>
    {state.error || themeError ? <div role="alert" className="flex items-center gap-3 border-b border-danger/30 px-4 py-2 text-xs text-danger"><span className="min-w-0 flex-1 break-words">{state.error ?? themeError}</span><button type="button" onClick={actions.clearError} aria-label="关闭错误提示" className="grid size-7 place-items-center"><Icon name="x" /></button></div> : null}
    <div className="flex min-h-0 flex-1"><Sidebar {...sidebar} /><SidebarDrawer {...sidebar} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div ref={split.container} className="@container/panes flex min-h-0 min-w-0 flex-1" style={{ ['--canvas-w' as string]: `${(split.fraction * 100).toFixed(2)}%` }}>
        <div className={`min-w-0 flex-1 ${canvasOpen ? 'hidden @[681px]/panes:flex' : 'flex'}`}>
          {session && chat ? <Conversation key={session.id} instance={chat} session={session} store={actions} /> : <div className="flex flex-1 items-center justify-center p-6"><div className="max-w-sm text-center">{!state.ready || state.loading ? <p className="text-sm text-muted" role="status">正在载入会话…</p> : <><p className="mb-4 text-sm text-muted">在同一个工作区里，用熟悉的 harness 构建界面。</p><Button onClick={create} disabled={!state.harnesses.some(item => item.available)}>新会话</Button>{state.harnesses.length && !state.harnesses.some(item => item.available) ? <p className="mt-3 text-xs text-danger">尚未检测到可用的 harness。请检查 CLI 安装或 pi SDK 加载状态。</p> : null}</>}</div></div>}
        </div>
        {canvasOpen ? <SplitHandle fraction={split.fraction * 100} dragging={split.dragging} handlers={split.handlers} /> : null}
        {canvasOpen ? <aside className="min-w-0 w-full @[681px]/panes:w-[clamp(300px,var(--canvas-w),calc(100%-381px))]">{session ? <ArtifactPanel key={session.id} session={session} artifacts={artifacts} selected={selectedArtifact} onSelect={path => actions.openArtifact(session.id, path)} onClose={closeCanvas} onSend={text => actions.send(session.id, text)} /> : <div className="flex h-full flex-col"><header className="flex h-12 items-center justify-between border-b border-border px-3 text-sm">Canvas<button type="button" onClick={closeCanvas} aria-label="关闭 Canvas"><Icon name="x" /></button></header><p className="p-6 text-xs text-muted">创建会话后，生成的界面会显示在这里。</p></div>}</aside> : null}
      </div>
    </div>
    {newSession ? <NewSessionDialog key={newSession.harness ?? 'default'} harnesses={state.harnesses} initialHarness={newSession.harness} initialCwd={actions.defaultCwd()} onClose={() => setNewSession(null)} onCreate={actions.create} /> : null}
    {appearanceOpen ? <AppearanceDialog onClose={() => setAppearanceOpen(false)} /> : null}
    {settingsSession ? <SessionProfileDialog key={settingsSession.id} session={settingsSession} running={settingsSession.status === 'running'} onClose={() => setSessionSettings(undefined)} onManage={() => setProfilesOpen(true)} onSave={input => actions.configure(settingsSession.id, input)} /> : null}
    {profilesOpen ? <ProfileManager harnesses={state.harnesses} initialHarness={settingsSession?.harness ?? session?.harness} cwd={settingsSession?.cwd ?? session?.cwd ?? actions.defaultCwd()} onClose={() => setProfilesOpen(false)} /> : null}
  </main>;
}
