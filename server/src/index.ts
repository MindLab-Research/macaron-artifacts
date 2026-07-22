import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { AUTH_TOKEN, ALLOWED_ORIGINS, HOST, PORT, WEB_DIST } from './config.js';
import { makeAuthHook, redactTokenInUrl, resolveToken, setArmedToken } from './lib/auth.js';
import { makeCorsHook } from './lib/cors.js';
import { warmSettingsCache, seedProviderFromEnv } from './lib/settings-store.js';
import { warmWorktreeCache } from './lib/worktree-store.js';
import { warmPermissionRulesCache } from './lib/permission-rules.js';
import { warmShareCache } from './lib/share-store.js';
import { warmCodexConfigCache } from './lib/codex-config.js';
import { warmKimiConfigCache } from './lib/kimi-config.js';
import { warmLabelsCache } from './lib/label-store.js';
import { warmSchedulesCache } from './lib/schedule-store.js';
import { startScheduler } from './lib/scheduler.js';
import { warmCodexTitlesCache } from './lib/codex-titles.js';
import { checkGenUI } from './lib/genui-check.js';
import { startSessionWatcher } from './lib/session-watcher.js';

// Claude Agent SDK kills MCP tool calls after 60s by default. Macaron renders
// for complex UIs can take 30-120s, so raise the ceiling to 5 min.
process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT || '300000';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerFsRoutes } from './routes/fs.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerWorktreeRoutes } from './routes/worktrees.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerHooksRoutes } from './routes/hooks.js';
import { registerSkillRoutes } from './routes/skills.js';
import { registerCommandRoutes } from './routes/commands.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { registerConfigFileRoutes } from './routes/config-files.js';
import { registerRelayRoutes } from './routes/relay.js';
import { registerCodexRoutes } from './routes/codex.js';
import { registerKimiRoutes } from './routes/kimi.js';
import { registerGitRoutes } from './routes/git.js';
import { registerShareRoutes } from './routes/share.js';
import { registerGenuiExportRoutes } from './routes/genui-export.js';
import { registerSearchRoutes } from './routes/search.js';
import { isSearchEnabled, syncAll } from './lib/search-index.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerPushRoutes } from './routes/push.js';
import { registerTunnelRoutes } from './routes/tunnel.js';
import { shutdownTunnel } from './lib/tunnel-manager.js';
import { registerUsageRoutes } from './routes/usage.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerScheduleRoutes } from './routes/schedules.js';
import { registerTerminalRoutes } from './routes/terminal.js';
import { registerFileRoutes } from './routes/files.js';

const app = Fastify({
  logger: {
    level: process.env.MACARON_LOG_LEVEL || 'info',
    // pino's default req serializer logs req.url verbatim, so a `?token=` share
    // link would land in every request line. Strip the token before it's logged.
    serializers: {
      req(req) {
        return {
          method: req.method,
          url: redactTokenInUrl(req.url),
          host: req.host,
          remoteAddress: req.ip,
          remotePort: req.socket?.remotePort,
        };
      },
    },
  },
  // Disable strict trailing-slash for friendlier URLs.
  ignoreTrailingSlash: true,
  // Allow large request bodies. GenUI prompts + inlined image attachments
  // (base64-encoded dataUrls) can easily blow past a few MB: a single
  // full-screen retina screenshot ~ 3–5 MB after base64. 2 MB used to 413
  // any reply that carried a modest screenshot. 32 MB gives comfortable
  // headroom for multi-image messages without letting a runaway upload
  // OOM the process.
  bodyLimit: 32 * 1024 * 1024,
  // Worktree cwds can be long (deep repo paths encoded as path params), and
  // Fastify caps a single param at 100 chars by default — a worktree under
  // .../macaron-genui-demo/.claude/worktrees/<name> blows past it and 414s every
  // /api/.../:project route. Raise it well above any plausible cwd.
  maxParamLength: 4000,
});

let closing = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down macaron server');
  shutdownTunnel();
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

