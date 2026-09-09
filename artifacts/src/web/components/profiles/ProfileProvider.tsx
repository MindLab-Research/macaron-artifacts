import { createContext, use, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { HarnessProfile, ProfileInput, ProfileOptions } from '../../../shared/profiles';
import type { HarnessId } from '../../../shared/types';
import { api } from '../../chat/store';

interface ProfilesContextValue { profiles: HarnessProfile[]; loading: boolean; error?: string; refresh(): Promise<HarnessProfile[] | undefined>; save(input: ProfileInput, id?: string): Promise<HarnessProfile>; remove(profile: HarnessProfile): Promise<void> }
const ProfilesContext = createContext<ProfilesContextValue | null>(null);

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [profiles, setProfiles] = useState<HarnessProfile[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState<string>();
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current; setLoading(true); setError(undefined);
    try { const result = await api<HarnessProfile[]>('/api/profiles'); if (generation.current === current) setProfiles(result); return result; }
    catch (error) { if (generation.current === current) setError(error instanceof Error ? error.message : '无法读取 Profiles'); }
    finally { if (generation.current === current) setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, [refresh]);
  const save = async (input: ProfileInput, id?: string) => {
    let profile: HarnessProfile;
    try { profile = await api<HarnessProfile>(id ? `/api/profiles/${encodeURIComponent(id)}` : '/api/profiles', { method: id ? 'PUT' : 'POST', body: JSON.stringify(input) }); }
    catch (error) {
      const profiles = await refresh(), pendingProfile = profiles?.find(profile => profile.pending && profile.id === (id ?? `codex:${input.name}`));
      throw Object.assign(error instanceof Error ? error : new Error('保存失败'), { pendingProfile });
    }
    generation.current++; setLoading(false); setError(undefined);
    setProfiles(current => [...current.filter(item => item.id !== profile.id), profile]); return profile;
  };
  const remove = async (profile: HarnessProfile) => {
    await api(`/api/profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE', body: JSON.stringify({ revision: profile.revision }) });
    generation.current++; setLoading(false); setProfiles(current => current.filter(item => item.id !== profile.id));
  };
  return <ProfilesContext value={{ profiles, loading, error, refresh, save, remove }}>{children}</ProfilesContext>;
}
export function useProfiles() { const context = use(ProfilesContext); if (!context) throw new Error('ProfileProvider is required'); return context; }

const emptyOptions: ProfileOptions = { models: [], efforts: [] };
export function useProfileOptions(harness: HarnessId, cwd: string, profileId?: string, revision?: string) {
  const [state, setState] = useState<{ key: string; options: ProfileOptions; loading: boolean }>({ key: '', options: emptyOptions, loading: true });
  const [retry, setRetry] = useState(0), key = JSON.stringify([harness, cwd, profileId, revision]);
  useEffect(() => {
    const controller = new AbortController();
    // Workspace paths can be typed. Avoid starting a native catalog process for every keystroke.
    const timer = setTimeout(() => {
      setState({ key, options: emptyOptions, loading: true });
      const query = new URLSearchParams({ cwd: cwd || '.', ...(profileId ? { profileId } : {}) });
      void api<ProfileOptions>(`/api/harnesses/${harness}/profile-options?${query}`, { signal: controller.signal }).then(options => {
        if (!controller.signal.aborted) setState({ key, options, loading: false });
      }).catch(error => { if (!controller.signal.aborted) setState({ key, options: { ...emptyOptions, error: error instanceof Error ? error.message : '无法读取选项' }, loading: false }); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [harness, cwd, profileId, key, retry]);
  return { options: state.key === key ? state.options : emptyOptions, loading: state.key !== key || state.loading, retry: () => setRetry(value => value + 1) };
}
