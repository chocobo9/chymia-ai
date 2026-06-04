// M-FEISHU 飞书 manager + config routes — EDGE + ADVERSARIAL gate (independent QA, dev≠QA §0.5.3).
//
// The dev shipped FeishuManager (config-driven connect/disconnect of the WS adapter) +
// the GET/PUT/status routes, with a happy connect/disconnect proof in feishu-wiring.test.ts.
// This file is the reconcile-edge + secret-discipline + zod-400 gate: every INCOMPLETE
// config (no appId / no secret / disabled) must NOT start the adapter; disabling after
// enabling must stop it; an adapter start() that THROWS must be swallowed → connected:false;
// autoStart from a pre-seeded complete store must connect; the app_secret must NEVER appear
// in ANY response body; bad PUT bodies must 400. A fake adapterFactory records start/stop —
// no real WebSocket is ever opened. NO product code modified (tests/ only).
//
// Distribution (this file): happy ≤50%, edge ≥30%, adversarial ≥20%.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildApp, type BuiltApp, type BuildAppOverrides } from '@choco/api/app-factory';
import { FeishuConfigStore } from '@choco/api/config/feishu-config-store';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

const REAL_APP_ID = 'cli_a1b2c3d4e5f60718';
const REAL_SECRET = 'kP9rXq2Lm7Bc4Df1Gh5Jk8Np0Qr6St3'; // never expected in any response body

interface FactoryRecord {
  starts: number;
  stops: number;
  /** Throw on start() to simulate a WS handshake failure. */
  throwOnStart: boolean;
}

/** A fake adapter factory recording start/stop; isConnected mirrors a successful start. */
function makeFactory(rec: FactoryRecord): NonNullable<BuildAppOverrides['feishuAdapterFactory']> {
  return () => {
    let connected = false;
    return {
      start: async () => {
        rec.starts += 1;
        if (rec.throwOnStart) throw new Error('feishu WS handshake failed (invalid app_secret)');
        connected = true;
      },
      stop: async () => {
        rec.stops += 1;
        connected = false;
      },
      get isConnected() {
        return connected;
      },
    };
  };
}

describe('FeishuManager.applyConfig — reconcile against the config (happy + edge)', () => {
  let dir: string;
  let store: FeishuConfigStore;
  let rec: FactoryRecord;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'choco-feishu-edge-'));
    store = new FeishuConfigStore(join(dir, 'feishu.json'));
    rec = { starts: 0, stops: 0, throwOnStart: false };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function buildManagerApp(): BuiltApp {
    return buildApp({
      db: new Database(':memory:'),
      agentServices: { 'claude-opus': new FakeAgentService([]) },
      feishuStore: store,
      feishuAdapterFactory: makeFactory(rec),
    });
  }

  it('[happy] enabled + complete (appId + secret) → adapter started, status connected', async () => {
    const app = buildManagerApp();
    await app.feishuManager.applyConfig({ appId: REAL_APP_ID, appSecret: REAL_SECRET, enabled: true });

    expect(rec.starts).toBe(1);
    expect(app.feishuManager.status()).toEqual({ connected: true, ready: true });
    await app.close();
  });

  it('[edge] enabled but NO appId → not started, not connected', async () => {
    const app = buildManagerApp();
    await app.feishuManager.applyConfig({ appSecret: REAL_SECRET, enabled: true });

    expect(rec.starts).toBe(0);
    expect(app.feishuManager.status().connected).toBe(false);
    expect(app.feishuManager.status().ready).toBe(false);
    await app.close();
  });

  it('[edge] enabled + appId but NO secret → not started, not connected', async () => {
    const app = buildManagerApp();
    await app.feishuManager.applyConfig({ appId: REAL_APP_ID, enabled: true });

    expect(rec.starts).toBe(0);
    expect(app.feishuManager.status().connected).toBe(false);
    await app.close();
  });

  it('[edge] complete creds but disabled → not started, not connected', async () => {
    const app = buildManagerApp();
    await app.feishuManager.applyConfig({ appId: REAL_APP_ID, appSecret: REAL_SECRET, enabled: false });

    expect(rec.starts).toBe(0);
    expect(app.feishuManager.status().connected).toBe(false);
    await app.close();
  });

  it('[edge] disabling AFTER enabling stops the adapter and disconnects', async () => {
    const app = buildManagerApp();
    await app.feishuManager.applyConfig({ appId: REAL_APP_ID, appSecret: REAL_SECRET, enabled: true });
    expect(app.feishuManager.status().connected).toBe(true);

    await app.feishuManager.applyConfig({ enabled: false });

    expect(rec.stops).toBeGreaterThanOrEqual(1);
    expect(app.feishuManager.status().connected).toBe(false);
    await app.close();
  });

  it('[adversarial] an adapter whose start() THROWS leaves status connected:false (error swallowed, no crash)', async () => {
    rec.throwOnStart = true;
    const app = buildManagerApp();

    // applyConfig must resolve even though start() throws.
    await expect(
      app.feishuManager.applyConfig({ appId: REAL_APP_ID, appSecret: REAL_SECRET, enabled: true }),
    ).resolves.toBeDefined();

    expect(rec.starts).toBe(1); // it tried
    expect(app.feishuManager.status().connected).toBe(false); // but failed cleanly
    await app.close();
  });
});

