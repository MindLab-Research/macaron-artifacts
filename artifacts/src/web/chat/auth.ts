export interface ServerAuth { enabled: boolean; authenticated: boolean }
const listeners = new Set<() => void>();
let generation = 0;

export function subscribePasswordRequired(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function acceptPasswordSession() { generation++; }
function isSameOrigin(input: RequestInfo | URL) {
  const url = input instanceof Request ? input.url : String(input);
  try { return new URL(url, window.location.href).origin === window.location.origin; } catch { return false; }
}

/** Only this page's password gate can expire; a paired agent's bearer-token failure is a different login flow. */
export async function authenticatedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const current = generation, response = await fetch(input, init);
  if (response.status === 401 && isSameOrigin(input)) {
    const body = await response.clone().json().catch(() => null) as { passwordRequired?: boolean } | null;
    if (body?.passwordRequired === true && current === generation) { generation++; for (const listener of listeners) listener(); }
  }
  return response;
}

export async function requestAuth(action?: 'login' | 'logout', password?: string, signal?: AbortSignal): Promise<ServerAuth> {
  // Authentication belongs to the server serving the page, never to a stored pairing origin.
  const response = await fetch(`/api/auth${action ? `/${action}` : ''}`, { method: action ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal, ...(action === 'login' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) } : {}) });
  if (!response.ok) {
    const retryAfter = Number(response.headers.get('retry-after'));
    const message = response.status === 401 ? '密码不正确，请重试。' : response.status === 429 ? `尝试次数过多，请${retryAfter > 0 ? ` ${Math.ceil(retryAfter)} 秒后` : '稍后'}再试。` : `无法连接到服务，请重试。（${response.status}）`;
    throw new Error(message);
  }
  const state = await response.json().catch(() => null) as ServerAuth | null;
  if (!state || typeof state.enabled !== 'boolean' || typeof state.authenticated !== 'boolean') throw new Error('服务返回了无效的登录状态，请重试。');
  return state;
}
