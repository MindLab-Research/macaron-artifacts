// Bridges an SDK run's lifecycle events to Web Push. Called from the two run
// loops (new session + follow-up message) on exactly the events the issue
// calls out: a run finishing, and a run hitting a permission gate. Unlike the
// in-app notify stack (web/src/lib/notify.ts), this fires server-side, so a
// phone whose tab is closed still gets alerted.
//
// Best-effort: sendPush never throws and no-ops with zero subscriptions, so a
// missing/failed push can't disturb the stream.

import { sendPush } from './push-store.js';

// The client uses a hash router (createHashRouter). Root the path at `/#/…` so
// the service worker's cold-start clients.openWindow() resolves it against the
// host origin, not the SW script URL (/sw.js) — a bare `#/…` would open
// `/sw.js#/…` and serve the raw worker file instead of the app.
function sessionUrl(project: string, sid: string): string {
  return `/#/w/${encodeURIComponent(project)}/s/${encodeURIComponent(sid)}`;
}

export function pushPermissionRequest(project: string, sid: string, toolName: string): void {
  void sendPush({
    title: 'Macaron · permission needed',
    body: `${toolName} wants to run`,
    tag: `macaron-perm-${sid}`,
    requireInteraction: true,
    url: sessionUrl(project, sid),
  });
}

export function pushSessionDone(project: string, sid: string): void {
  void sendPush({
    title: 'Macaron · session ready',
    body: `${sid.slice(0, 8)} finished a turn`,
    tag: `macaron-done-${sid}`,
    url: sessionUrl(project, sid),
  });
}
