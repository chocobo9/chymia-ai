// tests/api/wechat-wiring.edge.test.ts — M13 WeCom wiring EDGE + ADVERSARIAL gate.
//
// Authored by the INDEPENDENT QA instance (dev≠QA, §0.5.3): the dev shipped the
// happy path in wechat-wiring.test.ts; this file gates the dark corners:
//   • resolveAdapterCreds() gating on EACH missing piece (disabled / no corpId /
//     no token / no secret) + the all-present case.
//   • set() patch semantics: secret-clear, partial patch leaves others intact,
//     empty apiBase defaults to qyapi.
//   • persistence across a SECOND store over the same file (secret survives + is
//     usable via resolveAdapterCreds).
//   • ADVERSARIAL: the GET /config body NEVER carries the secret string.
//   • routes zod-400 on malformed bodies.
//   • wiring operability: skipped (404) when disabled/incomplete; live when complete;
//     GET valid-sig → 200 echo, GET/POST wrong-sig → 401; double-wire must not throw.
//
// Hermetic: each store is a temp file (never the real ~/.choco). Realistic creds
// (corpId/token/secret strings shaped like real WeCom values), no placeholders.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { WeChatConfigStore } from '@choco/api/config/wechat-config-store';
import { wireWeChatAdapter } from '@choco/api/runtime/wechat-wiring';
import { computeSignature } from '@choco/adapters/wechat';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

const WEBHOOK = '/api/adapters/wechat/webhook';
// The product default now carries the /cgi-bin suffix the WeCom endpoints live under
// (the missing suffix was one of the two reply-back gaps fixed in this change).
const DEFAULT_API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin';

// Realistic WeCom self-built-app credentials (corpId / agentId / callback token / app secret).
const CORP_ID = 'ww8f1a2b3c4d5e6f70';
const AGENT_ID = '1000002';
const TOKEN = 'choco-wecom-callback-7Hq2';
const SECRET = 'Xk9aQ3mZ7pL1rT8vN6wYbC4dE2fG0hJ5kU';
const CUSTOM_API_BASE = 'https://qyapi.weixin.qq.com.proxy.internal/cgi-bin';

let dir: string;
let filePath: string;
let store: WeChatConfigStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'choco-wechat-edge-'));
  filePath = join(dir, 'wechat.json');
  store = new WeChatConfigStore(filePath);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function injectApp(injectStore: WeChatConfigStore): BuiltApp {
  return buildApp({
    db: new Database(':memory:'),
    agentServices: { 'claude-opus': new FakeAgentService([]) },
    wechatConfigStore: injectStore,
  });
}

describe('WeChatConfigStore.resolveAdapterCreds — gating on each missing piece (edge)', () => {
  it('returns null when complete but DISABLED', () => {
    store.set({ corpId: CORP_ID, agentId: AGENT_ID, token: TOKEN, secret: SECRET, enabled: false });
    expect(store.resolveAdapterCreds()).toBeNull();
    expect(store.getView().ready).toBe(false);
  });

  it('returns null when enabled but corpId is MISSING', () => {
    store.set({ agentId: AGENT_ID, token: TOKEN, secret: SECRET, enabled: true });
    expect(store.resolveAdapterCreds()).toBeNull();
    expect(store.getView().ready).toBe(false);
  });

  it('returns null when enabled but agentId is MISSING (new gate — message/send needs it)', () => {
    // The reply-back fix made agentId REQUIRED: without it, message/send is rejected
    // by WeCom (errcode 92000), so the adapter must NOT be wired. corpId/token/secret
    // are all present here — only agentId is absent.
    store.set({ corpId: CORP_ID, token: TOKEN, secret: SECRET, enabled: true });
    expect(store.getView().hasSecret).toBe(true); // everything else IS present
    expect(store.resolveAdapterCreds()).toBeNull(); // ...but agentId gate blocks wiring
    expect(store.getView().ready).toBe(false);
  });

  it('returns null when enabled but token is MISSING', () => {
    store.set({ corpId: CORP_ID, agentId: AGENT_ID, secret: SECRET, enabled: true });
    expect(store.resolveAdapterCreds()).toBeNull();
    expect(store.getView().ready).toBe(false);
  });

  it('returns null when enabled but secret is MISSING', () => {
    store.set({ corpId: CORP_ID, agentId: AGENT_ID, token: TOKEN, enabled: true });
    expect(store.resolveAdapterCreds()).toBeNull();
    expect(store.getView().hasSecret).toBe(false);
    expect(store.getView().ready).toBe(false);
  });

  it('returns the full creds ONLY when all five are present + enabled', () => {
    store.set({ corpId: CORP_ID, agentId: AGENT_ID, token: TOKEN, secret: SECRET, enabled: true });
    expect(store.resolveAdapterCreds()).toEqual({
      corpId: CORP_ID,
      agentId: AGENT_ID,
      secret: SECRET,
      token: TOKEN,
      apiBase: DEFAULT_API_BASE,
    });
    expect(store.getView().ready).toBe(true);
  });
});

