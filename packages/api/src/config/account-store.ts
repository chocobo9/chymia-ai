// packages/api/src/config/account-store.ts
// M-ACCOUNT store — provider accounts (metadata) + credentials (secrets), split
// into two global files under ~/.choco (Clowder's accounts.json / credentials.json
// model, re-authored for our types):
//   accounts.json      AccountConfig[]            (metadata; readable)
//   credentials.json   Record<id, CredentialEntry> (secrets; written mode 0600)
//
// Splitting them means the masked list (toSummary) never reads the secret file,
// and a secret is only ever loaded at injection time (account-resolver). Fail-open
// reads (missing/corrupt file → empty) so a bad file never blocks boot; writes
// create the dir + file as needed. No encryption at rest — the filesystem (0600,
// ~/.choco owned by the user) is the trust boundary, matching Clowder.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AccountConfig, AccountSummary, CredentialEntry, ClientId } from '@choco/shared';
import { globalConfigPath } from '@choco/api/config/global-config';

/** File names under the global config root. */
const ACCOUNTS_FILE = 'accounts.json';
const CREDENTIALS_FILE = 'credentials.json';
/** Owner-only mode for the secret file (rw-------). */
const SECRET_FILE_MODE = 0o600;

/** Fields a caller may set when creating an account (id/timestamps are minted). */
export interface CreateAccountInput {
  readonly clientId: ClientId;
  readonly authType: AccountConfig['authType'];
  readonly displayName: string;
  readonly baseUrl?: string;
  readonly models?: readonly string[];
  /** The secret (BYOK). Stored in credentials.json, never echoed back. */
  readonly apiKey?: string;
}

/** Fields a caller may patch (all optional; absent = unchanged). */
export interface UpdateAccountInput {
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly models?: readonly string[];
  readonly authType?: AccountConfig['authType'];
  /** New secret. Empty string CLEARS the stored key; undefined leaves it. */
  readonly apiKey?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Slugify a display name into a stable id; falls back to the clientId. */
function slugify(displayName: string, clientId: ClientId): string {
  const base = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base.length > 0 ? base : (clientId as string);
}

/**
 * File-backed provider-account store. Reads are fail-open (corrupt/missing →
 * empty). The secret store is keyed by account id; deleting an account drops its
 * secret too. Clock + paths are injectable (tests).
 */
export class AccountStore {
  private readonly accountsPath: string;
  private readonly credentialsPath: string;
  private readonly now: () => number;

  constructor(deps: { accountsPath?: string; credentialsPath?: string; now?: () => number } = {}) {
    this.accountsPath = deps.accountsPath ?? globalConfigPath(ACCOUNTS_FILE);
    this.credentialsPath = deps.credentialsPath ?? globalConfigPath(CREDENTIALS_FILE);
    this.now = deps.now ?? Date.now;
  }

  // ── metadata (accounts.json) ──────────────────────────────────────────────

  private readAccounts(): AccountConfig[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.accountsPath, 'utf-8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((a): a is AccountConfig => isRecord(a) && typeof a.id === 'string');
    } catch {
      return [];
    }
  }

  private writeAccounts(accounts: readonly AccountConfig[]): void {
    mkdirSync(dirname(this.accountsPath), { recursive: true });
    writeFileSync(this.accountsPath, JSON.stringify(accounts, null, 2), 'utf-8');
  }

  // ── secrets (credentials.json, 0600) ──────────────────────────────────────

