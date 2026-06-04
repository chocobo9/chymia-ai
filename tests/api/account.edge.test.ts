// tests/api/account.edge.test.ts — M-ACCOUNT QA edge + adversarial (dev≠QA).
//
// Authored by the INDEPENDENT QA instance (the dev wrote only the happy path in
// account.test.ts). Gates the provider-account / BYOK-key feature against its
// hard contracts:
//   • zod-400 boundary on POST/PATCH/DELETE (bad clientId, name length, missing
//     body, bad/empty id param)
//   • the SECRET never crosses a read (GET masking) even when one IS stored
//   • resolveAccountEnv binding: oauth → {}, empty-key → {}, no-account → {},
//     and NEWEST-updatedAt wins among several api_key accounts for one provider
//   • update semantics: apiKey:'' clears, baseUrl:'' clears, omitted apiKey is
//     left intact
//   • id-collision slugging, cross-instance persistence over the SAME files
//
// Hermetic: every store points at OS-temp files (mkdtemp, rm'd in afterEach) and
// every app uses an in-memory db — never the real ~/.choco.
//
// Distribution (this file): happy ≤50%, edge ≥30%, adversarial ≥20%.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { AccountStore } from '@choco/api/config/account-store';
import { resolveAccountEnv } from '@choco/api/config/account-resolver';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { replyScript, CODEX } from './helpers.js';

let dir: string;
let accountsPath: string;
let credentialsPath: string;
/** A mutable clock so a test can mint accounts at distinct `updatedAt` values. */
let clock = 1000;

function newStore(): AccountStore {
  return new AccountStore({ accountsPath, credentialsPath, now: () => clock });
}

let store: AccountStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'choco-acct-edge-'));
  accountsPath = join(dir, 'accounts.json');
  credentialsPath = join(dir, 'credentials.json');
  clock = 1000;
  store = newStore();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Build an app over an in-memory db with the hermetic AccountStore injected. */
function buildAccountApp(): { app: BuiltApp; fakeCodex: FakeAgentService } {
  const db = new Database(':memory:');
  const fakeCodex = new FakeAgentService([replyScript(CODEX, '好的，这是函数。')]);
  const app = buildApp({ db, agentServices: { 'codex-gpt': fakeCodex }, accountStore: store });
  return { app, fakeCodex };
}

