import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const MIME = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.wasm', 'application/wasm'],
  ['.woff2', 'font/woff2'],
]);

function sendJson(response, value, status = 200) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function openEventStream(response) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  response.write(': replay connected\n\n');
}

function writeEvent(response, event) {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function createReplayServer({ expanded, webRoot }) {
  const { fixture, schedule } = expanded;
  const workspace = fixture.workspace;
  const liveClients = new Set();
  const systemClients = new Set();
  let cursor = 0;
  let currentTime = -Number.EPSILON;

  const session = {
    kind: 'claude',
    project: workspace.project,
    cwd: workspace.cwd,
    gitBranch: workspace.gitBranch,
    sessionId: workspace.sessionId,
    preview: fixture.prompt || workspace.title,
    title: workspace.title,
    messageCount: 0,
    mtime: workspace.startedAt,
    resumeCommand: `claude --resume ${workspace.sessionId}`,
  };
  const workspaceSummary = {
    project: workspace.project,
    cwd: workspace.cwd,
    name: workspace.name,
    sessionCount: 1,
    lastActivity: workspace.startedAt,
    lastSessionId: workspace.sessionId,
    lastPreview: session.preview,
  };

  function serveApi(request, response, pathname) {
    if (pathname === '/api/auth/status') return sendJson(response, { required: false });
    if (pathname === '/api/health') return sendJson(response, { ok: true, model: 'claude-sonnet-4-5', version: 'replay' });
    if (pathname === '/api/usage') {
      return sendJson(response, { available: false, fiveHour: null, sevenDay: null });
    }
    if (pathname === '/api/settings') {
      return sendJson(response, {
        activeProviderId: 'system',
        builtins: [{
          id: 'system',
          name: 'System default',
          description: 'Uses the production Macaron session runtime.',
          detectedEndpoint: null,
        }],
        customProviders: [],
        defaultPermissionMode: 'default',
        followupSuggestions: false,
      });
    }
    if (pathname === '/api/workspaces') return sendJson(response, { workspaces: [workspaceSummary] });
    if (pathname === `/api/workspaces/${encodeURIComponent(workspace.project)}`) {
      return sendJson(response, { workspace: workspaceSummary, sessions: [session] });
    }
    if (pathname === '/api/worktrees') return sendJson(response, { worktrees: [] });
    if (pathname === `/api/sessions/claude/${encodeURIComponent(workspace.project)}/commands`) {
      return sendJson(response, { commands: [] });
    }
    if (pathname === `/api/sessions/claude/${encodeURIComponent(workspace.project)}/${encodeURIComponent(workspace.sessionId)}`) {
      return sendJson(response, {
        kind: 'claude',
        sessionId: workspace.sessionId,
        project: workspace.project,
        cwd: workspace.cwd,
        gitBranch: workspace.gitBranch,
        title: workspace.title,
        messages: [],
      });
    }
    if (pathname === '/api/events') {
      openEventStream(response);
      systemClients.add(response);
      request.on('close', () => systemClients.delete(response));
      return;
    }
    if (pathname === `/api/sessions/claude/${encodeURIComponent(workspace.project)}/${encodeURIComponent(workspace.sessionId)}/live`) {
      openEventStream(response);
      liveClients.add(response);
      for (let index = 0; index < cursor; index += 1) writeEvent(response, schedule[index].event);
      request.on('close', () => liveClients.delete(response));
      return;
    }
    sendJson(response, { error: `Replay endpoint not implemented: ${pathname}` }, 404);
  }

  function serveStatic(response, pathname) {
    if (!webRoot) {
      response.writeHead(404);
      response.end('No web root');
      return;
    }
    const root = path.resolve(webRoot);
    const requested = pathname === '/' ? '/index.html' : pathname;
    let file = path.resolve(root, `.${decodeURIComponent(requested)}`);
    if (!file.startsWith(`${root}${path.sep}`) && file !== root) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(root, 'index.html');
    const extension = path.extname(file).toLowerCase();
    response.writeHead(200, {
      'Content-Type': MIME.get(extension) || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(response);
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) serveApi(request, response, url.pathname);
    else serveStatic(response, url.pathname);
  });

  return {
    fixture,
    schedule,
    async listen(port = 0) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Replay server did not expose a TCP port');
      return `http://127.0.0.1:${address.port}`;
    },
    advance(time) {
      if (time < currentTime) throw new Error(`Replay time cannot move backwards (${time} < ${currentTime})`);
      currentTime = time;
      const emitted = [];
      while (cursor < schedule.length && schedule[cursor].at <= time) {
        const item = schedule[cursor++];
        emitted.push(item);
        for (const response of liveClients) writeEvent(response, item.event);
      }
      return emitted;
    },
    waitForLiveClient(timeoutMs = 10_000) {
      if (liveClients.size > 0) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (liveClients.size > 0) {
            clearInterval(timer);
            resolve();
          } else if (Date.now() - started >= timeoutMs) {
            clearInterval(timer);
            reject(new Error('Timed out waiting for the production Session live SSE connection'));
          }
        }, 20);
      });
    },
    async close() {
      for (const response of liveClients) response.end();
      for (const response of systemClients) response.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
