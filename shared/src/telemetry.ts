// Single source of truth for every analytics event macaron emits, client and
// server alike. Adding an event means adding a line here — `track()` on both
// sides is keyed off this map, so a typo in a name or a payload is a type error.
//
// Telemetry is on by default; MACARON_TELEMETRY=0 disables it entirely.

/** The three engine bundles. `engine` is a dimension we group by in umami, so
 * it must be a closed set — a stray value silently forks every chart. */
export type Engine = 'claude' | 'codex' | 'kimi';

export interface AnalyticsEvents {
  /** SPA booted. One per page load, per engine bundle. */
  app_mounted: { engine: Engine };
  /** Hash-router navigation, including the initial route. Carries the matched
   * route PATTERN, never the URL: `:project` params are absolute filesystem paths. */
  route_view: { path: string };

  /** Server-side: HTTP requests worth looking at — failures, slow responses, and
   * every mutation. Successful fast GETs are deliberately not reported. */
  request: { route: string; method: string; status: number; durationMs: number };

  run_started: { engine: Engine; resumed: boolean; hasImages: boolean; promptLen: number };
  /** Fired from abortRun() — the one place all three engines' /stop converge. */
  run_interrupted: { engine: Engine };
  run_finished: { engine: Engine; durationMs: number; ok: boolean };
  /** Client lost the SSE stream ABNORMALLY. A stream that ends because the turn
   * finished is not reported — that's what run_finished is for. */
  stream_disconnected: { engine: Engine; durationMs: number };

  /** Server-side: the model actually called render_ui. */
  render_ui_called: { engine: Engine; codeLen: number; diagnostics: number };
  /** Client-side: the card reached the screen. The gap vs. called is the funnel,
   * so this fires ONCE per widget — the renderer itself fires per streamed frame.
   * No codeLen: the first frame that compiles is a partial, so its length would
   * be systematically smaller than render_ui_called's (which sees the full code). */
  render_ui_rendered: { engine: Engine };
  render_ui_failed: { engine: Engine; phase: string; message: string };

  error: { where: string; message: string };
}

export type AnalyticsEventName = keyof AnalyticsEvents;

/** Error text ships to a hosted collector, so it must not carry the user's
 * machine. Node errors embed absolute paths (ENOENT), undici embeds the
 * upstream URL, and renderer errors embed model-generated source lines. */
export function redactMessage(msg: string): string {
  return msg
    .replace(/\b[a-z]+:\/\/\S+/gi, '<url>')
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '<email>')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}/g, '<key>')
    // The lookbehind is what keeps prose out: without it `8/8/2026` and
    // `and/or/maybe` both match and the message becomes unreadable.
    .replace(/(?:[A-Za-z]:)?(?<![\w])[\\/](?:[\w.-]+[\\/])+[\w.-]+/g, '<path>')
    .slice(0, 200);
}

/** What GET /api/telemetry answers. Empty host/websiteId/installId when disabled. */
export type TelemetryConfig = { enabled: boolean; host: string; websiteId: string; scriptPath: string; installId: string };
