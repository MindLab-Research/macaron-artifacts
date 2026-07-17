// PWA + Web Push client helpers. Registers the service worker (web/public/sw.js)
// and manages the browser's push subscription against the server's VAPID key.
//
// Everything here is feature-guarded and secure-context-guarded so a desktop
// browser, an insecure origin, or an iOS Safari tab (where push needs an
// installed PWA) degrades to "unsupported" rather than throwing.

import { authedFetch } from './auth';
import { assetUrl } from './assetBase';

// Base-relative so the SW resolves under /app/ when hosted, not just at root.
const SW_URL = assetUrl('/sw.js');

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

// Registers the SW and wires the click→navigate bridge. The SW posts
// {type:'macaron:navigate', url} on notificationclick; we apply it to the hash
// router. Safe to call on every boot — register() is idempotent.
export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(SW_URL).catch(() => { /* registration is best-effort */ });
  });
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as { type?: string; url?: string } | undefined;
    if (data?.type === 'macaron:navigate' && data.url) {
      // createHashRouter → strip a leading `/#` or `#` and let the browser
      // re-add it. The server roots the deep link at `/#/…` (so the SW
      // cold-start openWindow resolves it against the origin, not /sw.js).
      window.location.hash = data.url.replace(/^\/?#/, '');
      window.focus?.();
    }
  });
}

export type PushState = 'unsupported' | 'denied' | 'subscribed' | 'unsubscribed';

export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub ? 'subscribed' : 'unsubscribed';
  } catch {
    return 'unsupported';
  }
}

// VAPID applicationServerKey must be a BufferSource, not the base64url string.
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Whether an existing subscription was minted against `key`. If the server's
// VAPID pair was regenerated, the old subscription would keep failing with 403
// (never pruned — that's only 404/410), so we must drop and re-subscribe.
function keysMatch(sub: PushSubscription, key: Uint8Array): boolean {
  const existing = sub.options.applicationServerKey;
  if (!existing) return false;
  const a = new Uint8Array(existing);
  if (a.length !== key.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== key[i]) return false;
  return true;
}

export async function subscribeToPush(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'unsubscribed';
  const vapidRes = await authedFetch('/api/push/vapid-public-key');
  if (!vapidRes.ok) throw new Error(`vapid key fetch failed (${vapidRes.status})`);
  const { publicKey } = await vapidRes.json();
  const appServerKey = urlBase64ToUint8Array(publicKey);
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // Re-subscribe if there's no sub, or the cached one is bound to a stale key.
  if (sub && !keysMatch(sub, appServerKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appServerKey });
  }
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  const res = await authedFetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
  });
  if (!res.ok) throw new Error(`subscribe failed (${res.status})`);
  return 'subscribed';
}

export async function unsubscribeFromPush(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await authedFetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      await sub.unsubscribe();
    }
  } catch { /* best-effort */ }
  return 'unsubscribed';
}
