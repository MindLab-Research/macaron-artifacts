import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Default: exercise the real prepack hook. Set MACARON_PACKAGE_SOURCE to a .tgz
// path or published package URL to run exactly the same checks against that artifact.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageName = 'macaron-artifacts';
const redact = text => text.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]').replace(/\bsk-[\w-]+/g, '[redacted]');

function run(command, args, cwd, env = process.env, timeout = 120_000) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const append = chunk => { output = (output + chunk.toString()).slice(-24_000); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const timer = setTimeout(() => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Already exited. */ } }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolveRun(output);
      else reject(new Error(`${command} ${args[0]} failed (${signal || code}):\n${redact(output)}`));
    });
  });
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  const port = server.address().port;
  await new Promise((closed, reject) => server.close(error => error ? reject(error) : closed()));
  return port;
}

async function start(bin, consumer, env, dataDirectory) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const port = await reservePort(), base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [bin, '--port', String(port), '--data-dir', dataDirectory], { cwd: consumer, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', exited = false, spawnError;
    const append = chunk => { output = (output + chunk.toString()).slice(-12_000); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.once('error', error => { spawnError = error; });
    const closed = new Promise(resolveClose => child.once('close', () => { exited = true; resolveClose(); }));
    const kill = signal => {
      if (exited) return;
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ }
    };
    const stop = async () => {
      kill('SIGTERM');
      const timer = setTimeout(() => kill('SIGKILL'), 2000);
      try { await closed; } finally { clearTimeout(timer); }
    };
    try {
      const deadline = Date.now() + 20_000;
      while (!exited && !spawnError && Date.now() < deadline) {
        const health = output.includes(base) ? await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) }).catch(() => undefined) : undefined;
        if (health?.ok && (await health.json()).ok === true) return { base, stop };
        await delay(50);
      }
      throw spawnError || new Error(`Installed launcher did not become healthy:\n${redact(output)}`);
    } catch (error) {
      await stop();
      if (!/EADDRINUSE/.test(output) || attempt === 3) throw error;
    }
  }
  throw new Error('Could not allocate a test server port');
}

async function files(directory, prefix = '') {
  const paths = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) paths.push(...await files(directory, path));
    else paths.push(path.split(sep).join('/'));
  }
  return paths;
}

