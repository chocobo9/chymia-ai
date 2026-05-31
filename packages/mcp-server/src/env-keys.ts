// M10 env-keys — the callback env-var names the CLI sets for this subprocess.
//
// Source: clowder-design-supplement.md §C3 + the FROZEN M8 contract
// (.harness/progress.md): app-factory's CALLBACK_ENV_KEYS exposes these neutral
// CLOWDER_* names (NOT the reference's CAT_CAFE_*). This is a deliberate local
// copy so the mcp-server package stays decoupled from @clowder/api — the MCP
// server reaches the API over HTTP only, never by importing its modules.

/** Names of the env vars carrying the per-invocation callback config (§C3). */
export const CALLBACK_ENV_KEYS = {
  apiUrl: 'CLOWDER_API_URL',
  invocationId: 'CLOWDER_INVOCATION_ID',
  callbackToken: 'CLOWDER_CALLBACK_TOKEN',
} as const;
