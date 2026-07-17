#!/usr/bin/env node
// mkx — Macaron Kimi Code WebUI launcher. Boots the same server as mcc but serves
// the kimi SPA (kimi.html) at `/` instead of the claude SPA. Shipped as its
// own self-contained package (own server/dist + web/dist + deps) so
// `npx mkx@…` installs only mkx — no mcc, no shared runtime.
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);

function printHelp() {
  console.log(`Usage: mkx [options]

  Start the Macaron Kimi Code WebUI (ChatGPT-style chat over the Kimi Code CLI).

Options:
  --host <host>     Bind address (default: 127.0.0.1)
  --port <port>     Port (default: 7980 — offset from mcc's 7878 so both can run)
  --version, -v     Print version and exit
  --help, -h        Show this help

Environment:
  MACARON_KIMI_PATH    Path to kimi CLI binary (default: auto-detected)
  MACARON_LOG_LEVEL    Log level (default: info)

Configure the provider (base URL, API key, model, provider type) via the
Settings page in the WebUI. Settings persist to
~/.kimi-code/macaron-kimi-config.json.`);
}

async function printVersion() {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
}

const readValue = (i, flag) => {
  const v = args[i + 1];
  // Reject only a missing or flag-like next token; an empty value passes here
  // (matching `--flag=`) and, for --port, is caught by the range check below.
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
  console.error(`mkx: ${e.message}`);
  process.exit(1);
}

// The one env flag that flips the SPA served at `/` from index.html to kimi.html.
process.env.MACARON_ENGINE = 'kimi';
// Kimi-side default port is 7980 (mcc uses 7878, mcx 7979) so all can run at once.
process.env.MACARON_PORT ??= '7980';
process.env.NODE_ENV ??= 'production';

// Relative to this bin file → ../server/dist/index.js (ESM import() resolves
// against import.meta.url, so it works regardless of the caller's cwd).
await import('../server/dist/index.js');