test('the single published package installs in isolation and serves four harnesses and all client assets', { timeout: 300_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'macaron-package-'));
  let app;
  t.after(async () => { try { await app?.stop(); } finally { await rm(temporary, { recursive: true, force: true }); } });
  const consumer = join(temporary, 'consumer'), packed = join(temporary, 'packed');
  await mkdir(consumer); await mkdir(packed);
  let source = process.env.MACARON_PACKAGE_SOURCE;
  if (!source) {
    // npm runs prepack through its lifecycle shell, avoiding direct spawnSync of a
    // shebang-less pnpm launcher on macOS. No prebuilt workspace staging or script skips.
    await run('npm', ['pack', '--ignore-scripts=false', '--pack-destination', packed], root, process.env, 180_000);
    const tarballs = (await readdir(packed)).filter(name => name.endsWith('.tgz'));
    assert.equal(tarballs.length, 1, 'Exactly one root package must be produced');
    source = join(packed, tarballs[0]);
  } else if (!/^https:\/\//.test(source)) {
    source = resolve(root, source);
    assert.ok(source.endsWith('.tgz'), 'MACARON_PACKAGE_SOURCE must be an HTTPS package URL or .tgz path');
    await access(source);
  }
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'artifacts-package-consumer', private: true }));
  const env = { ...process.env };
  delete env.NODE_PATH; delete env.NODE_OPTIONS;
  env.PI_CODING_AGENT_DIR = join(temporary, 'pi-agent');
  await mkdir(env.PI_CODING_AGENT_DIR);
  await run('npm', ['install', source, '--omit=dev', '--ignore-scripts=false', '--no-audit', '--no-fund', '--prefer-offline'], consumer, env);
  const installed = join(consumer, 'node_modules', packageName), manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.name, packageName);
  assert.equal(manifest.engines.node, '>=22.19');
  assert.deepEqual(Object.keys(manifest.bin), [packageName], 'Legacy launcher names must not be distributed');
  assert.equal(manifest.bin[packageName].replace(/^\.\//, ''), 'bin/macaron-artifacts.mjs');
  for (const dependency of ['@anthropic-ai/claude-agent-sdk', '@opencode-ai/sdk', '@earendil-works/pi-coding-agent', 'ai', 'partial-json']) assert.ok(manifest.dependencies[dependency], `${dependency} must be a runtime dependency`);
  for (const legacy of ['fastify', '@fastify/static', 'node-pty', '@openai/codex-sdk', '@agentclientprotocol/sdk', '@genui/diagnostics']) assert.equal(manifest.dependencies[legacy], undefined, `${legacy} belongs to a retired application`);
  for (const [name, version] of Object.entries(manifest.dependencies)) assert.ok(!/^(?:workspace:|link:|file:)/.test(version), `${name} must resolve outside this workspace`);
  await run(process.execPath, ['--input-type=module', '--eval', "import assert from 'node:assert/strict'; const ai = await import('ai'), json = await import('partial-json'), claude = await import('@anthropic-ai/claude-agent-sdk'), opencode = await import('@opencode-ai/sdk/v2/client'), pi = await import('@earendil-works/pi-coding-agent'); assert.equal(typeof ai.createUIMessageStream, 'function'); assert.equal(typeof json.parse, 'function'); assert.equal(typeof claude.query, 'function'); assert.equal(typeof opencode.createOpencodeClient, 'function'); assert.equal(typeof pi.createAgentSession, 'function'); assert.equal(typeof pi.SessionManager.inMemory, 'function'); assert.equal(pi.getAgentDir(), process.env.PI_CODING_AGENT_DIR); assert.ok(pi.VERSION);"], consumer, env);
  const contents = await files(installed);
  assert.ok(contents.includes('artifacts/dist/server.js'));
  assert.ok(contents.includes('artifacts/dist/web/index.html'));
  for (const path of contents) assert.ok(/^(?:package\.json$|README(?:\.md)?$|LICEN[CS]E(?:\.[^/]*)?$|bin\/macaron-artifacts\.mjs$|artifacts\/README\.md$|artifacts\/(?:dist|skills)\/|node_modules\/)/i.test(path), `Unexpected distributed file: ${path}`);
  const bin = join(consumer, 'node_modules', '.bin', packageName);
  assert.equal(await realpath(bin), join(await realpath(installed), 'bin', 'macaron-artifacts.mjs'));
  for (const legacy of ['mcc', 'mcx', 'mkx']) await assert.rejects(access(join(consumer, 'node_modules', '.bin', legacy)), { code: 'ENOENT' });
  const help = await run(process.execPath, [bin, '--help'], consumer, env);
  assert.match(help, /Usage: macaron-artifacts/); assert.match(help, /Claude Code.*Codex.*OpenCode.*pi/);

  // CLI availability uses --version stubs; pi availability only imports its bundled
  // SDK. Creating app sessions below does not start a native turn or call a provider.
  const cli = join(temporary, 'native-version-stub');
  await writeFile(cli, `#!${process.execPath}\nif (process.argv.length !== 3 || process.argv[2] !== '--version') process.exit(91);\nconsole.log('package-smoke-native 1.0.0');\n`, { mode: 0o755 });
  env.MACARON_CLAUDE_PATH = cli; env.MACARON_CODEX_PATH = cli; env.MACARON_OPENCODE_PATH = cli;
  const guidance = await readFile(join(installed, 'artifacts/skills/ui4a/SKILL.md'), 'utf8');
  assert.match(guidance, /ui4a\/tsx/); assert.match(guidance, /\$ui4a\/ui/); assert.match(guidance, /\.artifacts\//);
  app = await start(bin, consumer, env, join(temporary, 'sessions'));
  const harnesses = await (await fetch(`${app.base}/api/harnesses`)).json();
  assert.deepEqual(harnesses.map(item => item.id).sort(), ['claude-code', 'codex', 'opencode', 'pi']);
  for (const harness of harnesses) {
    assert.equal(harness.available, true, `${harness.id} must be available from its CLI stub or bundled SDK`);
    assert.match(harness.detail, harness.id === 'pi' ? /^pi SDK \S+/ : /package-smoke-native/);
    const response = await fetch(`${app.base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ harness: harness.id, cwd: consumer }) });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).harness, harness.id);
  }
  const home = await fetch(app.base), html = await home.text();
  assert.equal(home.status, 200); assert.match(home.headers.get('content-type'), /text\/html/);
  assert.match(html, /<script[^>]+type="module"/); assert.match(html, /\/assets\/[^"\s]+\.js/);
  const web = join(installed, 'artifacts/dist/web'), assets = await files(web);
  assert.ok(assets.some(path => path.endsWith('.js'))); assert.ok(assets.some(path => path.endsWith('.css'))); assert.ok(assets.some(path => path.endsWith('.wasm')));
  // Checking bytes detects an SPA fallback pretending to serve a missing JS or WASM chunk.
  for (let index = 0; index < assets.length; index += 8) await Promise.all(assets.slice(index, index + 8).map(async path => {
    const response = await fetch(`${app.base}/${path}`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200, path);
    const expected = createHash('sha256').update(await readFile(join(web, path))).digest('hex');
    const actual = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
    assert.equal(actual, expected, `${path} must be served intact from the installed package`);
  }));
  t.diagnostic(`Verified ${packageName}: isolated install, one launcher, four harnesses, OpenCode and pi SDK imports, bundled pi availability, packaged guidance, ${assets.length} client files`);
});
