// Provider account / credential types (M-ACCOUNT, cross-module).
// Ported from Clowder's account model (reference: ~/.cat-cafe accounts.json +
// credentials.json; AccountConfig + CredentialEntry). Aligned, not copied:
// metadata and secrets are split into two stores so the masked list never has to
// touch the secret file, and clientId reuses our existing ClientId union.
//
// Storage (M-ACCOUNT store): GLOBAL (shared across projects), under ~/.choco —
//   ~/.choco/accounts.json     metadata (this AccountConfig list)
//   ~/.choco/credentials.json  secrets (CredentialEntry per account id, mode 0600)

import type { ClientId } from './agent.js';

/**
 * AuthType — how an account authenticates. `api_key` (BYOK) is the wired path:
 * the stored key is injected into the agent CLI's spawn env. `oauth` accounts
 * carry no key here (the provider CLI owns its own OAuth cache) — they fall back
 * to the CLI's ambient login, so listing them is honest about what's configured.
 */
export type AuthType = 'api_key' | 'oauth';

/**
 * AccountConfig — the non-secret metadata for one provider account. Persisted to
 * ~/.choco/accounts.json. `id` is a stable slug the credential store keys by.
 */
export interface AccountConfig {
  /** Stable id (slug); the secret in credentials.json is keyed by this. */
  readonly id: string;
  /** Which provider this account is for (drives env-var injection). */
  readonly clientId: ClientId;
  readonly authType: AuthType;
  /** Human label shown in the UI (e.g. "my-openai-work"). */
  readonly displayName: string;
  /** Optional base-URL override (self-hosted / proxy / OpenRouter). */
  readonly baseUrl?: string;
  /** Optional advertised model list (informational; not enforced). */
  readonly models?: readonly string[];
  readonly createdAt: number; // epoch ms
  readonly updatedAt: number; // epoch ms
}

/**
 * CredentialEntry — the SECRET half for an account, persisted to
 * ~/.choco/credentials.json (mode 0600). Never returned by the list API.
 */
export interface CredentialEntry {
  readonly apiKey?: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  /** Token expiry as epoch ms (oauth). */
  readonly expiresAt?: number;
}

/**
 * AccountSummary — the MASKED account shape the GET list returns. Carries
 * `hasApiKey` (presence only) — NEVER the raw key — so the secret never crosses
 * the API boundary on a read.
 */
export interface AccountSummary extends AccountConfig {
  readonly hasApiKey: boolean;
}

/**
 * ProviderAuthStatus — the OAuth / subscription-login state of a provider's CLI,
 * read by running that CLI's own auth command (e.g. `claude auth status`). This is
 * the OAuth half of 账户与密钥: the CLI owns the login (browser OAuth); we surface
 * its status and can trigger `login`/`logout`.
 */
export interface ProviderAuthStatus {
  readonly clientId: ClientId;
  /** The CLI binary this provider logs in through (claude / codex / gemini). */
  readonly cli: string;
  /** Whether that CLI is installed on this machine. */
  readonly available: boolean;
  /** true/false from the CLI's status command; null = no scriptable status. */
  readonly loggedIn: boolean | null;
  /** Whether we can trigger a CLI login/logout for this provider. */
  readonly supportsLogin: boolean;
  /** Email / plan / hint surfaced to the user (e.g. the logged-in account). */
  readonly detail?: string;
}
