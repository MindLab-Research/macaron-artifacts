#!/usr/bin/env node
// mcc — Macaron Claude Code WebUI launcher. Starts the prebuilt server and
// serves the bundled web UI. The server bundle (bun build --packages=external)
// leaves every npm dep external; @macaron/shared is types-only, so its
// `import type` usages erase at compile time and it never reaches the bundler.
// Keep it types-only: --packages=external would externalize any runtime code it
// gains into a bare import the published tarball can't resolve.
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);

function printHelp() {
  console.log(`Usage: mcc [options]

  Start the Macaron Claude Code WebUI.

Options:
  --host <host>          Bind address (default: 127.0.0.1)
  --port <port>          Port (default: 7878)
  --model <model>        Default model for new sessions (sets ANTHROPIC_MODEL)
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

const readValue = (argv, i, flag) => {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('-')) throw new Error(`${flag} requires a value`);
  return v;
};

// Parse argv into process.env mutations (MACARON_* / ANTHROPIC_MODEL). Exported
// so a launcher-to-boot integration test can drive the real parse in-process,
// then warm the settings store against the resulting env. Throws on bad input;
// --help/--version short-circuit via the onExit callback (process.exit in CLI).
export async function parseArgs(argv, onExit = (code) => process.exit(code)) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const flag = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? null : a.slice(eq + 1);
    if (flag === '--help' || flag === '-h') { printHelp(); return onExit(0); }
    if (flag === '--version' || flag === '-v') { await printVersion(); return onExit(0); }
    if (flag === '--allow-hosted') {
      if (inline !== null) throw new Error(`${flag} does not take a value`);
      process.env.MACARON_ALLOW_HOSTED = '1';
      continue;
    }
    if (flag === '--allow-origin') {
      const origin = (inline ?? readValue(argv, i, flag)).trim();
      if (!origin) throw new Error(`${flag} requires a non-empty value`);
      const cur = process.env.MACARON_ALLOWED_ORIGINS;
      process.env.MACARON_ALLOWED_ORIGINS = cur ? `${cur},${origin}` : origin;
      if (inline === null) i++;
      continue;
    }
    if (flag === '--host' || flag === '--port') {
      process.env[flag === '--host' ? 'MACARON_HOST' : 'MACARON_PORT'] = inline ?? readValue(argv, i, flag);
      // Advance past the consumed value only for the space form (inline === null).
      // `--flag=` (inline='') already has its value, so it must NOT skip the next arg.
      if (inline === null) i++;
      continue;
    }
    if (flag === '--model') {
      const model = (inline ?? readValue(argv, i, flag)).trim();
      if (!model) throw new Error(`${flag} requires a non-empty value`);
      process.env.ANTHROPIC_MODEL = model;
      if (inline === null) i++;
      continue;
    }
    throw new Error(`Unknown option: ${a}`);
  }

  const port = process.env.MACARON_PORT;
  if (port !== undefined && (!/^\d+$/.test(port) || +port < 1 || +port > 65535)) {
    throw new Error(`Invalid port: ${port}`);
  }
}

// Only parse + boot the server when run as the CLI, not when imported by a test.
// Package managers expose the bin as a symlink (node_modules/.bin/mcc), so
// process.argv[1] is the symlink path while import.meta.url is realpath-resolved
// — resolve both through realpath before comparing, or the installed bin no-ops.
function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    await parseArgs(args);
  } catch (e) {
    console.error(`mcc: ${e.message}`);
    process.exit(1);
  }
  process.env.NODE_ENV ??= 'production';

  // Relative to this bin file → ../server/dist/index.js (ESM import() resolves
  // against import.meta.url, so it works regardless of the caller's cwd).
  await import('../server/dist/index.js');
}
