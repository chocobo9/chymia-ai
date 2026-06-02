// M10 env-keys — the callback env-var names the CLI sets for this subprocess.
//
// Source: clowder-design-supplement.md §C3 + the FROZEN M8 contract
// (.harness/progress.md): app-factory's CALLBACK_ENV_KEYS exposes these neutral
// CHOCO_* names (NOT the reference's CAT_CAFE_*). This is a deliberate local
// copy so the mcp-server package stays decoupled from @choco/api — the MCP
// server reaches the API over HTTP only, never by importing its modules.

/** Names of the env vars carrying the per-invocation callback config (§C3). */
export const CALLBACK_ENV_KEYS = {
  apiUrl: 'CHOCO_API_URL',
  invocationId: 'CHOCO_INVOCATION_ID',
  callbackToken: 'CHOCO_CALLBACK_TOKEN',
} as const;
