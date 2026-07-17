#!/usr/bin/env node
// mcc — Macaron Claude Code WebUI launcher. Starts the prebuilt server and
// serves the bundled web UI. The server bundle (bun build --packages=external)
// leaves every npm dep external; @macaron/shared is types-only, so its
// `import type` usages erase at compile time and it never reaches the bundler.
// Keep it types-only: --packages=external would externalize any runtime code it
// gains into a bare import the published tarball can't resolve.
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);

function printHelp() {
  console.log(`Usage: mcc [options]

  Start the Macaron Claude Code WebUI.

Options:
  --host <host>          Bind address (default: 127.0.0.1)
  --port <port>          Port (default: 7878)
  --allow-origin <url>   Allow a hosted WebUI on this origin to drive the server
                         cross-origin (repeatable; appends to MACARON_ALLOWED_ORIGINS)
  --allow-hosted         Allow the official hosted WebUI (https://artifacts.macaron.im)
  --version, -v          Print version and exit
  --help, -h             Show this help

Enabling any origin arms an access token so the API is never open cross-origin.
Precedence is additive: MACARON_ALLOWED_ORIGINS (env) ∪ every --allow-origin ∪,
if --allow-hosted / MACARON_ALLOW_HOSTED is set, the official origin.

Environment:
  MACARON_ALLOWED_ORIGINS  Comma-separated allowed origins
  MACARON_ALLOW_HOSTED     1/true to include the official hosted origin
  MACARON_API_BASE   Custom provider API endpoint
  MACARON_API_KEY    Custom provider API key
  MACARON_MODEL      Custom provider model id
  MACARON_LOG_LEVEL  Log level (default: info)`);
}

async function printVersion() {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
}

const readValue = (i, flag) => {
  const v = args[i + 1];
  if (v === undefined || v.startsWith('-')) throw new Error(`${flag} requires a value`);
  return v;
};

try {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf('=');
    const flag = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? null : a.slice(eq + 1);
    if (flag === '--help' || flag === '-h') { printHelp(); process.exit(0); }
    if (flag === '--version' || flag === '-v') { await printVersion(); process.exit(0); }
    if (flag === '--allow-hosted') {
      if (inline !== null) throw new Error(`${flag} does not take a value`);
      process.env.MACARON_ALLOW_HOSTED = '1';
      continue;
    }
    if (flag === '--allow-origin') {
      const origin = (inline ?? readValue(i, flag)).trim();
      if (!origin) throw new Error(`${flag} requires a non-empty value`);
      const cur = process.env.MACARON_ALLOWED_ORIGINS;
      process.env.MACARON_ALLOWED_ORIGINS = cur ? `${cur},${origin}` : origin;
      if (inline === null) i++;
      continue;
    }
    if (flag === '--host' || flag === '--port') {
      process.env[flag === '--host' ? 'MACARON_HOST' : 'MACARON_PORT'] = inline ?? readValue(i, flag);
      // Advance past the consumed value only for the space form (inline === null).
      // `--flag=` (inline='') already has its value, so it must NOT skip the next arg.
      if (inline === null) i++;
      continue;
    }
    throw new Error(`Unknown option: ${a}`);
  }

  const port = process.env.MACARON_PORT;
  if (port !== undefined && (!/^\d+$/.test(port) || +port < 1 || +port > 65535)) {
    throw new Error(`Invalid port: ${port}`);
  }
} catch (e) {
  console.error(`mcc: ${e.message}`);
  process.exit(1);
}
process.env.NODE_ENV ??= 'production';

// Relative to this bin file → ../server/dist/index.js (ESM import() resolves
// against import.meta.url, so it works regardless of the caller's cwd).
await import('../server/dist/index.js');
