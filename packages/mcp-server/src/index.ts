#!/usr/bin/env node

// M10 MCP server entrypoint — stdio transport over the Clowder API callbacks.
//
// Source: clowder-architecture-design.md §5.7 (tool set) + clowder-design-
// supplement.md §C3 (run model: this is a CLI subprocess; a tool call → HTTP
// POST to an API callback endpoint authenticated by env-carried invocationId +
// callbackToken) + 补充 E (session tools).
//
// Nine tools over seven callback endpoints (all backed by frozen M8 callbacks):
//   evidence_search / evidence_upsert  (evidence-tools)
//   post_message                       (message-tools)
//   read_file / search_files           (file-tools)
//   list_session_chain / read_session_digest / read_session_events (session-tools)
//   sop_advance_stage                  (sop-tools)
//
// Graceful degradation: the server constructs and starts even WITHOUT callback
// env vars — a tool call then returns a clean error (NO_CONFIG_ERROR) rather
// than crashing (PROJECT_SPEC §M10 verify).
//
// stdio safety: MCP uses STDOUT for the JSON-RPC protocol, so NOTHING may be
// written to stdout outside the protocol. All diagnostics go to STDERR via
// process.stderr.write (never console.* — the repo eslint bans console entirely,
// and stdout in particular would corrupt the protocol stream).

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CallbackClient } from './callback-client.js';
import { buildEvidenceTools } from './tools/evidence-tools.js';
import { buildMessageTools } from './tools/message-tools.js';
import { buildFileTools } from './tools/file-tools.js';
import { buildSessionTools } from './tools/session-tools.js';
import { buildSopTools } from './tools/sop-tools.js';
import type { ToolDef } from './tools/tool-def.js';

/** Server identity advertised to the MCP client. */
const SERVER_INFO = { name: 'clowder-mcp', version: '0.1.0' } as const;

/**
 * Build the full set of tool definitions from a CallbackClient. Pure function
 * (no I/O) — used by both {@link createServer} and the tools/list test.
 */
export function buildAllTools(client: CallbackClient): ToolDef[] {
  return [
    ...buildEvidenceTools(client),
    ...buildMessageTools(client),
    ...buildFileTools(client),
    ...buildSessionTools(client),
    ...buildSopTools(client),
  ];
}

/**
 * Construct an McpServer with every tool registered. Pure construction — it
 * opens no transport and no network listener, so tests can instantiate it,
 * connect an in-memory transport, and inspect tools/list without blocking on
 * stdio. `client` is injectable (a test passes one bound to a stub fetch / env).
 */
export function createServer(client: CallbackClient = new CallbackClient()): McpServer {
  const server = new McpServer(SERVER_INFO);
  for (const def of buildAllTools(client)) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.inputSchema },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const result = await def.handler(args ?? {});
        // Adapt our internal ToolResult into the SDK's CallToolResult shape.
        // Our text-block subset is a structural subset of the SDK's content
        // union; rebuild a fresh object so the index-signatured SDK type is
        // satisfied without weakening our internal type or using `any`.
        return {
          content: result.content.map((block) => ({ type: 'text', text: block.text })),
          ...(result.isError !== undefined ? { isError: result.isError } : {}),
        };
      },
    );
  }
  return server;
}

/** Write a diagnostic line to STDERR (stdout is reserved for the MCP protocol). */
function logStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Start the server over stdio. Only the CLI entrypoint calls this. */
async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  logStderr('[clowder-mcp] starting on stdio');
  await server.connect(transport);
  logStderr('[clowder-mcp] running on stdio');
}

// Run only when executed directly (skip on import so tests never block on stdio).
const isEntryPoint =
  process.argv[1] !== undefined &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isEntryPoint) {
  main().catch((err: unknown) => {
    logStderr(`[clowder-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  });
}