  private readCredentials(): Record<string, CredentialEntry> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.credentialsPath, 'utf-8'));
      return isRecord(parsed) ? (parsed as Record<string, CredentialEntry>) : {};
    } catch {
      return {};
    }
  }

  private writeCredentials(creds: Record<string, CredentialEntry>): void {
    mkdirSync(dirname(this.credentialsPath), { recursive: true });
    writeFileSync(this.credentialsPath, JSON.stringify(creds, null, 2), {
      encoding: 'utf-8',
      mode: SECRET_FILE_MODE,
    });
  }

  // ── public API ────────────────────────────────────────────────────────────

  /** The raw credential for an account id (injection path only; never the API). */
  getCredential(id: string): CredentialEntry | undefined {
    return this.readCredentials()[id];
  }

  /** All accounts as MASKED summaries (hasApiKey only — never the raw key). */
  listSummaries(): AccountSummary[] {
    const creds = this.readCredentials();
    return this.readAccounts().map((a) => ({
      ...a,
      hasApiKey: typeof creds[a.id]?.apiKey === 'string' && creds[a.id]!.apiKey!.length > 0,
    }));
  }

  /** A single account's metadata (no secret), or undefined. */
  get(id: string): AccountConfig | undefined {
    return this.readAccounts().find((a) => a.id === id);
  }

  /** Accounts for one provider (clientId) — used by the resolver to bind by provider. */
  listByClient(clientId: ClientId): AccountConfig[] {
    return this.readAccounts().filter((a) => a.clientId === clientId);
  }

  /**
   * Create an account. Mints a unique id from the display name; the secret (if
   * given) goes to credentials.json. Returns the masked summary.
   */
  create(input: CreateAccountInput): AccountSummary {
    const accounts = this.readAccounts();
    const id = this.uniqueId(slugify(input.displayName, input.clientId), accounts);
    const ts = this.now();
    const account: AccountConfig = {
      id,
      clientId: input.clientId,
      authType: input.authType,
      displayName: input.displayName,
      ...(input.baseUrl !== undefined && input.baseUrl.length > 0 ? { baseUrl: input.baseUrl } : {}),
      ...(input.models !== undefined && input.models.length > 0 ? { models: input.models } : {}),
      createdAt: ts,
      updatedAt: ts,
    };
    this.writeAccounts([...accounts, account]);
    const hasApiKey = typeof input.apiKey === 'string' && input.apiKey.length > 0;
    if (hasApiKey) {
      const creds = this.readCredentials();
      creds[id] = { apiKey: input.apiKey };
      this.writeCredentials(creds);
    }
    return { ...account, hasApiKey };
  }

  /** Update an account's metadata and/or secret. Returns the summary, or undefined. */
  update(id: string, input: UpdateAccountInput): AccountSummary | undefined {
    const accounts = this.readAccounts();
    const idx = accounts.findIndex((a) => a.id === id);
    if (idx === -1) return undefined;
    const prev = accounts[idx]!;
    const next: AccountConfig = {
      ...prev,
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.authType !== undefined ? { authType: input.authType } : {}),
      // baseUrl: empty string clears it.
      ...(input.baseUrl !== undefined
        ? input.baseUrl.length > 0
          ? { baseUrl: input.baseUrl }
          : { baseUrl: undefined }
        : {}),
      ...(input.models !== undefined ? { models: input.models } : {}),
      updatedAt: this.now(),
    };
    this.writeAccounts(accounts.map((a, i) => (i === idx ? next : a)));

    if (input.apiKey !== undefined) {
      const creds = this.readCredentials();
      if (input.apiKey.length > 0) creds[id] = { ...creds[id], apiKey: input.apiKey };
      else delete creds[id]; // empty string clears the secret
      this.writeCredentials(creds);
    }
    const apiKey = this.readCredentials()[id]?.apiKey;
    return { ...next, hasApiKey: typeof apiKey === 'string' && apiKey.length > 0 };
  }

  /** Delete an account + its secret. Returns true if it existed. */
  delete(id: string): boolean {
    const accounts = this.readAccounts();
    const next = accounts.filter((a) => a.id !== id);
    if (next.length === accounts.length) return false;
    this.writeAccounts(next);
    const creds = this.readCredentials();
    if (creds[id] !== undefined) {
      delete creds[id];
      this.writeCredentials(creds);
    }
    return true;
  }

  /** Ensure a slug is unique among existing ids (append -2, -3, …). */
  private uniqueId(base: string, accounts: readonly AccountConfig[]): string {
    const taken = new Set(accounts.map((a) => a.id));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n += 1) {
      const candidate = `${base}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
}
