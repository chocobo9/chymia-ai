// packages/api/src/config/account-resolver.ts
// Resolve the provider spawn-env for an agent's clientId from the AccountStore,
// then inject it into the CLI's environment (app-factory callbackEnv seam).
//
// Binding (MVP): by clientId — the `api_key` account for that provider supplies
// the key. With several accounts for one provider we pick the most-recently
// UPDATED (one "active" account per provider; Clowder's per-agent accountRef
// multi-account routing is the next slice). `oauth` accounts and "no account"
// inject NOTHING → the CLI falls back to its own ambient login (claude
// subscription, gemini OAuth) — so adding an api_key is strictly opt-in and never
// hijacks a working subscription login.
//
// The env-var names are the REAL CLIs' contracts (we spawn the genuine
// claude/codex/gemini, not a wrapper): claude reads ANTHROPIC_API_KEY/
// ANTHROPIC_BASE_URL, codex reads OPENAI_API_KEY/OPENAI_BASE_URL, gemini reads
// GEMINI_API_KEY/GOOGLE_API_KEY. (Mapping shape from Clowder invoke-single-cat,
// re-pointed at the unwrapped CLIs.)

import type { ClientId } from '@choco/shared';
import type { AccountStore } from '@choco/api/config/account-store';

/** Provider-specific env vars for a resolved api_key account. */
function envForClient(
  clientId: ClientId,
  apiKey: string,
  baseUrl: string | undefined,
): Record<string, string> {
  switch (clientId) {
    case 'anthropic':
      return {
        ANTHROPIC_API_KEY: apiKey,
        ...(baseUrl !== undefined ? { ANTHROPIC_BASE_URL: baseUrl } : {}),
      };
    case 'openai':
      return {
        OPENAI_API_KEY: apiKey,
        ...(baseUrl !== undefined ? { OPENAI_BASE_URL: baseUrl } : {}),
      };
    case 'google':
      // gemini-cli reads GEMINI_API_KEY (and GOOGLE_API_KEY as a fallback). It has
      // no widely-standard base-url env, so a baseUrl override is not wired here.
      return { GEMINI_API_KEY: apiKey, GOOGLE_API_KEY: apiKey };
  }
}

/**
 * Resolve the env-var map to merge into an agent's CLI spawn for `clientId`.
 * Returns {} when there's no usable api_key account (→ ambient CLI auth).
 */
export function resolveAccountEnv(
  store: AccountStore,
  clientId: ClientId,
): Record<string, string> {
  const candidates = store.listByClient(clientId).filter((a) => a.authType === 'api_key');
  if (candidates.length === 0) return {};
  // One active account per provider (MVP): newest-updated wins.
  const chosen = candidates.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
  const apiKey = store.getCredential(chosen.id)?.apiKey;
  if (typeof apiKey !== 'string' || apiKey.length === 0) return {};
  return envForClient(clientId, apiKey, chosen.baseUrl);
}
