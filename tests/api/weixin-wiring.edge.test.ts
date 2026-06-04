// tests/api/weixin-wiring.edge.test.ts — M14b manager + routes EDGE + ADVERSARIAL gate.
// Authored by the INDEPENDENT QA instance (dev≠QA, §0.5.3). The dev proved the confirmed
// login→poll→reply chain (weixin-wiring.test.ts); this file gates the NEGATIVE + security
// paths through the real Fastify routes + WeixinManager (buildApp with a fake fetch + a
// temp token store): a non-confirmed status never persists a token nor connects; the
// bot_token NEVER appears in any /login/status or /status response (adversarial body
// scan); missing qrPayload → 400; a failing get_bot_qrcode → 502; logout clears the
// token + disconnects; autoStart() reconnects iff a token is pre-seeded. NO product code
// modified (tests/ only). Every test ends the poll loop in afterEach.
//
// Distribution (this file): happy ≤50%, edge ≥30%, adversarial ≥20%.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { WeixinTokenStore } from '@choco/api/config/weixin-token-store';
import { replyScript, CLAUDE } from './helpers.js';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
}
function httpFail(status: number): Response {
  return new Response('upstream down', { status });
}

/** The bot_token that a confirmed scan would mint — used to scan response bodies for leaks. */
const SECRET_BOT_TOKEN = 'ilbt_SECRET_must_never_leak_8f3a2c91';

interface FetchScenario {
  /** What get_qrcode_status returns (controls login outcome). */
  readonly statusBody: unknown;
  /** When true, get_bot_qrcode fails with a 502 (login/start error path). */
  readonly qrFails?: boolean;
}

/**
 * A deterministic offline iLink gateway. get_bot_qrcode mints a QR (or fails),
 * get_qrcode_status returns the scenario's outcome, getupdates idles, sendmessage 200s.
 */
function makeFetch(scenario: FetchScenario): typeof globalThis.fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    if (url.includes('get_bot_qrcode')) {
      if (scenario.qrFails === true) return httpFail(502);
      return jsonResponse({ ret: 0, qrcode: 'QP_edge', qrcode_img_content: 'https://liteapp/q/e?qrcode=QP_edge' });
    }
    if (url.includes('get_qrcode_status')) return jsonResponse(scenario.statusBody);
    if (url.includes('getupdates')) {
      await new Promise((r) => setTimeout(r, 40));
      return jsonResponse({ ret: 0, get_updates_buf: 'c0', msgs: [] });
    }
    return jsonResponse({ ret: 0 });
  }) as typeof globalThis.fetch;
}

/** Build an app whose weixin manager uses `fetchFn` + the temp `tokenStore`. */
function makeApp(fetchFn: typeof globalThis.fetch, tokenStore: WeixinTokenStore): BuiltApp {
  return buildApp({
    db: new Database(':memory:'),
    agentServices: { 'claude-opus': new FakeAgentService([replyScript(CLAUDE, '已收到。')]) },
    weixinFetchFn: fetchFn,
    weixinTokenStore: tokenStore,
  });
}

describe('weixin routes — non-confirmed login does NOT connect or persist (edge + adversarial)', () => {
  let dir: string;
  let tokenStore: WeixinTokenStore;
  let app: BuiltApp;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'choco-weixin-edge-'));
    tokenStore = new WeixinTokenStore(join(dir, 'weixin-bot.json'));
  });
  afterEach(async () => {
    await app.weixinManager.logout();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('[edge] a WAITING status does not persist a token and leaves the adapter disconnected', async () => {
    app = makeApp(makeFetch({ statusBody: { ret: 0, status: 'wait' } }), tokenStore);

    const status = await app.api.inject({ method: 'GET', url: '/api/adapters/weixin/login/status?qrPayload=QP_edge' });
    expect(status.json().status).toBe('waiting');

    expect(tokenStore.get()).toBeUndefined();
    const conn = await app.api.inject({ method: 'GET', url: '/api/adapters/weixin/status' });
    expect(conn.json()).toMatchObject({ connected: false, hasToken: false });
  });

  it('[edge] an EXPIRED status does not persist a token and stays disconnected', async () => {
    app = makeApp(makeFetch({ statusBody: { ret: 0, status: 'expired' } }), tokenStore);

    const status = await app.api.inject({ method: 'GET', url: '/api/adapters/weixin/login/status?qrPayload=QP_edge' });
    expect(status.json().status).toBe('expired');
    expect(tokenStore.get()).toBeUndefined();
    expect((await app.api.inject({ method: 'GET', url: '/api/adapters/weixin/status' })).json()).toMatchObject({ connected: false });
  });

  it('[adversarial] an ERROR status (errcode) surfaces status:error with a message but persists NO token', async () => {
    app = makeApp(makeFetch({ statusBody: { errcode: -1, errmsg: 'qrcode revoked' } }), tokenStore);

    const status = await app.api.inject({ method: 'GET', url: '/api/adapters/weixin/login/status?qrPayload=QP_edge' });
    expect(status.json().status).toBe('error');
    expect(tokenStore.get()).toBeUndefined();
    expect((await app.api.inject({ method: 'GET', url: '/api/adapters/weixin/status' })).json()).toMatchObject({
      connected: false,
      hasToken: false,
    });
  });
});