describe('FeishuManager.autoStart — reconnect a persisted config at boot (edge)', () => {
  let dir: string;
  let store: FeishuConfigStore;
  let rec: FactoryRecord;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'choco-feishu-boot-'));
    store = new FeishuConfigStore(join(dir, 'feishu.json'));
    rec = { starts: 0, stops: 0, throwOnStart: false };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('[edge] autoStart with a pre-seeded complete + enabled store connects', async () => {
    // Pre-seed the store file (as if a prior session had saved a complete config).
    writeFileSync(
      join(dir, 'feishu.json'),
      JSON.stringify({ appId: REAL_APP_ID, appSecret: REAL_SECRET, enabled: true }),
    );

    const app = buildApp({
      db: new Database(':memory:'),
      agentServices: { 'claude-opus': new FakeAgentService([]) },
      feishuStore: store,
      feishuAdapterFactory: makeFactory(rec),
    });

    await app.feishuManager.autoStart();

    expect(rec.starts).toBe(1);
    expect(app.feishuManager.status().connected).toBe(true);
    await app.close();
  });

  it('[edge] autoStart with a disabled persisted config does NOT connect', async () => {
    writeFileSync(
      join(dir, 'feishu.json'),
      JSON.stringify({ appId: REAL_APP_ID, appSecret: REAL_SECRET, enabled: false }),
    );
    const app = buildApp({
      db: new Database(':memory:'),
      agentServices: { 'claude-opus': new FakeAgentService([]) },
      feishuStore: store,
      feishuAdapterFactory: makeFactory(rec),
    });

    await app.feishuManager.autoStart();

    expect(rec.starts).toBe(0);
    expect(app.feishuManager.status().connected).toBe(false);
    await app.close();
  });
});

describe('Feishu config routes — secret discipline + zod-400 (edge + adversarial)', () => {
  let dir: string;
  let store: FeishuConfigStore;
  let rec: FactoryRecord;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'choco-feishu-routes-'));
    store = new FeishuConfigStore(join(dir, 'feishu.json'));
    rec = { starts: 0, stops: 0, throwOnStart: false };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function injectApp(): BuiltApp {
    return buildApp({
      db: new Database(':memory:'),
      agentServices: { 'claude-opus': new FakeAgentService([]) },
      feishuStore: store,
      feishuAdapterFactory: makeFactory(rec),
    });
  }

  it('[adversarial] the app_secret NEVER appears in the GET, PUT, or status response bodies', async () => {
    const app = injectApp();

    const put = await app.api.inject({
      method: 'PUT',
      url: '/api/adapters/feishu/config',
      payload: { appId: REAL_APP_ID, appSecret: REAL_SECRET, enabled: true },
    });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain(REAL_SECRET);
    // The masked view exposes presence only.
    expect(put.json().config).toMatchObject({ appId: REAL_APP_ID, hasAppSecret: true, ready: true });
    expect(put.json().config).not.toHaveProperty('appSecret');

    const get = await app.api.inject({ method: 'GET', url: '/api/adapters/feishu/config' });
    expect(get.body).not.toContain(REAL_SECRET);
    expect(get.json().config).not.toHaveProperty('appSecret');

    const status = await app.api.inject({ method: 'GET', url: '/api/adapters/feishu/status' });
    expect(status.body).not.toContain(REAL_SECRET);
    expect(status.json()).toEqual({ connected: true, ready: true });

    await app.close();
  });

  it('[adversarial] PUT with enabled:"yes" (string, not boolean) → 400 and the adapter is not touched', async () => {
    const app = injectApp();
    const res = await app.api.inject({
      method: 'PUT',
      url: '/api/adapters/feishu/config',
      payload: { appId: REAL_APP_ID, enabled: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    expect(rec.starts).toBe(0);
    await app.close();
  });

  it('[adversarial] PUT with appId:123 (number, not string) → 400', async () => {
    const app = injectApp();
    const res = await app.api.inject({
      method: 'PUT',
      url: '/api/adapters/feishu/config',
      payload: { appId: 123 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('[edge] a clearing PUT (empty appSecret) wipes the stored secret → hasAppSecret false, disconnected', async () => {
    const app = injectApp();
    // First configure + connect.
    await app.api.inject({
      method: 'PUT',
      url: '/api/adapters/feishu/config',
      payload: { appId: REAL_APP_ID, appSecret: REAL_SECRET, enabled: true },
    });
    expect(app.feishuManager.status().connected).toBe(true);

    // Now clear the secret (empty string) — creds become incomplete → disconnect.
    const cleared = await app.api.inject({
      method: 'PUT',
      url: '/api/adapters/feishu/config',
      payload: { appSecret: '' },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().config).toMatchObject({ hasAppSecret: false, ready: false });
    expect(cleared.json().status.connected).toBe(false);
    await app.close();
  });
});
