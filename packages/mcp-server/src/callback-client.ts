// M10 callback-client — the MCP→API HTTP seam.
//
// Source: clowder-design-supplement.md §C3 (MCP run model: the MCP server is a
// CLI subprocess; on a tool call it does an HTTP POST to an API callback
// endpoint; the API verifies invocationId + callbackToken; env vars carry the
// callback config) + the FROZEN M8 callback contract (.harness/progress.md):
//   - reads CHOCO_API_URL / CHOCO_INVOCATION_ID / CHOCO_CALLBACK_TOKEN
//   - every request sends headers X-Invocation-Id + X-Callback-Token
//   - bodies are `.strict()` server-side — we send ONLY the documented fields
//     and never re-supply identity (threadId/agentId come from the verified
//     record server-side).
//
// Graceful degradation (PROJECT_SPEC §M10 verify, "无 env vars 时 → 优雅降级"):
// when the env vars are absent the client returns a structured error result —
// it MUST NOT throw / crash the stdio server. Tool handlers surface that error
// to the MCP client as an isError ToolResult.

import { CALLBACK_ENV_KEYS } from './env-keys.js';

/**
 * Env-var names the CLI sets so this MCP subprocess can reach the API.
 * Mirrors app-factory's CALLBACK_ENV_KEYS (kept as a local copy so the
 * mcp-server package does not depend on @choco/api — it talks HTTP only).
 */

/** Canonical auth header names the API's callback-auth expects (lowercased). */
export const INVOCATION_ID_HEADER = 'x-invocation-id';
export const CALLBACK_TOKEN_HEADER = 'x-callback-token';

/** Resolved callback configuration read from the process environment. */
export interface CallbackConfig {
  readonly apiUrl: string;
  readonly invocationId: string;
  readonly callbackToken: string;
}

/**
 * Outcome of a callback call (discriminated on `ok`).
 * `data` is the parsed JSON body on success; `error` is a human-readable
 * message on failure (never throws — the stdio server stays alive).
 */
export type CallbackResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: string; readonly status?: number };

/**
 * Read the three callback env vars. Returns null when any is missing/empty so
 * callers can degrade gracefully instead of sending an unauthenticated request.
 * No hardcoded fallbacks (CLAUDE.md §2.1 — config comes from env, never source).
 */
export function readCallbackConfig(
  env: NodeJS.ProcessEnv = process.env,
): CallbackConfig | null {
  const apiUrl = nonEmpty(env[CALLBACK_ENV_KEYS.apiUrl]);
  const invocationId = nonEmpty(env[CALLBACK_ENV_KEYS.invocationId]);
  const callbackToken = nonEmpty(env[CALLBACK_ENV_KEYS.callbackToken]);
  if (apiUrl === undefined || invocationId === undefined || callbackToken === undefined) {
    return null;
  }
  return { apiUrl, invocationId, callbackToken };
}

/** Clear, agent-facing message when callback credentials are not configured. */
export const NO_CONFIG_ERROR =
  'Clowder callback not configured: missing CHOCO_API_URL / CHOCO_INVOCATION_ID / ' +
  'CHOCO_CALLBACK_TOKEN. This MCP server must be spawned by the Clowder CLI, which ' +
  'injects the callback credentials for the current invocation.';

/** Build the auth headers a callback request must carry (frozen M8 contract). */
export function buildAuthHeaders(config: CallbackConfig): Record<string, string> {
  return {
    [INVOCATION_ID_HEADER]: config.invocationId,
    [CALLBACK_TOKEN_HEADER]: config.callbackToken,
  };
}

/**
 * The HTTP client a tool calls. Constructed once at startup with a `fetch`
 * implementation and an env reader (both injectable for tests — no global
 * coupling, deterministic). `config` is read lazily per call so a server that
 * starts WITHOUT credentials still constructs cleanly (graceful degradation)
 * and a later-set env would take effect.
 */
export class CallbackClient {
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: { readonly fetchImpl?: typeof fetch; readonly env?: NodeJS.ProcessEnv } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.env = options.env ?? process.env;
  }

  /**
   * POST `body` to `/api/callback/<name>` with the auth headers. Returns a
   * structured CallbackResult — NEVER throws (network errors, missing config,
   * and non-2xx responses are all returned as `{ ok: false }`).
   */
  async post(name: string, body: Record<string, unknown>): Promise<CallbackResult> {
    const config = readCallbackConfig(this.env);
    if (config === null) {
      return { ok: false, error: NO_CONFIG_ERROR };
    }

    const url = `${trimTrailingSlash(config.apiUrl)}/api/callback/${name}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...buildAuthHeaders(config),
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Callback request failed: ${message}` };
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      text = '';
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `Callback ${name} failed (${response.status}): ${text}`,
      };
    }

    if (text.length === 0) {
      return { ok: true, data: {} };
    }
    try {
      return { ok: true, data: JSON.parse(text) as unknown };
    } catch {
      // A 2xx with a non-JSON body is unexpected from our API; surface the raw text.
      return { ok: true, data: text };
    }
  }
}

/** Trim a single trailing slash so `${apiUrl}/api/...` never doubles up. */
function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/** Return the trimmed string only if it is non-empty, else undefined. */
function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