// The Claude Agent SDK (and its transitive undici) fires fetches whose failures
// bubble up as UNHANDLED rejections when the remote closes the TLS socket
// mid-request (`TypeError: terminated` / `UND_ERR_SOCKET: other side closed`).
// Node's default is to crash the whole process on unhandled rejection, so one
// flaky provider request killed the WebUI server and left every open session
// silently stalled (SSE closed → client saw "done" with no output → confusing
// "finished" notification with no visible response).
//
// Log-and-continue: the SDK's own iterator will re-surface the error to its
// caller (claude-runner) which already emits an SSE `error`+`done` for that
// specific session. Keeping the process alive lets other sessions keep working.
process.on('unhandledRejection', (reason: unknown) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  app.log.error({ err, kind: 'unhandledRejection' }, '[macaron-server] unhandled promise rejection — staying alive');
});
process.on('uncaughtException', (err: Error) => {
  app.log.error({ err, kind: 'uncaughtException' }, '[macaron-server] uncaught exception — staying alive');
});

// Gate the API/relay behind a shared token when the server is reachable from
// the network. resolveToken auto-generates one when bound to a non-loopback
// host with no token set; seed it into the module-level armed slot so the hook
// and a later tunnel-start share one live secret.
const { token: authToken, generated: authGenerated } = resolveToken(HOST, AUTH_TOKEN, ALLOWED_ORIGINS.length > 0);
setArmedToken(authToken);
// CORS/LNA must run before auth so a token-less OPTIONS preflight is answered
// (and short-circuited) instead of being 401'd by the auth hook. Registered
// unconditionally: with an empty allowlist (the default) it emits no CORS
// headers but still 403s any cross-origin request before it can route — a
// gate an off-by-config `if` would silently drop. Same-origin and no-Origin
// CLI requests pass through untouched.
app.addHook('onRequest', makeCorsHook(ALLOWED_ORIGINS));
app.addHook('onRequest', makeAuthHook());

await app.register(async (instance) => {
  await registerHealthRoutes(instance);
  await registerAuthRoutes(instance);
  await registerSettingsRoutes(instance);
  await registerCommandRoutes(instance);
  await registerPushRoutes(instance);
  await registerUsageRoutes(instance);
  await registerHooksRoutes(instance);
  await registerAnalyticsRoutes(instance);
  await registerSkillRoutes(instance);
  await registerMcpRoutes(instance);
  await registerConfigFileRoutes(instance);
  await registerRelayRoutes(instance);
  await registerTunnelRoutes(instance);
  await registerProjectRoutes(instance);
  await registerFsRoutes(instance);
  await registerWorktreeRoutes(instance);
  // Engine-specific route groups. Each launcher sets MACARON_ENGINE and mounts
  // only its own engine's runner routes, so a boot never touches another
  // engine's runner module (and, with the runners' SDKs lazy-imported, never
  // its SDK). The default (unset) engine is claude.
  const engine = process.env.MACARON_ENGINE;
  if (engine === 'codex') {
    await registerCodexRoutes(instance);
  } else if (engine === 'kimi') {
    await registerKimiRoutes(instance);
  } else {
    await registerWorkspaceRoutes(instance);
    await registerSessionRoutes(instance);
  }
  await registerGitRoutes(instance);
  await registerShareRoutes(instance);
  await registerGenuiExportRoutes(instance);
  await registerSearchRoutes(instance);
  await registerAgentRoutes(instance);
  await registerScheduleRoutes(instance);
  await registerTerminalRoutes(instance);
  await registerFileRoutes(instance);
});

