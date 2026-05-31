// M10 tool-result — the MCP CallToolResult shape + helpers shared by all tools.
//
// MCP tools return `{ content: [{ type:'text', text }], isError? }`. A successful
// callback's JSON payload is serialized into the text block; a failed callback
// (including the graceful no-config case) becomes an isError result so the MCP
// client sees a clean error instead of a thrown/crashed server.

import type { CallbackResult } from './callback-client.js';

/**
 * The MCP tool result shape (a subset of the SDK's CallToolResult we emit).
 *
 * The arrays/fields are intentionally NOT `readonly` so the value is structurally
 * assignable to the SDK's mutable `CallToolResult` when returned from a tool
 * handler (a `readonly` content array is not assignable to its mutable one).
 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** Build a successful text result from a JSON-serializable payload. */
export function successResult(data: unknown): ToolResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return { content: [{ type: 'text', text }] };
}

/** Build an error result carrying a human-readable message. */
export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Collapse a {@link CallbackResult} into a {@link ToolResult}: the parsed JSON
 * on success, an isError text block on failure. This is the single place every
 * tool turns an HTTP outcome into an MCP result, so behavior is uniform.
 */
export function toToolResult(result: CallbackResult): ToolResult {
  return result.ok ? successResult(result.data) : errorResult(result.error);
}
