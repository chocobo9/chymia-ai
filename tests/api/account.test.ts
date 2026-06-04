// tests/api/account.test.ts — M-ACCOUNT dev happy-path.
//
// Covers the provider-account / BYOK-key feature end to end:
//   • AccountStore: create → masked list → credential read → update → delete
//   • resolveAccountEnv: clientId → the real CLI env vars (ANTHROPIC/OPENAI/GEMINI)
//   • routes: POST/GET/PATCH/DELETE /api/accounts (key WRITE-ONLY across boundary)
//   • OPERABILITY proof: a saved openai key actually lands in the codex spawn env
//
// Hermetic: the store is pointed at OS-temp files (never the real ~/.choco). Edge
// + adversarial (zod-400s, key-never-leaks-on-GET, oauth-not-injected,
// newest-wins, delete safety) are the QA instance's (dev≠QA).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { AccountStore } from '@choco/api/config/account-store';
import { resolveAccountEnv } from '@choco/api/config/account-resolver';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { replyScript, CODEX } from './helpers.js';

let dir: string;
let store: AccountStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'choco-acct-'));
  store = new AccountStore({
    accountsPath: join(dir, 'accounts.json'),
    credentialsPath: join(dir, 'credentials.json'),
    now: () => 1000,
  });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('AccountStore (dev happy path)', () => {
  it('creates an account, masks the key on list, but keeps the secret retrievable for injection', () => {
    const summary = store.create({
      clientId: 'openai',
      authType: 'api_key',
      displayName: 'my-openai',
      apiKey: 'sk-real-openai-key',
    });
    expect(summary.id).toBe('my-openai');
    expect(summary.hasApiKey).toBe(true);
    // The masked summary carries NO raw key.
    expect((summary as unknown as Record<string, unknown>).apiKey).toBeUndefined();

    const list = store.listSummaries();
    expect(list).toHaveLength(1);
    expect(list[0]!.hasApiKey).toBe(true);
    expect(JSON.stringify(list)).not.toContain('sk-real-openai-key');

    // The secret IS retrievable via the injection-only path.
    expect(store.getCredential('my-openai')?.apiKey).toBe('sk-real-openai-key');
  });

  it('updates metadata, clears the key with an empty string, and deletes account + secret', () => {
    store.create({ clientId: 'google', authType: 'api_key', displayName: 'gem', apiKey: 'AIza-key' });
    const updated = store.update('gem', { displayName: 'gemini-main', apiKey: '' });
    expect(updated?.displayName).toBe('gemini-main');
    expect(updated?.hasApiKey).toBe(false); // empty string cleared the secret
    expect(store.getCredential('gem')?.apiKey).toBeUndefined();

    expect(store.delete('gem')).toBe(true);
    expect(store.listSummaries()).toHaveLength(0);
    expect(store.delete('gem')).toBe(false); // already gone
  });
});

describe('resolveAccountEnv (dev happy path)', () => {
  it('maps each provider account to the real CLI env vars', () => {
    store.create({ clientId: 'anthropic', authType: 'api_key', displayName: 'a', apiKey: 'sk-ant' });
    store.create({ clientId: 'openai', authType: 'api_key', displayName: 'o', apiKey: 'sk-oai', baseUrl: 'https://proxy/v1' });
    store.create({ clientId: 'google', authType: 'api_key', displayName: 'g', apiKey: 'AIza' });

    expect(resolveAccountEnv(store, 'anthropic')).toEqual({ ANTHROPIC_API_KEY: 'sk-ant' });
    expect(resolveAccountEnv(store, 'openai')).toEqual({
      OPENAI_API_KEY: 'sk-oai',
      OPENAI_BASE_URL: 'https://proxy/v1',
    });
    expect(resolveAccountEnv(store, 'google')).toEqual({
      GEMINI_API_KEY: 'AIza',
      GOOGLE_API_KEY: 'AIza',
    });
  });

  it('injects nothing for a provider with no api_key account (→ ambient CLI auth)', () => {
    expect(resolveAccountEnv(store, 'openai')).toEqual({});
    store.create({ clientId: 'openai', authType: 'oauth', displayName: 'sub' });
    expect(resolveAccountEnv(store, 'openai')).toEqual({}); // oauth carries no key
  });
});

describe('/api/accounts routes + spawn-env injection (dev happy path)', () => {
  function injectApp(): { app: BuiltApp; fakeCodex: FakeAgentService } {
    const db = new Database(':memory:');
    const fakeCodex = new FakeAgentService([replyScript(CODEX, '好的，这是函数。')]);
    const app = buildApp({ db, agentServices: { 'codex-gpt': fakeCodex }, accountStore: store });
    return { app, fakeCodex };
  }

  it('POST creates (201, masked), GET lists masked, PATCH updates, DELETE removes', async () => {
    const { app } = injectApp();
    const created = await app.api.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { clientId: 'openai', displayName: 'work', apiKey: 'sk-work' },
    });
    expect(created.statusCode).toBe(201);
    const account = created.json().account as Record<string, unknown>;
    expect(account.id).toBe('work');
    expect(account.hasApiKey).toBe(true);
    expect(account.apiKey).toBeUndefined();

    const listed = await app.api.inject({ method: 'GET', url: '/api/accounts' });
    expect(listed.json().accounts).toHaveLength(1);
    expect(listed.body).not.toContain('sk-work'); // key never crosses a read

    const patched = await app.api.inject({
      method: 'PATCH',
      url: '/api/accounts/work',
      payload: { displayName: 'work-renamed' },
    });
    expect(patched.json().account.displayName).toBe('work-renamed');

    const removed = await app.api.inject({ method: 'DELETE', url: '/api/accounts/work' });
    expect(removed.statusCode).toBe(200);
    const after = await app.api.inject({ method: 'GET', url: '/api/accounts' });
    expect(after.json().accounts).toHaveLength(0);

    await app.close();
  });

  it('OPERABLE: a saved OpenAI key reaches the codex agent CLI spawn env on the next turn', async () => {
    const { app, fakeCodex } = injectApp();
    // Save the key via the real route.
    await app.api.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { clientId: 'openai', displayName: 'oai', apiKey: 'sk-injected-123' },
    });
    // Drive a turn routed to codex (clientId openai).
    const sent = await app.api.inject({
      method: 'POST',
      url: '/api/threads/t-acct/messages',
      payload: { content: '@codex 写个 add 函数' },
    });
    expect(sent.statusCode).toBe(200);

    // The fake codex service was invoked WITH the key in its spawn env.
    expect(fakeCodex.calls.length).toBeGreaterThan(0);
    expect(fakeCodex.calls[0]!.options?.callbackEnv?.OPENAI_API_KEY).toBe('sk-injected-123');

    await app.close();
  });
});
