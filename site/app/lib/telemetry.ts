// Anonymous usage reporting for the docs site, on our own umami instance.
//
// A separate umami website from the local WebUI's: this is a public marketing
// and docs site, so the questions are entirely different — which install path
// people actually copy and which documentation helps them get started.
// Sharing one website id would mix those with per-machine WebUI usage and make
// both unreadable.
//
// Page views come from umami's own autoTrack (this is a real multi-page router,
// not the WebUI's hash router), so only intent-carrying interactions are here.

const HOST = 'https://u-m-a-m-i.macaron.im';
const WEBSITE_ID = 'c2b171a3-5bac-442d-aef7-f861e2cec3d8';

export interface SiteEvents {
  /** Hero / card links out of the landing page. */
  cta_click: { target: string; section: string };
  /** A command was copied to the clipboard — the strongest install-intent signal. */
  command_copy: { engine: 'shared'; kind: 'bunx' };
}

type Umami = { track: (name: string, data?: Record<string, unknown>) => void };

export function track<K extends keyof SiteEvents>(name: K, data: SiteEvents[K]): void {
  (window as unknown as { umami?: Umami }).umami?.track(name, data as Record<string, unknown>);
}

/** Injected from the document head so autoTrack sees the very first page view.
 * Rendered as a plain <script> tag by root.tsx rather than appended at runtime. */
export const trackerProps = { src: `${HOST}/u.js`, 'data-website-id': WEBSITE_ID, 'data-do-not-track': 'true' };