describe('POST /api/accounts — zod boundary (edge + adversarial)', () => {
  it('[edge] rejects a body with a missing clientId → 400 invalid_params', async () => {
    const { app } = buildAccountApp();
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { displayName: 'no-provider', apiKey: 'sk-orphan' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_params' });
    // A rejected create persisted nothing.
    expect(store.listSummaries()).toHaveLength(0);
    await app.close();
  });

  it('[adversarial] rejects an out-of-union clientId ("mistral") → 400, nothing stored', async () => {
    const { app } = buildAccountApp();
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { clientId: 'mistral', displayName: 'rogue', apiKey: 'sk-rogue' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_params' });
    expect(store.listSummaries()).toHaveLength(0);
    await app.close();
  });

  it('[edge] rejects an empty displayName → 400 invalid_params', async () => {
    const { app } = buildAccountApp();
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { clientId: 'openai', displayName: '', apiKey: 'sk-empty-name' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_params' });
    await app.close();
  });

  it('[adversarial] rejects a displayName longer than 80 chars → 400', async () => {
    const { app } = buildAccountApp();
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { clientId: 'anthropic', displayName: 'x'.repeat(81), apiKey: 'sk-toolong' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_params' });
    await app.close();
  });

  it('[adversarial] rejects a completely missing body → 400', async () => {
    const { app } = buildAccountApp();
    const res = await app.api.inject({ method: 'POST', url: '/api/accounts' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_params' });
    await app.close();
  });
});

describe('PATCH/DELETE /api/accounts/:id — unknown / bad id (edge + adversarial)', () => {
  it('[edge] PATCH an unknown id → 404 account_not_found', async () => {
    const { app } = buildAccountApp();
    const res = await app.api.inject({
      method: 'PATCH',
      url: '/api/accounts/ghost-account',
      payload: { displayName: 'renamed-ghost' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'account_not_found' });
    await app.close();
  });

  it('[edge] DELETE an unknown id → 404 account_not_found', async () => {
    const { app } = buildAccountApp();
    const res = await app.api.inject({ method: 'DELETE', url: '/api/accounts/ghost-account' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'account_not_found' });
    await app.close();
  });

  it('[adversarial] PATCH/DELETE with an EMPTY id param resolves to the collection route (404/405), never a wildcard hit', async () => {
    const { app } = buildAccountApp();
    store.create({ clientId: 'openai', authType: 'api_key', displayName: 'real', apiKey: 'sk-real' });
    // /api/accounts/ with a trailing-empty segment must NOT be treated as :id='' →
    // it can never match a stored account. Whatever Fastify routes it to, it is
    // not a 2xx mutation of the real account.
    const patched = await app.api.inject({
      method: 'PATCH',
      url: '/api/accounts/',
      payload: { displayName: 'hijacked' },
    });
    const deleted = await app.api.inject({ method: 'DELETE', url: '/api/accounts/' });
    expect(patched.statusCode).not.toBe(200);
    expect(deleted.statusCode).not.toBe(200);
    // The real account is untouched.
    const list = store.listSummaries();
    expect(list).toHaveLength(1);
    expect(list[0]!.displayName).toBe('real');
    await app.close();
  });
});

describe('GET /api/accounts — the key never leaks on a read (adversarial)', () => {
  it('[adversarial] a stored key never appears anywhere in the GET body; each summary is masked', async () => {
    const { app } = buildAccountApp();
    const secret = 'sk-super-secret-anthropic-key-0xDEADBEEF';
    const created = await app.api.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { clientId: 'anthropic', displayName: 'leak-probe', apiKey: secret },
    });
    expect(created.statusCode).toBe(201);

    const listed = await app.api.inject({ method: 'GET', url: '/api/accounts' });
    expect(listed.statusCode).toBe(200);
    // The raw secret must not be present in the serialized response at all.
    expect(listed.body).not.toContain(secret);

    const accounts = listed.json().accounts as Record<string, unknown>[];
    expect(accounts).toHaveLength(1);
    const summary = accounts[0]!;
    expect(summary.hasApiKey).toBe(true);
    expect(summary.apiKey).toBeUndefined();
    expect(Object.keys(summary)).not.toContain('apiKey');
    // The secret IS still retrievable through the injection-only seam (not the API).
    expect(store.getCredential('leak-probe')?.apiKey).toBe(secret);
    await app.close();
  });
});

describe('resolveAccountEnv — injection guards (edge + adversarial)', () => {
  it('[edge] an oauth account injects NOTHING (no key to bind) → {}', () => {
    store.create({ clientId: 'anthropic', authType: 'oauth', displayName: 'claude-sub' });
    expect(resolveAccountEnv(store, 'anthropic')).toEqual({});
  });

  it('[adversarial] an api_key account whose key was cleared (empty) injects NOTHING → {}', () => {
    store.create({ clientId: 'openai', authType: 'api_key', displayName: 'cleared', apiKey: 'sk-temp' });
    store.update('cleared', { apiKey: '' }); // clears the secret
    expect(resolveAccountEnv(store, 'openai')).toEqual({});
  });

  it('[edge] no account for a provider injects NOTHING → {} (ambient CLI auth)', () => {
    store.create({ clientId: 'anthropic', authType: 'api_key', displayName: 'a', apiKey: 'sk-ant' });
    // google has no account at all.
    expect(resolveAccountEnv(store, 'google')).toEqual({});
  });

  it('[adversarial] with two openai api_key accounts the NEWEST-updatedAt key wins', () => {
    clock = 1000;
    store.create({ clientId: 'openai', authType: 'api_key', displayName: 'old-proxy', apiKey: 'sk-OLD' });
    clock = 5000; // a strictly later mint → newer updatedAt
    store.create({ clientId: 'openai', authType: 'api_key', displayName: 'new-direct', apiKey: 'sk-NEW' });

    const env = resolveAccountEnv(store, 'openai');
    expect(env.OPENAI_API_KEY).toBe('sk-NEW');
    expect(env.OPENAI_API_KEY).not.toBe('sk-OLD');
  });

  it('[adversarial] newest-wins is by updatedAt, not insertion order: touching the OLDER account makes it win', () => {
    clock = 1000;
    store.create({ clientId: 'openai', authType: 'api_key', displayName: 'first', apiKey: 'sk-FIRST' });
    clock = 2000;
    store.create({ clientId: 'openai', authType: 'api_key', displayName: 'second', apiKey: 'sk-SECOND' });
    // Re-touch the FIRST account at the latest clock → its updatedAt is now newest.
    clock = 9000;
    store.update('first', { displayName: 'first-renamed' });

    expect(resolveAccountEnv(store, 'openai').OPENAI_API_KEY).toBe('sk-FIRST');
  });

  it('[edge] google maps to BOTH GEMINI_API_KEY and GOOGLE_API_KEY', () => {
    store.create({ clientId: 'google', authType: 'api_key', displayName: 'gem', apiKey: 'AIza-real' });
    expect(resolveAccountEnv(store, 'google')).toEqual({
      GEMINI_API_KEY: 'AIza-real',
      GOOGLE_API_KEY: 'AIza-real',
    });
  });
});

describe('AccountStore.update — clear vs leave-intact semantics (edge + adversarial)', () => {
  it('[edge] apiKey:"" clears the secret (hasApiKey→false, getCredential undefined)', () => {
    store.create({ clientId: 'openai', authType: 'api_key', displayName: 'work', apiKey: 'sk-work' });
    const updated = store.update('work', { apiKey: '' });
    expect(updated?.hasApiKey).toBe(false);
    expect(store.getCredential('work')?.apiKey).toBeUndefined();
    expect(resolveAccountEnv(store, 'openai')).toEqual({});
  });

  it('[edge] baseUrl:"" clears the stored baseUrl', () => {
    store.create({
      clientId: 'openai',
      authType: 'api_key',
      displayName: 'proxied',
      apiKey: 'sk-proxied',
      baseUrl: 'https://proxy.example/v1',
    });
    expect(store.get('proxied')?.baseUrl).toBe('https://proxy.example/v1');
    store.update('proxied', { baseUrl: '' });
    expect(store.get('proxied')?.baseUrl).toBeUndefined();
    // The env no longer carries the (now-cleared) base-url override.
    expect(resolveAccountEnv(store, 'openai')).toEqual({ OPENAI_API_KEY: 'sk-proxied' });
  });

  it('[adversarial] omitting apiKey on an unrelated metadata update LEAVES the key intact', () => {
    store.create({ clientId: 'anthropic', authType: 'api_key', displayName: 'keep', apiKey: 'sk-keep-me' });
    const updated = store.update('keep', { displayName: 'keep-renamed' }); // no apiKey field
    expect(updated?.displayName).toBe('keep-renamed');
    expect(updated?.hasApiKey).toBe(true);
    expect(store.getCredential('keep')?.apiKey).toBe('sk-keep-me');
  });
});

describe('AccountStore — id collisions + cross-instance persistence (edge)', () => {
  it('[edge] two accounts with the SAME displayName get distinct ids (x, x-2)', () => {
    const a = store.create({ clientId: 'openai', authType: 'api_key', displayName: 'My Account', apiKey: 'sk-a' });
    const b = store.create({ clientId: 'openai', authType: 'api_key', displayName: 'My Account', apiKey: 'sk-b' });
    expect(a.id).toBe('my-account');
    expect(b.id).toBe('my-account-2');
    expect(a.id).not.toBe(b.id);
    // Each id keeps its OWN secret (no clobbering).
    expect(store.getCredential('my-account')?.apiKey).toBe('sk-a');
    expect(store.getCredential('my-account-2')?.apiKey).toBe('sk-b');
  });

  it('[edge] a NEW store over the SAME files sees a previously-created account + its secret', () => {
    store.create({
      clientId: 'google',
      authType: 'api_key',
      displayName: 'persisted',
      apiKey: 'AIza-persist',
      baseUrl: 'https://gw.example',
    });
    // A fresh instance pointed at the same paths (simulates a process restart).
    const reopened = newStore();
    const summaries = reopened.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.id).toBe('persisted');
    expect(summaries[0]!.hasApiKey).toBe(true);
    expect(reopened.getCredential('persisted')?.apiKey).toBe('AIza-persist');
    expect(resolveAccountEnv(reopened, 'google')).toEqual({
      GEMINI_API_KEY: 'AIza-persist',
      GOOGLE_API_KEY: 'AIza-persist',
    });
  });

  it('[edge] writing a key creates the credentials file (mode 0600 on POSIX; win32 noted)', () => {
    store.create({ clientId: 'openai', authType: 'api_key', displayName: 'modecheck', apiKey: 'sk-mode' });
    expect(existsSync(credentialsPath)).toBe(true);
    if (platform() === 'win32') {
      // Windows does not honor POSIX file modes; the 0600 intent is a no-op there.
      // We only assert the file exists (above). NOTE: on win32 the mode is not 0600.
      expect(true).toBe(true);
    } else {
      const mode = statSync(credentialsPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});