describe('weixin routes — the bot_token NEVER crosses the API boundary (adversarial)', () => {
  let dir: string;
  let tokenStore: WeixinTokenStore;
  let app: BuiltApp;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'choco-weixin-leak-'));
    tokenStore = new WeixinTokenStore(join(dir, 'weixin-bot.json'));
  });
  afterEach(async () => {
    await app.weixinManager.logout();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('[adversarial] a CONFIRMED /login/status response body never contains the bot_token (only {status:"confirmed"})', async () => {
    // Arrange — a confirmed scan mints SECRET_BOT_TOKEN server-side; the route must
    // persist it but return only the status string.
    app = makeApp(makeFetch({ statusBody: { ret: 0, status: 'confirmed', bot_token: SECRET_BOT_TOKEN } }), tokenStore);

    // Act
    const status = await app.api.inject({ method: 'GET', url: '/api/adapters/weixin/login/status?qrPayload=QP_edge' });

    // Assert — confirmed, server persisted the token, but the body is token-free.
    expect(status.json()).toEqual({ status: 'confirmed' });
    expect(status.body).not.toContain(SECRET_BOT_TOKEN);
    expect(tokenStore.get()).toBe(SECRET_BOT_TOKEN); // proves it WAS minted, just not echoed
  });

  it('[adversarial] after a confirmed login, GET /status reports connected:true but never echoes the token', async () => {
    app = makeApp(makeFetch({ statusBody: { ret: 0, status: 'confirmed', bot_token: SECRET_BOT_TOKEN } }), tokenStore);

    await app.api.inject({ method: 'GET', url: '/api/adapters/weixin/login/status?qrPayload=QP_edge' });
    const conn = await app.api.inject({ method: 'GET', url: '/api/adapters/weixin/status' });

    expect(conn.json()).toMatchObject({ connected: true, hasToken: true });
    expect(conn.body).not.toContain(SECRET_BOT_TOKEN);
  });
});

describe('weixin routes — request validation + transport failures (edge + adversarial)', () => {
  let dir: string;
  let tokenStore: WeixinTokenStore;
  let app: BuiltApp;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'choco-weixin-val-'));
    tokenStore = new WeixinTokenStore(join(dir, 'weixin-bot.json'));
  });
  afterEach(async () => {
    await app.weixinManager.logout();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('[edge] GET /login/status with a missing qrPayload → 400 invalid_params', async () => {
    app = makeApp(makeFetch({ statusBody: { ret: 0, status: 'wait' } }), tokenStore);

    const res = await app.api.inject({ method: 'GET', url: '/api/adapters/weixin/login/status' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_params' });
  });

  it('[adversarial] POST /login/start when get_bot_qrcode fails → 502 qr_unavailable (not a 500 crash)', async () => {
    app = makeApp(makeFetch({ statusBody: { ret: 0, status: 'wait' }, qrFails: true }), tokenStore);

    const res = await app.api.inject({ method: 'POST', url: '/api/adapters/weixin/login/start' });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'qr_unavailable' });
  });

  it('[edge] POST /login/start on a healthy gateway returns the QR to render + poll', async () => {
    app = makeApp(makeFetch({ statusBody: { ret: 0, status: 'wait' } }), tokenStore);

    const res = await app.api.inject({ method: 'POST', url: '/api/adapters/weixin/login/start' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ qrPayload: 'QP_edge', qrUrl: 'https://liteapp/q/e?qrcode=QP_edge' });
  });
});

describe('weixin routes — logout clears the session (edge)', () => {
  let dir: string;
  let tokenStore: WeixinTokenStore;
  let app: BuiltApp;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'choco-weixin-logout-'));
    tokenStore = new WeixinTokenStore(join(dir, 'weixin-bot.json'));
  });
  afterEach(async () => {
    await app.weixinManager.logout(); // idempotent — safe even after the test logs out
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('[edge] logout after a confirmed login disconnects and clears the persisted token', async () => {
    // Arrange — confirm a login so we are connected with a persisted token.
    app = makeApp(makeFetch({ statusBody: { ret: 0, status: 'confirmed', bot_token: SECRET_BOT_TOKEN } }), tokenStore);
    await app.api.inject({ method: 'GET', url: '/api/adapters/weixin/login/status?qrPayload=QP_edge' });
    expect(tokenStore.get()).toBe(SECRET_BOT_TOKEN);

    // Act — logout via the route.
    const out = await app.api.inject({ method: 'POST', url: '/api/adapters/weixin/logout' });
    expect(out.json()).toEqual({ ok: true });

    // Assert — disconnected + token gone from the store.
    expect(tokenStore.get()).toBeUndefined();
    expect((await app.api.inject({ method: 'GET', url: '/api/adapters/weixin/status' })).json()).toMatchObject({
      connected: false,
      hasToken: false,
    });
  });
});

describe('WeixinManager.autoStart — reconnect a persisted session (edge + adversarial)', () => {
  let dir: string;
  let tokenStore: WeixinTokenStore;
  let app: BuiltApp;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'choco-weixin-auto-'));
    tokenStore = new WeixinTokenStore(join(dir, 'weixin-bot.json'));
  });
  afterEach(async () => {
    await app.weixinManager.logout();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('[edge] autoStart() with a PRE-SEEDED token store starts the adapter connected', async () => {
    // Arrange — a token was persisted from a prior session BEFORE the app boots.
    tokenStore.set(SECRET_BOT_TOKEN);
    app = makeApp(makeFetch({ statusBody: { ret: 0, status: 'wait' } }), tokenStore);

    // Act — the composition root would call this after listen().
    app.weixinManager.autoStart();

    // Assert — reconnected without any QR scan.
    expect(app.weixinManager.status()).toMatchObject({ connected: true, hasToken: true });
  });

  it('[adversarial] autoStart() with NO persisted token is a no-op (stays disconnected, never polls)', async () => {
    app = makeApp(makeFetch({ statusBody: { ret: 0, status: 'wait' } }), tokenStore);

    app.weixinManager.autoStart();

    expect(app.weixinManager.status()).toMatchObject({ connected: false, hasToken: false });
  });
});
