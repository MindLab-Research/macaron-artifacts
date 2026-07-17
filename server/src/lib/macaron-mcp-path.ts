// Absolute path + command for the standalone stdio MCP server that exposes
// render_ui (see server/src/macaron-mcp-stdio.ts). Resolved relative to THIS
// file so the same lookup works whether the server runs from src/ (tsx dev)
// or dist/ (built). Shared by codex-runner and kimi-runner so both inject the
// identical Macaron MCP bridge.
//
// Production: `server/dist/lib/*.js` → sibling `server/dist/macaron-mcp-stdio.js`
//   → spawn `node <path>`.
// Dev: `server/src/lib/*.ts` → sibling `server/src/macaron-mcp-stdio.ts`
//   → spawn `tsx <path>` (via node_modules/.bin/tsx so we don't need a global tsx).

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { command: MACARON_MCP_CMD, args: MACARON_MCP_ARGS } = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const jsPath = path.join(here, '..', 'macaron-mcp-stdio.js');
  if (existsSync(jsPath)) {
    return { command: 'node', args: [jsPath] };
  }
  const tsPath = path.join(here, '..', 'macaron-mcp-stdio.ts');
  // Walk up until we find a runnable tsx binary. Under pnpm, dev bins
  // are NOT hoisted to `<repo>/node_modules/.bin/`; they live under
  // `<repo>/node_modules/.pnpm/node_modules/.bin/`. Also check the
  // classic hoisted path for npm/yarn / server workspace bin.
  let dir = here;
  for (let i = 0; i < 6; i++) {
    for (const rel of [
      ['node_modules', '.bin', 'tsx'],
      ['node_modules', '.pnpm', 'node_modules', '.bin', 'tsx'],
    ]) {
      const candidate = path.join(dir, ...rel);
      if (existsSync(candidate)) return { command: candidate, args: [tsPath] };
    }
    dir = path.dirname(dir);
  }
  // Last resort: hope `tsx` is on PATH.
  return { command: 'tsx', args: [tsPath] };
})();

export { MACARON_MCP_CMD, MACARON_MCP_ARGS };
