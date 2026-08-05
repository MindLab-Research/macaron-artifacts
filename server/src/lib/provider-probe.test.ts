import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { probeProvider } from './provider-probe.js';

// Boots a throwaway HTTP server that answers whatever the case needs, so the
// probe's classification logic is exercised without touching a real provider.
async function withServer(
  handler: http.RequestListener,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('reports ok on a well-formed message response', async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.url, '/v1/messages');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', model: 'test-model', content: [] }));
    },
    async (base) => {
      const r = await probeProvider({ endpoint: base, model: 'test-model', apiKey: 'k' });
      assert.equal(r.ok, true);
      assert.equal(r.url, `${base}/v1/messages`);
      assert.match(r.detail!, /test-model/);
    },
  );
});

test('flags an SPA index.html served with HTTP 200', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html></html>');
    },
    async (base) => {
      const r = await probeProvider({ endpoint: base, model: 'm', apiKey: 'k' });
      assert.equal(r.ok, false);
      assert.match(r.detail!, /web page/);
    },
  );
});

test('names an auth failure', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'nope' }));
    },
    async (base) => {
      const r = await probeProvider({ endpoint: base, model: 'm', apiKey: 'bad' });
      assert.equal(r.ok, false);
      assert.equal(r.status, 401);
      assert.match(r.detail!, /API key rejected/);
    },
  );
});

test('surfaces an unreachable endpoint', async () => {
  const r = await probeProvider({ endpoint: 'http://127.0.0.1:1', model: 'm', apiKey: 'k' });
  assert.equal(r.ok, false);
  assert.match(r.detail!, /could not reach/);
});