describe('WeChatConfigStore.set — patch semantics (edge)', () => {
  it('set({secret:""}) CLEARS the secret (hasSecret→false, resolveAdapterCreds→null)', () => {
    store.set({ corpId: CORP_ID, agentId: AGENT_ID, token: TOKEN, secret: SECRET, enabled: true });
    expect(store.getView().hasSecret).toBe(true);
    expect(store.resolveAdapterCreds()).not.toBeNull();

    const cleared = store.set({ secret: '' });
    expect(cleared.hasSecret).toBe(false);
    expect(cleared.ready).toBe(false);
    expect(store.resolveAdapterCreds()).toBeNull();
    // corpId/agentId/token/enabled were NOT touched by the secret-clear.
    expect(cleared.corpId).toBe(CORP_ID);
    expect(cleared.agentId).toBe(AGENT_ID);
    expect(cleared.token).toBe(TOKEN);
    expect(cleared.enabled).toBe(true);
  });

  it('set({corpId}) leaves agentId + token + secret intact (partial patch)', () => {
    store.set({ corpId: CORP_ID, agentId: AGENT_ID, token: TOKEN, secret: SECRET, enabled: true });
    const view = store.set({ corpId: 'ww0000replaced0000' });
    expect(view.corpId).toBe('ww0000replaced0000');
    expect(view.agentId).toBe(AGENT_ID); // untouched
    expect(view.token).toBe(TOKEN); // untouched
    expect(view.hasSecret).toBe(true); // secret untouched (still usable)
    expect(store.resolveAdapterCreds()).toEqual({
      corpId: 'ww0000replaced0000',
      agentId: AGENT_ID,
      secret: SECRET,
      token: TOKEN,
      apiBase: DEFAULT_API_BASE,
    });
  });

  it('empty apiBase falls back to the qyapi /cgi-bin default', () => {
    const view = store.set({ corpId: CORP_ID, agentId: AGENT_ID, token: TOKEN, secret: SECRET, apiBase: '', enabled: true });
    expect(view.apiBase).toBe(DEFAULT_API_BASE);
    expect(store.resolveAdapterCreds()?.apiBase).toBe(DEFAULT_API_BASE);
  });

  it('a non-empty apiBase is preserved verbatim', () => {
    const view = store.set({ corpId: CORP_ID, agentId: AGENT_ID, token: TOKEN, secret: SECRET, apiBase: CUSTOM_API_BASE, enabled: true });
    expect(view.apiBase).toBe(CUSTOM_API_BASE);
    expect(store.resolveAdapterCreds()?.apiBase).toBe(CUSTOM_API_BASE);
  });
});

describe('WeChatConfigStore — persistence across instances (edge)', () => {
  it('a SECOND store over the SAME path sees what the first set (incl. a usable secret)', () => {
    store.set({ corpId: CORP_ID, agentId: AGENT_ID, token: TOKEN, secret: SECRET, enabled: true });

    const reopened = new WeChatConfigStore(filePath);
    const view = reopened.getView();
    expect(view.corpId).toBe(CORP_ID);
    expect(view.agentId).toBe(AGENT_ID);
    expect(view.token).toBe(TOKEN);
    expect(view.hasSecret).toBe(true);
    expect(view.ready).toBe(true);
    // The secret persisted on disk is recoverable for wiring (not just the flag).
    expect(reopened.resolveAdapterCreds()).toEqual({
      corpId: CORP_ID,
      agentId: AGENT_ID,
      secret: SECRET,
      token: TOKEN,
      apiBase: DEFAULT_API_BASE,
    });
  });

  it('reads fail-open: a corrupt on-disk file yields empty defaults, not a throw', () => {
    writeFileSync(filePath, '{ this is not valid json', 'utf-8');
    const view = store.getView();
    expect(view.corpId).toBe('');
    expect(view.token).toBe('');
    expect(view.hasSecret).toBe(false);
    expect(view.apiBase).toBe(DEFAULT_API_BASE);
    expect(view.ready).toBe(false);
    expect(store.resolveAdapterCreds()).toBeNull();
  });
});

