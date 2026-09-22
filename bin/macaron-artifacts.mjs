#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === '--help' || flag === '-h') { console.log('Usage: macaron-artifacts [--host 127.0.0.1] [--port 43860] [--data-dir PATH] [--password PASSWORD] [--public-origin URL] [--pair]\n\nOne WebUI for Claude Code, Codex, OpenCode v1, OpenCode v2, pi, Hermes and OpenClaw, with UI4A. Requires Node.js 22.19 or newer.\n--host sets MACARON_HOST; listening outside loopback requires MACARON_PASSWORD.\n--password sets MACARON_PASSWORD; --public-origin sets MACARON_PUBLIC_ORIGIN. Command-line options override environment variables.\nCommand-line passwords may appear in shell history and process listings; environment variables are also supported.\nFor HTTPS reverse proxies, set MACARON_PUBLIC_ORIGIN and preserve the Host header.\n--pair enables one-time pairing from the hosted WebUI; SSH port forwarding also works for remote servers.\nClaude Code uses the bundled SDK/native runtime; Codex and OpenCode require native CLIs. The bundled pi SDK uses ~/.pi/agent. Hermes supports a local CLI or external gateway; OpenClaw uses a bundled Gateway Client.\nOverride executables with MACARON_CLAUDE_PATH, MACARON_CODEX_PATH, MACARON_OPENCODE_PATH (v1) or MACARON_OPENCODE_V2_PATH (v2); override pi configuration with PI_CODING_AGENT_DIR.\nMACARON_ALLOWED_ORIGINS accepts a comma-separated pairing origin allowlist.'); process.exit(0); }
  if (flag === '--pair') { process.env.MACARON_PAIR = '1'; continue; }
  const value = args[++i];
  if (!value || value.startsWith('--') || !['--host', '--port', '--data-dir', '--password', '--public-origin'].includes(flag)) { console.error('Invalid option or missing value. Run macaron-artifacts --help for usage.'); process.exit(1); }
  if (flag === '--port' && (!/^\d+$/.test(value) || +value < 1 || +value > 65535)) { console.error('Port must be between 1 and 65535.'); process.exit(1); }
  process.env[{ '--host': 'MACARON_HOST', '--port': 'MACARON_PORT', '--data-dir': 'MACARON_DATA_DIR', '--password': 'MACARON_PASSWORD', '--public-origin': 'MACARON_PUBLIC_ORIGIN' }[flag]] = value;
}
const server = fileURLToPath(new URL('../artifacts/dist/server.js', import.meta.url));
try { await access(server); } catch { console.error('Build the app first with pnpm build.'); process.exit(1); }
const child = spawn(process.execPath, [server], { stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