// Static assets + SPA fallback. In dev (vite dev server on :5173 with proxy),
// WEB_DIST may not exist — just register a 404 handler in that case.
if (existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, {
    root: WEB_DIST,
    prefix: '/',
    // Don't auto-serve index.html at `/` — we route it ourselves so
    // MACARON_ENGINE=codex can steer `/` to codex.html instead.
    index: false,
  });
  // Three SPA entries live side-by-side in web/dist: index.html (claude),
  // codex.html and kimi.html. The env decides which one is the SPA fallback
  // for `/` and any deep-link URL, so `mcc` boots the claude UI, `mcx` boots
  // codex and `mkx` boots kimi from the same server binary. Static assets
  // (JS/CSS/wasm chunks) come from the shared /assets/ folder and are shared
  // between entries.
  const spaEntry =
    process.env.MACARON_ENGINE === 'kimi' ? 'kimi.html' :
    process.env.MACARON_ENGINE === 'codex' ? 'codex.html' : 'index.html';
  // Explicit root — fastify-static's `index: false` refuses `/`, so own it here.
  app.get('/', (_req, reply) => reply.sendFile(spaEntry));
  app.setNotFoundHandler((req, reply) => {
    // Don't serve the SPA for /api paths — let them surface as 404 JSON.
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ error: 'not found', path: req.url });
    }
    return reply.sendFile(spaEntry);
  });
} else {
  app.log.warn(`web dist not found at ${WEB_DIST} — running in API-only mode (use vite dev for the UI)`);
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: 'not found', path: req.url }),
  );
}

try {
  await warmSettingsCache();
  // One-liner bootstrap: if MACARON_PROVIDER_* / ANTHROPIC_BASE_URL+AUTH_TOKEN
  // are in env, upsert them as a saved provider (and auto-activate when the
  // user is still on the built-in `system` default). Lets a relay's docs page
  // ship a copy-paste snippet that opens Macaron Artifacts fully configured.
  const seedResult = await seedProviderFromEnv();
  if (seedResult.seeded) {
    app.log.info(
      `env-seeded provider ${seedResult.providerId}${seedResult.activated ? ' (activated)' : ' (kept your active choice)'}`,
    );
  }
  await warmWorktreeCache();
  await warmPermissionRulesCache();
  await warmCodexConfigCache();
  await warmKimiConfigCache();
  await warmLabelsCache();
  await warmSchedulesCache();
  await warmCodexTitlesCache();
  await warmShareCache();
  await startSessionWatcher();
  await app.listen({ host: HOST, port: PORT });
  app.log.info(`macaron server listening on http://${HOST}:${PORT}`);
  if (authGenerated) {
    app.log.warn(`API reachable beyond a local peer (non-loopback bind or cross-origin enabled) with no MACARON_AUTH_TOKEN — generated one for this run.`);
    // The token is a live credential — keep it out of the structured log (which may be
    // shipped off-box) and out of any URL (URLs leak via history/referrer/proxy logs).
    // Print the address and the token on separate lines straight to stdout so the operator
    // can grab them from their own terminal and paste the token into the UI's login screen.
    console.log(`connect another device to: http://${HOST}:${PORT}/  ·  access token: ${authToken}`);
  } else if (authToken) {
    app.log.info('server auth enabled (MACARON_AUTH_TOKEN) — remote requests require the token.');
  }
  startScheduler();
  // Pre-warm the render_ui TS check: the first diagnose pays full program construction. Do it now,
  // at boot, instead of mid-turn while an SSE stream is live. The `import "$macaron/ui"` is what
  // makes this warm the expensive half — it pulls source.tsx and its whole vendored tree into the
  // snapshot cache; without an import TS lazily skips them and the first real render_ui still pays
  // ~300ms. checkGenUI never throws (it degrades to an ack on failure), so this can't crash boot.
  setImmediate(() => void checkGenUI('import "$macaron/ui";\nexport default function App() { return null }'));
  // Build the search index in the background so first-boot never blocks on a
  // full ~/.claude/projects walk. Best-effort: a failed sync just leaves the
  // index empty until the next self-refreshing search retries it.
  if (isSearchEnabled()) {
    setImmediate(() => {
      syncAll()
        .then((r) => app.log.info(`search index synced: ${r.changed}/${r.scanned} files`))
        .catch((e) => app.log.warn(`search index sync failed: ${(e as Error).message}`));
    });
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
