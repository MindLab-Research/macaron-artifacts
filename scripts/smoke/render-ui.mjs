// Prompt-surface smoke test: given ONLY our real surfaces (MCP server
// instructions + render_ui tool description + the ask-via-ui skill in the
// sandbox's .claude/) and one user-shaped message, does the model actually CALL
// render_ui, and is the TSX it writes built against our API?
//
// This is the check that caught the 2048-char MCP truncation: every unit test
// passed while the model, in a live run, asked "want me to commit?" in prose
// because the (COMMIT) trigger sat past the cut. Pipe the emitted TSX into
// scripts/smoke/clickable.mjs to also prove the result is clickable.
//
// Usage: node scripts/smoke/render-ui.mjs --cwd <sandbox> [--out <file.tsx>] "<user message>"
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { getMacaronMcpServer } = await import(path.join(repoRoot, 'server/dist/lib/macaron-mcp.js'));

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const cwd = flag('--cwd');
const outFile = flag('--out');
const prompt = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')).join(' ');
if (!cwd || !prompt) {
  console.error('usage: node scripts/smoke/render-ui.mjs --cwd <sandbox> [--out <file.tsx>] "<user message>"');
  process.exit(2);
}

// A run given "stop asking me about commits" once took that as license to edit
// the HOST's real ~/.claude config. Pin the config dir into the sandbox so the
// nested CLI can't reach the host's own setup. The write tools stay ENABLED on
// purpose: a model that believes it cannot act reports that in prose instead of
// rendering a gate, which silently defeats the whole test.
process.env.CLAUDE_CONFIG_DIR = path.join(cwd, '.cfg');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

const stream = query({
  prompt,
  options: {
    cwd,
    model: process.env.ANTHROPIC_MODEL,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    mcpServers: { macaron: await getMacaronMcpServer() },
    // No allowedTools: it is an exclusive allowlist, so pinning render_ui alone
    // leaves the model without Read/Bash — it then reports "I'm in read-only
    // mode" in prose and never reaches the point of asking to commit.
    // AskUserQuestion IS disabled in production too (that's the skill's premise),
    // so leaving it on here would let the model dodge render_ui.
    disallowedTools: ['AskUserQuestion'],
    settingSources: ['project'],
  },
});

let text = '';
const renders = [];
const trace = [];
for await (const msg of stream) {
  if (msg.type === 'user') {
    for (const block of msg.message.content ?? []) {
      if (block.type === 'tool_result') trace.push(`  ← ${JSON.stringify(block.content).slice(0, 160)}`);
    }
  }
  if (msg.type !== 'assistant') continue;
  for (const block of msg.message.content ?? []) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'tool_use') {
      trace.push(`  → ${block.name} ${JSON.stringify(block.input).slice(0, 120)}`);
      if (block.name === 'mcp__macaron__render_ui') renders.push(block.input.code ?? '');
    }
  }
}
if (process.env.SMOKE_TRACE) console.log(['--- tool trace ---', ...trace].join('\n'));

console.log(`renders=${renders.length}`);
console.log('--- assistant text ---');
console.log(text.slice(0, 800));
renders.forEach((code, i) => {
  console.log(`--- render #${i + 1} ---`);
  console.log(code);
  if (outFile) fs.writeFileSync(i === 0 ? outFile : `${outFile}.${i + 1}`, code);
});
process.exit(renders.length > 0 ? 0 : 1);
