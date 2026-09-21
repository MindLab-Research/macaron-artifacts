import { createContext, use, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { acceptPasswordSession, requestAuth, subscribePasswordRequired, type ServerAuth } from '../chat/auth';
import { Button, Field } from './ui4a-ui';

interface AuthContextValue { enabled: boolean; loggingOut: boolean; logoutError?: string; logout(): Promise<void> }
const AuthContext = createContext<AuthContextValue>({ enabled: false, loggingOut: false, logout: async () => {} });
export function useServerAuth() { return use(AuthContext); }
const connectionError = (error: unknown) => error instanceof TypeError ? '无法连接到服务，请检查网络后重试。' : error instanceof Error ? error.message : '暂时无法登录，请重试。';

export function AuthGate({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<ServerAuth>(), [checking, setChecking] = useState(true), [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0), [loggingOut, setLoggingOut] = useState(false), [logoutError, setLogoutError] = useState<string>();
  const logoutPending = useRef(false);
  useEffect(() => { if (checking || !auth || auth.enabled && !auth.authenticated) document.title = 'Macaron Artifacts'; }, [checking, auth?.enabled, auth?.authenticated]);
  useEffect(() => {
    const controller = new AbortController();
    const unsubscribe = subscribePasswordRequired(() => { controller.abort(); setAuth({ enabled: true, authenticated: false }); setChecking(false); setError(undefined); setLogoutError(undefined); });
    setChecking(true); setError(undefined);
    void requestAuth(undefined, undefined, controller.signal).then(state => { if (!controller.signal.aborted) { setAuth(state); setChecking(false); } }).catch(reason => { if (!controller.signal.aborted) { setError(connectionError(reason)); setChecking(false); } });
    return () => { controller.abort(); unsubscribe(); };
  }, [attempt]);
  const login = useCallback(async (password: string) => {
    const state = await requestAuth('login', password);
    if (state.enabled && !state.authenticated) throw new Error('登录未完成，请重试。');
    acceptPasswordSession(); setAuth(state); setError(undefined);
  }, []);
  const logout = useCallback(async () => {
    if (logoutPending.current) return;
    logoutPending.current = true; setLoggingOut(true); setLogoutError(undefined);
    try { const state = await requestAuth('logout'); acceptPasswordSession(); setAuth(state); }
    catch (reason) { setLogoutError(connectionError(reason)); }
    finally { logoutPending.current = false; setLoggingOut(false); }
  }, []);
  if (!checking && auth && (!auth.enabled || auth.authenticated)) return <AuthContext value={{ enabled: auth.enabled, loggingOut, logoutError, logout }}>{children}</AuthContext>;
  return <main className="flex h-dvh flex-col overflow-y-auto bg-surface px-6 py-12"><div className="m-auto w-full max-w-sm shrink-0">
    <p className="mb-8 text-sm font-medium text-muted">Macaron Artifacts</p>
    {checking ? <p role="status" className="text-sm text-muted">正在连接服务…</p> : auth ? <PasswordForm onLogin={login} /> : <><h1 className="mb-3 text-xl font-medium">暂时无法连接</h1><p role="alert" className="mb-6 text-sm leading-6 text-muted">{error}</p><Button onClick={() => setAttempt(value => value + 1)}>重新连接</Button></>}
  </div></main>;
}

function PasswordForm({ onLogin }: { onLogin(password: string): Promise<void> }) {
  const [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const pending = useRef(false);
  const submit = async () => {
    if (pending.current || !password) return;
    pending.current = true; setBusy(true); setError(undefined);
    try { await onLogin(password); }
    catch (reason) { setError(connectionError(reason)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <><h1 className="mb-3 text-2xl font-medium tracking-tight">登录工作区</h1><p className="mb-8 text-sm leading-6 text-muted">输入此服务的密码，继续使用你的 coding agents。</p>
    <form aria-busy={busy} onSubmit={event => { event.preventDefault(); void submit(); }} className="flex flex-col gap-5">
      <Field autoFocus type="password" name="password" label="访问密码" autoComplete="current-password" required readOnly={busy} value={password} onChange={event => { setPassword(event.target.value); setError(undefined); }} aria-invalid={Boolean(error)} aria-describedby={error ? 'login-error' : undefined} />
      {error ? <p id="login-error" role="alert" className="text-sm leading-6 text-danger">{error}</p> : null}
      <Button type="submit" disabled={busy || !password}>{busy ? '正在登录…' : '登录'}</Button>
      <span role="status" className="sr-only">{busy ? '正在验证密码' : ''}</span>
    </form>
  </>;
}
