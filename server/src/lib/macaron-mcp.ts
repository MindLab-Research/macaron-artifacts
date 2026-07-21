// MCP server is just the transport bridge. Claude Agent SDK only accepts
// custom tools via MCP — there's no raw-tool API — so we wrap a `render_ui`
// tool whose `code` field carries a Claude-authored TSX module. The server
// streams the tool_input_delta back to the WebUI as it's typed (see
// claude-runner.ts), and the handler runs TS diagnostics over the final TSX,
// feeding { ok, diagnostics? } back as the tool_result so bad renders self-correct.
// We do NOT call any external "generator" model — the Claude in this session
// writes the TSX directly using $macaron/ui, taught via the tool description below.

import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  handleRenderUI,
  RENDER_UI_INSTRUCTIONS,
  RENDER_UI_TOOL_DESCRIPTION,
} from './macaron-render-tool.js';

// Built lazily via getMacaronMcpServer() so `@anthropic-ai/claude-agent-sdk` is
// only imported when a Claude run actually starts. Keeping the createSdkMcpServer
// call out of module top-level is what lets the codex (mcx) and kimi (mkx)
// launchers boot the shared bundle without the Claude SDK installed.
let cached: McpSdkServerConfigWithInstance | null = null;

export async function getMacaronMcpServer(): Promise<McpSdkServerConfigWithInstance> {
  if (cached) return cached;
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
  cached = createSdkMcpServer({
  name: 'macaron',
  version: '0.2.0',
  instructions: RENDER_UI_INSTRUCTIONS,
  alwaysLoad: true,
  tools: [
    tool(
      'render_ui',
      RENDER_UI_TOOL_DESCRIPTION,
      {
        // Canonical field is `code`. `prompt` is a back-compat alias the model
        // sometimes hallucinates (probably from render-ui-as-a-prompt phrasing
        // in older schemas / other tools). Both accepted; handler picks
        // whichever is present so a mis-named call still renders.
        code: z
          .string()
          .min(20)
          .describe('A complete TSX module — imports + `export default function App()` — that the host mounts inline.')
          .optional(),
        prompt: z
          .string()
          .min(20)
          .describe('DEPRECATED alias for `code` — send TSX under `code` instead. Kept working for legacy calls.')
          .optional(),
      },
      async ({ code, prompt }) => {
        const src = (code ?? prompt ?? '').trim();
        if (!src) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: 'render_ui failed: `code` is required (TSX module string).' }],
          };
        }
        // The route layer streams partial code to the client from Claude's
        // input_json_delta events, so the user already sees the rendered UI by
        // the time this handler runs. What we add here is diagnostics: run TS
        // shared lint + semantic checks and feed { ok, diagnostics? } back to
        // Claude as the tool_result, so a bad render
        // (wrong props, missing exports, type errors) can self-correct in-turn.
        const { text, ok } = await handleRenderUI(src);
        return { isError: !ok, content: [{ type: 'text' as const, text }] };
      },
      // Keep render_ui visible in the first prompt even when Claude defers MCP
      // tools behind tool search. The server-level alwaysLoad covers any
      // future Macaron tools; this keeps the core bridge explicit.
      { alwaysLoad: true },
    ),
  ],
  });
  return cached;
}
