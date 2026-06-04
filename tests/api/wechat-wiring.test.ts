// tests/api/wechat-wiring.test.ts — M13 wiring dev happy-path.
//
// Turns the BUILT-but-unwired WeCom adapter into a LIVE webhook. Covers:
//   • WeChatConfigStore: set → masked view → resolveAdapterCreds gating
//   • /api/adapters/wechat/config routes (secret write-only)
//   • OPERABILITY: a configured+enabled store → wireWeChatAdapter mounts the
//     webhook (GET echo verifies); not configured → no webhook (404).
//
// Hermetic: the store is a temp file (never the real ~/.choco). Edge/adversarial
// (zod-400s, secret-never-leaks, disabled/incomplete gating, signature mismatch)
// are the QA instance's (dev≠QA).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { WeChatConfigStore } from '@choco/api/config/wechat-config-store';
import { wireWeChatAdapter } from '@choco/api/runtime/wechat-wiring';
import { computeSignature } from '@choco/adapters/wechat';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

let dir: string;
let store: WeChatConfigStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'choco-wechat-'));
  store = new WeChatConfigStore(join(dir, 'wechat.json'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('WeChatConfigStore (dev happy path)', () => {
  it('masks the secret, defaults apiBase, and gates resolveAdapterCreds on complete+enabled', () => {
    expect(store.getView().hasSecret).toBe(false);
    expect(store.getView().apiBase).toBe('https://qyapi.weixin.qq.com/cgi-bin');
    expect(store.resolveAdapterCreds()).toBeNull(); // empty → not wired

    const view = store.set({ corpId: 'corp1', agentId: '1000002', token: 'tok1', secret: 'sec1', enabled: true });
    expect(view.hasSecret).toBe(true);
    expect(view.ready).toBe(true);
    expect((view as unknown as Record<string, unknown>).secret).toBeUndefined();
    expect(view.webhookPath).toBe('/api/adapters/wechat/webhook');

    expect(store.resolveAdapterCreds()).toEqual({
      corpId: 'corp1',
      agentId: '1000002',
      secret: 'sec1',
      token: 'tok1',
      apiBase: 'https://qyapi.weixin.qq.com/cgi-bin',
    });

    // Disabling keeps the creds but stops wiring.
    store.set({ enabled: false });
    expect(store.resolveAdapterCreds()).toBeNull();
    expect(store.getView().ready).toBe(false);
  });
});

describe('/api/adapters/wechat/config routes (dev happy path)', () => {
  function injectApp(): BuiltApp {
    const db = new Database(':memory:');
    return buildApp({
      db,
      agentServices: { 'claude-opus': new FakeAgentService([]) },
      wechatConfigStore: store,
    });
  }

  it('GET returns the masked view; PUT sets config (secret never echoed); bad body → 400', async () => {
    const app = injectApp();

    const before = await app.api.inject({ method: 'GET', url: '/api/adapters/wechat/config' });
    expect(before.statusCode).toBe(200);
    expect(before.json().config.hasSecret).toBe(false);

    const put = await app.api.inject({
      method: 'PUT',
      url: '/api/adapters/wechat/config',
      payload: { corpId: 'c', agentId: '1000002', token: 't', secret: 's', enabled: true },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().config.ready).toBe(true);
    expect(put.body).not.toContain('"s"'); // secret never crosses the boundary

    const bad = await app.api.inject({
      method: 'PUT',
      url: '/api/adapters/wechat/config',
      payload: { enabled: 'yes' },
    });
    expect(bad.statusCode).toBe(400);

    await app.close();
  });
});

describe('wireWeChatAdapter operability (dev happy path)', () => {
  function injectApp(): BuiltApp {
    const db = new Database(':memory:');
    return buildApp({
      db,
      agentServices: { 'claude-opus': new FakeAgentService([]) },
      wechatConfigStore: store,
    });
  }

  it('NOT configured → wire skipped, webhook 404', async () => {
    const app = injectApp();
    const wired = await wireWeChatAdapter({
      api: app.api,
      submitPlatformMessage: app.submitPlatformMessage,
      store,
    });
    expect(wired).toBe(false);
    const res = await app.api.inject({ method: 'GET', url: '/api/adapters/wechat/webhook' });
    expect(res.statusCode).toBe(404); // route not registered
    await app.close();
  });

  it('configured + enabled → webhook LIVE and verifies the WeCom echo', async () => {
    store.set({ corpId: 'corp1', agentId: '1000002', token: 'my-token', secret: 'sec1', enabled: true });
    const app = injectApp();
    const wired = await wireWeChatAdapter({
      api: app.api,
      submitPlatformMessage: app.submitPlatformMessage,
      store,
    });
    expect(wired).toBe(true);

    const ts = '1700000000';
    const nonce = 'abc123';
    const echo = 'hello-wecom';
    const signature = computeSignature('my-token', ts, nonce, echo);
    const res = await app.api.inject({
      method: 'GET',
      url: `/api/adapters/wechat/webhook?signature=${signature}&timestamp=${ts}&nonce=${nonce}&echostr=${echo}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(echo); // echo returned → webhook live + signature verified

    await app.close();
  });
});
