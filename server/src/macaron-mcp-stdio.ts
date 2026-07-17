// Standalone stdio MCP server exposing the Macaron `render_ui` tool for
// the Codex CLI. Codex's SDK only accepts external MCP servers via
// `[mcp_servers.macaron]` config that points at a spawnable command —
// there's no in-process hook like Claude's createSdkMcpServer. So we ship
// this file as a Node script; codex-runner.ts injects
// `mcp_servers.macaron.command = "node"`,
// `mcp_servers.macaron.args = [<absolute path to this file>]` per-turn.
//
// The tool description and handler are the SAME as the Claude in-process
// server — see macaron-render-tool.ts for the shared implementation.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  handleRenderUI,
  RENDER_UI_INSTRUCTIONS,
  RENDER_UI_TOOL_DESCRIPTION,
} from './lib/macaron-render-tool.js';

const server = new Server(
  { name: 'macaron', version: '0.2.0' },
  {
    capabilities: { tools: {} },
    instructions: RENDER_UI_INSTRUCTIONS,
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'render_ui',
      description: RENDER_UI_TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            minLength: 20,
            description:
              'A complete TSX module — imports + `export default function App()` — that the host mounts inline.',
          },
          prompt: {
            type: 'string',
            minLength: 20,
            description: 'DEPRECATED alias for `code`. Send TSX under `code` instead; `prompt` is accepted so legacy calls still render.',
          },
        },
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'render_ui') {
    throw new Error(`unknown tool: ${request.params.name}`);
  }
  const args = request.params.arguments as { code?: unknown; prompt?: unknown } | undefined;
  // Canonical field is `code`; `prompt` is a back-compat alias the model
  // occasionally hallucinates. Take whichever is present.
  const src = String((args?.code ?? args?.prompt ?? '') || '').trim();
  if (!src || src.length < 20) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'render_ui failed: `code` is required (TSX module string, ≥20 chars).' }],
    };
  }
  const { text, ok } = await handleRenderUI(src);
  return {
    isError: !ok,
    content: [{ type: 'text', text }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
