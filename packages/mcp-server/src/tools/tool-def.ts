// M10 tool-def — the common shape of a registrable MCP tool.
//
// Each tools/*.ts file exports an array of ToolDef; index.ts iterates them and
// calls McpServer.registerTool(name, { description, inputSchema }, handler). The
// handler is built from the injected CallbackClient so tools have no global
// state and are unit-testable in isolation.

import type { ZodRawShape } from 'zod';
import type { CallbackClient } from '../callback-client.js';
import type { ToolResult } from '../tool-result.js';

/**
 * One MCP tool definition. `inputSchema` is a zod raw shape (a plain map of
 * field → ZodType) per the MCP SDK's registerTool contract; the SDK builds the
 * JSON Schema and validates input before the handler runs.
 */
export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodRawShape;
  /** Run the tool against `args` (already validated by the SDK). */
  readonly handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

/** A factory that builds a tool group's defs from the shared CallbackClient. */
export type ToolGroupFactory = (client: CallbackClient) => ToolDef[];
