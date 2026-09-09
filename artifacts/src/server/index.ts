import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeUIMessageStreamToResponse } from 'ai';
import type { ChatMessage, HarnessId, Session } from '../shared/types.js';
import { adapters } from './harnesses/index.js';
import type { HarnessAdapter } from './harnesses/types.js';
import { SessionStore } from './store.js';
import { ActiveConversation } from './conversations.js';
import { MetadataTasks } from './enrichment.js';
import { listArtifacts, readUi4aFile, writeUi4aFile } from './artifacts.js';
import { ProfileStore, validateProfileInput } from './profiles.js';
import { safeError } from './harnesses/common.js';
import { PairingManager, bearerToken, isLoopbackHost, originHost, originProtocol, type PairingGrant, type PairingOptions } from './pairing.js';

export async function createArtifactsServer(options: { directory: string; instructions: string; harnesses?: Partial<Record<HarnessId, HarnessAdapter>>; profiles?: ProfileStore; webRoot?: string; pairing?: PairingOptions }) {
  const store = new SessionStore(options.directory), active = new Map<string, ActiveConversation>(), claims = new Set<string>();
  const pairing = new PairingManager(options.pairing);
  const profiles = options.profiles ?? new ProfileStore(join(options.directory, 'profiles'));
  const deletingProfiles = new Set<string>(), bindingProfiles = new Map<string, number>();
  // Reserve bindings before resolving async native config, so deletion cannot race a new session or a profile switch.
  const bindProfile = (id: string | null | undefined) => {
    if (id && deletingProfiles.has(id)) throw Object.assign(new Error('Profile 正在删除，请重新选择'), { status: 409 });
    if (id) bindingProfiles.set(id, (bindingProfiles.get(id) ?? 0) + 1);
    return () => { if (id) { const count = (bindingProfiles.get(id) ?? 1) - 1; if (count) bindingProfiles.set(id, count); else bindingProfiles.delete(id); } };
  };
  const optionalText = (value: unknown, name: string) => { if (value == null || value === '') return undefined; if (typeof value !== 'string' || value.length > 500 || /[\0\r\n]/.test(value)) throw new Error(`${name} 格式无效`); return value.trim() || undefined; };
  const metadata = new MetadataTasks(store);
  const harnesses = options.harnesses ?? adapters;
  await Promise.all([store.load(), profiles.load()]);
  const json = (res: ServerResponse, body: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 3 * 1024 * 1024) throw new Error('Request is too large.'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }
  const server = createServer(async (req, res) => {
    try {
    const url = new URL(req.url || '/', 'http://localhost'), segments = url.pathname.split('/').filter(Boolean);
    let grant: PairingGrant | undefined, localRequest = false;
    // Native harnesses can mutate files. A local browser must not let an unrelated origin trigger them.
    if (url.pathname.startsWith('/api/')) {
      const requestHost = req.headers.host;
      if (!isLoopbackHost(requestHost)) return json(res, { error: 'A loopback host is required.' }, 403);
      const origin = req.headers.origin;
      const originHostValue = originHost(origin);
      if (origin && !originHostValue) return json(res, { error: 'Invalid Origin.' }, 400);
      const crossOrigin = Boolean(origin && (originHostValue !== requestHost || originProtocol(origin) !== 'http:'));
      localRequest = !crossOrigin;
      if (crossOrigin && !pairing.enabled) return json(res, { error: 'Cross-origin requests are not accepted.' }, 403);
      if (crossOrigin && !pairing.originAllowed(origin)) return json(res, { error: 'This WebUI origin is not allowed.' }, 403);
      if (crossOrigin) {
        res.setHeader('access-control-allow-origin', origin!); res.setHeader('access-control-expose-headers', 'x-vercel-ai-ui-message-stream'); res.setHeader('vary', 'Origin');
        const pairingRoute = url.pathname === '/api/pair';
        const localOnlyRoute = url.pathname === '/api/pair/code' || url.pathname.startsWith('/api/pair/connections');
        if (localOnlyRoute) return json(res, { error: 'This endpoint is local-only.' }, 403);
        if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': 'authorization, content-type, accept', 'access-control-expose-headers': 'x-vercel-ai-ui-message-stream', 'access-control-max-age': '600', ...(req.headers['access-control-request-private-network'] === 'true' ? { 'access-control-allow-private-network': 'true' } : {}) }); return res.end(); }
        if (url.pathname !== '/api/health' && !pairingRoute && !(grant = pairing.authenticate(bearerToken(req.headers.authorization), origin))) return json(res, { error: 'Pairing authentication required.', authRequired: true }, 401);
      }
    }
      if (url.pathname === '/api/health') return json(res, { ok: true });
      if (url.pathname === '/api/pair' && req.method === 'POST') {
        if (localRequest || !req.headers.origin) return json(res, { error: 'Pairing must be claimed from the hosted WebUI.' }, 403);
        const input = await body(req), result = pairing.claim(typeof input.code === 'string' ? input.code : '', req.headers.origin);
        return json(res, result);
      }
      if (url.pathname === '/api/pair/code' && req.method === 'POST') {
        if (!localRequest) return json(res, { error: 'This endpoint is local-only.' }, 403);
        return json(res, pairing.generateCode());
      }
      if (url.pathname === '/api/connection' && req.method === 'GET') {
        if (!localRequest && !grant) return json(res, { error: 'Pairing authentication required.', authRequired: true }, 401);
        return json(res, grant ? pairing.context(grant) : { id: null, name: 'Local', expiresAt: null, protocolVersion: 1 });
      }
      if (url.pathname === '/api/connection' && req.method === 'DELETE') {
        if (!grant) return json(res, { error: 'Pairing authentication required.', authRequired: true }, 401);
        pairing.revokeCurrent(grant); return json(res, { ok: true });
      }
      if (url.pathname === '/api/pair/connections' && req.method === 'GET') {
        if (!localRequest) return json(res, { error: 'This endpoint is local-only.' }, 403);
        return json(res, pairing.list());
      }
      if (segments[0] === 'api' && segments[1] === 'pair' && segments[2] === 'connections' && segments[3] && req.method === 'DELETE') {
        if (!localRequest) return json(res, { error: 'This endpoint is local-only.' }, 403);
        return json(res, { ok: pairing.revoke(decodeURIComponent(segments[3])) });
      }
      if (url.pathname === '/api/harnesses' && req.method === 'GET') return json(res, await Promise.all(Object.values(harnesses).map(adapter => adapter.info())));
      if (segments[0] === 'api' && segments[1] === 'harnesses' && segments[3] === 'profile-options' && req.method === 'GET') {
        const harness = segments[2] as HarnessId, adapter = Object.hasOwn(harnesses, harness) ? harnesses[harness] : undefined;
        if (!adapter) return json(res, { error: 'Unsupported harness.' }, 400);
        const cwd = await realpath(url.searchParams.get('cwd') || process.cwd());
        const profile = await profiles.resolve(url.searchParams.get('profileId') || undefined, harness, cwd);
        try { return json(res, await adapter.profileOptions?.(cwd, profile) ?? { models: [], efforts: [] }); }
        catch { return json(res, { models: [], efforts: [], error: '暂时无法读取本机选项，可以继续填写自定义模型，或稍后重试。' }); }
      }
      if (segments[0] === 'api' && segments[1] === 'profiles') {
        const id = segments[2] ? decodeURIComponent(segments[2]) : undefined;
        if (!id && req.method === 'GET') return json(res, await profiles.list());
        if ((!id && req.method === 'POST') || (id && req.method === 'PUT')) return json(res, await profiles.save(validateProfileInput(await body(req)), id), id ? 200 : 201);
        if (id && req.method === 'DELETE') {
          const input = await body(req);
          if (deletingProfiles.has(id) || bindingProfiles.has(id) || [...store.sessions.values()].some(session => session.profileId === id)) return json(res, { error: '这个 Profile 仍被会话使用，请先切换这些会话的 Profile。' }, 409);
          deletingProfiles.add(id);
          try { await profiles.remove(id, optionalText(input.revision, 'revision')); return json(res, { ok: true }); }
          finally { deletingProfiles.delete(id); }
        }
      }
      if (url.pathname === '/api/sessions' && req.method === 'GET') return json(res, store.list());
      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        const input = await body(req), harness = input.harness as HarnessId;
        if (!Object.hasOwn(harnesses, harness) || !harnesses[harness]) return json(res, { error: 'Unsupported harness.' }, 400);
        const profileId = optionalText(input.profileId, 'Profile'), release = bindProfile(profileId);
        try {
          const cwd = await realpath(typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd : process.cwd());
          if (!(await stat(cwd)).isDirectory()) return json(res, { error: 'Workspace must be a directory.' }, 400);
          await profiles.resolve(input.profileId === null ? null : profileId, harness, cwd);
          const session: Session = { id: crypto.randomUUID(), harness, cwd, profileId: input.profileId === null ? null : profileId, model: optionalText(input.model, '模型'), title: '新会话', messages: [], suggestions: [], createdAt: Date.now(), updatedAt: Date.now(), status: 'idle' };
          await store.save(session); return json(res, session, 201);
        } finally { release(); }
      }
      if (segments[0] === 'api' && segments[1] === 'sessions' && segments[2]) {
        const session = store.sessions.get(segments[2]);
        if (!session) return json(res, { error: 'Session not found.' }, 404);
        if (segments.length === 3 && req.method === 'GET') return json(res, session);
        if (segments.length === 3 && req.method === 'DELETE') {
          if (claims.has(session.id)) return json(res, { error: 'This session is being updated.' }, 409);
          claims.add(session.id);
          try { const run = active.get(session.id); run?.stop(); await Promise.allSettled([run?.done, metadata.cancel(session.id)]); await store.delete(session.id); return json(res, { ok: true }); }
          finally { claims.delete(session.id); }
        }
        if (segments.length === 3 && req.method === 'PATCH') {
          const input = await body(req), configuration = 'profileId' in input || 'model' in input;
          if (store.sessions.get(session.id) !== session) return json(res, { error: 'Session not found.' }, 404);
          if (claims.has(session.id) || configuration && (active.has(session.id) || session.status === 'running')) return json(res, { error: '请在当前一轮结束后切换会话配置。' }, 409);
          const profileId = 'profileId' in input ? optionalText(input.profileId, 'Profile') ?? null : session.profileId, release = bindProfile(profileId);
          claims.add(session.id);
          try {
            if (configuration) await profiles.resolve(profileId, session.harness, session.cwd);
            void metadata.cancel(session.id);
            const previous = { title: session.title, profileId: session.profileId, model: session.model };
            try {
              if (typeof input.title === 'string' && input.title.trim()) session.title = input.title.trim().slice(0, 100);
              if (configuration) session.profileId = profileId;
              if ('model' in input) session.model = optionalText(input.model, '模型');
              await store.save(session); return json(res, session);
            } catch (error) { Object.assign(session, previous); throw error; }
          }
          finally { claims.delete(session.id); release(); }
        }
        if (segments[3] === 'stop' && req.method === 'POST') {
          const run = active.get(session.id);
          if (run) { run.stop(); await run.done.catch(() => {}); if (active.get(session.id) === run) active.delete(session.id); }
          else void metadata.cancel(session.id);
          return json(res, { ok: true });
        }
        if (segments[3] === 'metadata' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' }); req.socket.setNoDelay(true);
          if (grant) pairing.track(grant, res);
          const unsubscribe = metadata.subscribe(session, { update: recap => res.write(`data: ${JSON.stringify(recap)}\n\n`), close: () => res.end() });
          res.on('close', unsubscribe); return;
        }
        if (segments[3] === 'approvals' && req.method === 'POST') {
          const input = await body(req);
          const decide = active.get(session.id)?.approvals.get(decodeURIComponent(segments[4]));
          if (!decide) return json(res, { error: 'Approval is no longer pending.' }, 409);
          decide(input.approved === true); return json(res, { ok: true });
        }
        if (segments[3] === 'artifacts' && req.method === 'GET') return json(res, await listArtifacts(session.cwd));
        if (segments[3] === 'files') {
          const path = url.searchParams.get('path') ?? '';
          if (req.method === 'GET') { const source = await readUi4aFile(session.cwd, path); res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); return res.end(source); }
          if (req.method === 'PUT') { const input = await body(req); if (typeof input.content !== 'string') return json(res, { error: 'content must be a string.' }, 400); await writeUi4aFile(session.cwd, path, input.content); return json(res, { ok: true }); }
        }
      }
      if (segments[0] === 'api' && segments[1] === 'chat' && segments[3] === 'stream' && req.method === 'GET') {
        const run = active.get(segments[2]);
        if (!run) { res.writeHead(204); return res.end(); }
        if (grant) pairing.track(grant, res);
        req.socket.setNoDelay(true);
        return await pipeUIMessageStreamToResponse({ response: res, stream: run.stream(), headers: { 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } });
      }
      if (url.pathname === '/api/chat' && req.method === 'POST') {
        const input = await body(req), session = store.sessions.get(String(input.id));
        if (!session) return json(res, { error: 'Session not found.' }, 404);
        if (active.has(session.id) || claims.has(session.id)) return json(res, { error: 'This session already has a running turn.' }, 409);
        const adapter = Object.hasOwn(harnesses, session.harness) ? harnesses[session.harness] : undefined;
        if (!adapter) return json(res, { error: 'This harness is unavailable.' }, 400);
        const messages = Array.isArray(input.messages) ? input.messages as ChatMessage[] : [];
        const user = messages.findLast(message => message.role === 'user');
        const prompt = user?.parts?.filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
        if (!user || !prompt) return json(res, { error: 'A user message is required.' }, 400);
        const retry = session.status === 'error' && session.messages.some(message => message.id === user.id);
        if (session.messages.some(message => message.id === user.id) && !retry) return json(res, { error: 'This message was already submitted.' }, 409);
        // Claim before the first await. Two simultaneous POSTs must never both
        // append a user message and start native turns for the same session.
        claims.add(session.id); void metadata.cancel(session.id);
        const previous = { ...session, messages: [...session.messages], suggestions: [...session.suggestions] };
        let run: ActiveConversation;
        try {
          // null records an explicit switch back to native defaults; absent IDs preserve legacy session behavior.
          const profile = await profiles.resolve(session.profileId, session.harness, session.cwd);
          if (!retry) {
            session.messages.push({ id: user.id || crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: prompt }] });
            if (session.messages.length === 1) session.title = prompt.slice(0, 60);
          }
          session.status = 'running'; session.error = undefined; session.suggestions = []; session.updatedAt = Date.now();
          await store.save(session);
          run = new ActiveConversation(store, session, adapter, options.instructions, prompt, metadata, retry, profile); active.set(session.id, run);
        } catch (error) { Object.assign(session, previous); throw error; }
        finally { claims.delete(session.id); }
        void run.done.finally(() => { if (active.get(session.id) === run) active.delete(session.id); }).catch(error => { console.error('Session persistence failed:', error); });
        if (grant) pairing.track(grant, res);
        req.socket.setNoDelay(true);
        return await pipeUIMessageStreamToResponse({ response: res, stream: run.stream(), headers: { 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } });
      }
      if (url.pathname.startsWith('/api/')) return json(res, { error: 'Not found.' }, 404);
      if (!options.webRoot) return json(res, { error: 'Start the Vite UI or build the app first.' }, 404);
      const path = resolve(options.webRoot, `.${url.pathname}`);
      if (path !== resolve(options.webRoot) && !path.startsWith(`${resolve(options.webRoot)}/`)) return json(res, { error: 'Not found.' }, 404);
      const file = extname(path) ? path : join(options.webRoot, 'index.html');
      const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json' };
      res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' }); res.end(await readFile(file));
    } catch (error) { if (!res.headersSent) json(res, { error: safeError(error) }, (error as { status?: number }).status ?? (error as { statusCode?: number }).statusCode ?? ((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 400)); else res.end(); }
  });
  return { server, store, profiles, active, pairing, async close() { for (const run of active.values()) run.stop(); await Promise.allSettled([...active.values()].map(run => run.done)); await metadata.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), import.meta.url.endsWith('/src/server/index.ts') ? '../..' : '..');
  const instructions = await readFile(join(root, 'skills/ui4a/SKILL.md'), 'utf8');
  const pairing = /^(1|true|yes)$/i.test(process.env.MACARON_PAIR || '') ? { enabled: true, allowedOrigins: (process.env.MACARON_ALLOWED_ORIGINS || 'https://artifacts.macaron.im').split(',').map(value => value.trim()).filter(Boolean) } : undefined;
  const app = await createArtifactsServer({ directory: process.env.MACARON_DATA_DIR || join(homedir(), '.macaron-artifacts/sessions'), instructions, webRoot: join(root, 'dist/web'), pairing });
  const port = Number(process.env.MACARON_PORT || 43860);
  app.server.listen(port, '127.0.0.1', () => {
    console.log(`Macaron Artifacts: http://127.0.0.1:${port}`);
    if (app.pairing.enabled) {
      console.log(`Connect: https://artifacts.macaron.im/connect?server=${encodeURIComponent(`http://127.0.0.1:${port}`)}`);
      console.log(`Pairing code: ${app.pairing.code} (expires ${new Date(app.pairing.codeExpiry).toISOString()})`);
      if (process.env.SSH_CONNECTION) console.log(`SSH port forward: ssh -N -L ${port}:127.0.0.1:${port} <user>@<host>`);
      console.log(`To generate a new code locally: curl -X POST http://127.0.0.1:${port}/api/pair/code`);
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void app.close().then(() => process.exit()); });
}