describe('GET /api/adapters/wechat/config — secret never leaks (adversarial)', () => {
  it('the masked view body NEVER contains the secret string and exposes no `secret` field', async () => {
    store.set({ corpId: CORP_ID, agentId: AGENT_ID, token: TOKEN, secret: SECRET, enabled: true });
    const app = injectApp(store);

    const res = await app.api.inject({ method: 'GET', url: '/api/adapters/wechat/config' });
    expect(res.statusCode).toBe(200);
    // The raw response text must not carry the secret anywhere.
    expect(res.body).not.toContain(SECRET);
    const view = res.json().config as Record<string, unknown>;
    expect(view.hasSecret).toBe(true);
    expect(view.secret).toBeUndefined();
    expect('secret' in view).toBe(false);

    await app.close();
  });

  it('a PUT that sets the secret echoes a masked view, never the secret value', async () => {
    const app = injectApp(store);
    const res = await app.api.inject({
      method: 'PUT',
      url: '/api/adapters/wechat/config',
      payload: { corpId: CORP_ID, agentId: AGENT_ID, token: TOKEN, secret: SECRET, enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect(res.json().config.ready).toBe(true);
    expect((res.json().config as Record<string, unknown>).secret).toBeUndefined();
    await app.close();
  });
});

describe('PUT /api/adapters/wechat/config — zod rejects malformed bodies (adversarial)', () => {
  it('{ enabled: "yes" } (string for boolean) → 400 invalid_params', async () => {
    const app = injectApp(store);
    const res = await app.api.inject({
      method: 'PUT',
      url: '/api/adapters/wechat/config',
      payload: { enabled: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_params');
    await app.close();
  });

  it('{ corpId: 123 } (number for string) → 400 invalid_params', async () => {
    const app = injectApp(store);
    const res = await app.api.inject({
      method: 'PUT',
      url: '/api/adapters/wechat/config',
      payload: { corpId: 123 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_params');
    // The rejected body must not have mutated the store.
    expect(store.getView().corpId).toBe('');
    await app.close();
  });
});

describe('wireWeChatAdapter — operability gate (edge + adversarial)', () => {
  it('disabled store → wire returns false and the webhook route stays 404', async () => {
    store.set({ corpId: CORP_ID, token: TOKEN, secret: SECRET, enabled: false });
    const app = injectApp(store);
    const wired = await wireWeChatAdapter({
      api: app.api,
      submitPlatformMessage: app.submitPlatformMessage,
      store,
    });
    expect(wired).toBe(false);
    const res = await app.api.inject({ method: 'GET', url: WEBHOOK });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('incomplete store (no secret) → wire returns false, webhook stays 404', async () => {
    store.set({ corpId: CORP_ID, token: TOKEN, enabled: true });
    const app = injectApp(store);
    const wired = await wireWeChatAdapter({
      api: app.api,
      submitPlatformMessage: app.submitPlatformMessage,
      store,
    });
    expect(wired).toBe(false);
    const res = await app.api.inject({ method: 'GET', url: WEBHOOK });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('complete + enabled → wire returns true; GET valid-sig echoes, wrong-sig → 401', async () => {
    store.set({ corpId: CORP_ID, agentId: AGENT_ID, token: TOKEN, secret: SECRET, enabled: true });
    const app = injectApp(store);
    const wired = await wireWeChatAdapter({
      api: app.api,
      submitPlatformMessage: app.submitPlatformMessage,
      store,
    });
    expect(wired).toBe(true);

    const ts = '1717398000';
    const nonce = 'qa-nonce-04f7';
    const echo = 'wecom-url-verify-echo-9182';
    const valid = computeSignature(TOKEN, ts, nonce, echo);

    const ok = await app.api.inject({
      method: 'GET',
      url: `${WEBHOOK}?signature=${valid}&timestamp=${ts}&nonce=${nonce}&echostr=${echo}`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe(echo);

    // A tampered signature (right shape, wrong digest) must be rejected.
    const wrong = await app.api.inject({
      method: 'GET',
      url: `${WEBHOOK}?signature=${'0'.repeat(40)}&timestamp=${ts}&nonce=${nonce}&echostr=${echo}`,
    });
    expect(wrong.statusCode).toBe(401);

    await app.close();
  });

  it('POST webhook with a WRONG signature → 401 (inbound message rejected)', async () => {
    store.set({ corpId: CORP_ID, agentId: AGENT_ID, token: TOKEN, secret: SECRET, enabled: true });
    const app = injectApp(store);
    await wireWeChatAdapter({
      api: app.api,
      submitPlatformMessage: app.submitPlatformMessage,
      store,
    });

    const ts = '1717398123';
    const nonce = 'qa-nonce-post-aa12';
    const xml =
      '<xml><ToUserName><![CDATA[ww8f1a2b3c4d5e6f70]]></ToUserName>' +
      '<FromUserName><![CDATA[zhangsan]]></FromUserName>' +
      '<MsgType><![CDATA[text]]></MsgType>' +
      '<Content><![CDATA[@claude 帮我看下这个 PR]]></Content>' +
      '<MsgId>1234567890123456</MsgId></xml>';
    const badSig = computeSignature('the-wrong-token', ts, nonce, xml);

    const res = await app.api.inject({
      method: 'POST',
      url: `${WEBHOOK}?signature=${badSig}&timestamp=${ts}&nonce=${nonce}`,
      headers: { 'content-type': 'text/xml' },
      payload: xml,
    });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it('the FIRST wire registers the webhook routes (single registration is the supported path)', async () => {
    // PRODUCT NOTE (QA finding): the adapter's registerWebhook guards only the XML
    // content-type PARSERS against re-registration (try/catch) — NOT the GET/POST
    // ROUTES. The code comment at wechat-adapter.ts:217-220 claims double-registration
    // is "idempotent if the api is shared / re-wired", but a SECOND createWeChatAdapter
    // on the same Fastify instance throws FST_ERR_DUPLICATED_ROUTE (asserted below).
    // The production composition root (main.ts) wires exactly ONCE before listen, so
    // this is not a live path; this test pins the supported single-wire contract.
    store.set({ corpId: CORP_ID, agentId: AGENT_ID, token: TOKEN, secret: SECRET, enabled: true });
    const app = injectApp(store);
    const first = await wireWeChatAdapter({
      api: app.api,
      submitPlatformMessage: app.submitPlatformMessage,
      store,
    });
    expect(first).toBe(true);

    // The webhook is live after the single wire.
    const ts = '1717399000';
    const nonce = 'single-wire-nonce-7c';
    const echo = 'live-after-single-wire';
    const valid = computeSignature(TOKEN, ts, nonce, echo);
    const ok = await app.api.inject({
      method: 'GET',
      url: `${WEBHOOK}?signature=${valid}&timestamp=${ts}&nonce=${nonce}&echostr=${echo}`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe(echo);

    await app.close();
  });

  it('ADVERSARIAL: a SECOND wire on the SAME api throws FST_ERR_DUPLICATED_ROUTE (routes are NOT guarded — product gap)', async () => {
    // The route registration (api.get/api.post WEBHOOK) is unguarded, so re-wiring the
    // shared Fastify instance rejects. We pin the ACTUAL behavior rather than the
    // comment's claimed idempotence. See the product note above.
    store.set({ corpId: CORP_ID, agentId: AGENT_ID, token: TOKEN, secret: SECRET, enabled: true });
    const app = injectApp(store);
    await wireWeChatAdapter({
      api: app.api,
      submitPlatformMessage: app.submitPlatformMessage,
      store,
    });

    await expect(
      wireWeChatAdapter({
        api: app.api,
        submitPlatformMessage: app.submitPlatformMessage,
        store,
      }),
    ).rejects.toThrow(/already declared|FST_ERR_DUPLICATED_ROUTE/);

    await app.close();
  });
});
