// Macaron push service worker. Deliberately push-only: it does NOT precache
// app HTML/JS, so a rebuild + refresh always serves the latest bundle. Its
// only jobs are showing Web Push notifications and routing clicks back into
// the SPA.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// The SW is registered under the app's base path — `/` for a local mcc/mcx
// server, `/app/` when the docs site hosts the bundle at a subpath. Derive that
// base from the SW's own scope so icon paths and the cold-start open URL resolve
// under the app, not the docs root (where `/icons/*` and `/` would 404 / miss).
const BASE = new URL(self.registration.scope).pathname.replace(/\/$/, ''); // '' or '/app'
const asset = (p) => BASE + p;
// The server builds deep links root-relative (`/#/w/:project/s/:sid`) — it can't
// know the client's hosted base. Rebase such a link under the app so a hosted
// push opens `/app/#/…`, not the docs root.
const rebase = (u) => (typeof u === 'string' && u.startsWith('/#') ? asset(u) : u);

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Macaron', body: event.data && event.data.text() };
  }
  const title = payload.title || 'Macaron';
  event.waitUntil(
    // Dedupe against a focused tab: the in-app NotifyStack already shows this
    // event, so skip the redundant system notification. But only for the
    // low-stakes "session ready" ping — a permission gate (requireInteraction)
    // is issue #18's headline "a backgrounded session needs input", and the
    // in-app card only fires for a session whose tile is currently mounted on
    // the viewed canvas. Suppressing on any focused window would silently drop
    // the gate for a background session whenever an unrelated tab is focused.
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const active = clientList.some((c) => c.focused || c.visibilityState === 'visible');
      if (active && !payload.requireInteraction) return undefined;
      return self.registration.showNotification(title, {
        body: payload.body || '',
        icon: asset('/icons/icon-192.png'),
        badge: asset('/icons/badge.png'),
        tag: payload.tag,
        renotify: Boolean(payload.tag),
        requireInteraction: Boolean(payload.requireInteraction),
        data: { url: rebase(payload.url) || asset('/') },
      });
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || asset('/');
  // The deep link is a hash route (`/#/w/:project/s/:sid`); a client already on
  // that session is the one to focus. Match its hash so a push for session C
  // doesn't yank an unrelated tab showing session B.
  const targetHash = url.slice(url.indexOf('#'));
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        const sameOrigin = clientList.filter((c) => c.url.includes(self.location.origin));
        const onTarget = sameOrigin.find((c) => c.url.includes(targetHash));
        const client = onTarget || sameOrigin[0];
        if (client) {
          client.focus();
          client.postMessage({ type: 'macaron:navigate', url });
          return undefined;
        }
        return self.clients.openWindow(url);
      }),
  );
});
