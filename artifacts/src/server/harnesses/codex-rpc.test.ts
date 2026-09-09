import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRpc } from './codex-rpc.js';

test('stdio RPC decodes split UTF-8 frames and answers server requests with the native result envelope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'artifacts-codex-rpc-')), binary = join(directory, 'codex-fixture');
  await writeFile(binary, `#!/usr/bin/env node
const readline = require('node:readline');
const send = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize') {
    send({ id: frame.id, result: { ready: true } });
    send({ id: 'native-approval', method: 'item/commandExecution/requestApproval', params: { command: 'echo test' } });
  } else if (frame.id === 'native-approval') {
    const result = Buffer.from(JSON.stringify({ method: 'verified', params: { frame, unicode: '你好' } }) + '\\n');
    const split = result.indexOf(Buffer.from('你好')) + 1;
    process.stdout.write(result.subarray(0, split));
    setImmediate(() => process.stdout.write(result.subarray(split)));
  }
});
`, { mode: 0o755 });
  const client = new CodexRpc(binary);
  try {
    const received = new Promise<unknown>((resolve, reject) => {
      client.notification = (method, params) => { if (method === 'verified') resolve(params); };
      client.failure = reject;
    });
    client.serverRequest = async (method, params) => {
      expect(method).toBe('item/commandExecution/requestApproval'); expect(params).toEqual({ command: 'echo test' });
      return { decision: 'decline' };
    };
    expect(await client.request('initialize', {})).toEqual({ ready: true });
    expect(await received).toEqual({ frame: { id: 'native-approval', result: { decision: 'decline' } }, unicode: '你好' });
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a missing executable rejects pending initialization and still closes', async () => {
  const client = new CodexRpc('/nonexistent/macaron-codex-fixture');
  try { await expect(client.request('initialize', {})).rejects.toThrow(); }
  finally { await client.close(); }
});
