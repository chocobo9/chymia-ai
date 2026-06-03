// tests/api/trust-routes.edge.test.ts — M8 QA (dev≠QA): the EDGE + ADVERSARIAL
// half of the browser-facing workspace-trust surface (GET/POST /api/trust). The
// dev file covers GET-untrusted → grant → persisted + the no-workspace
// short-circuit; this file gates everything around it: zod 400s on bad bodies,
// the decline (not-persisted) path, the adversarial proof that a grant actually
// MUTATES process.env (gemini's headless auto-approve), cross-instance
// persistence (trust survives a "restart"), idempotent double-grant, and
// per-workspace independence.
//
// Reuses the dev file's hermetic setup exactly: an isolated CHOCO_TRUST_STORE
// under the OS temp dir (real data/ untouched) + a save/restore of both
// CHOCO_TRUST_STORE and GEMINI_CLI_TRUST_WORKSPACE so neither leaks between
// tests. Inject-only (no listener).
//
// dev≠QA: authored by the M8 QA instance; no product code modified.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { TRUST_STORE_ENV, GEMINI_TRUST_ENV_KEY } from '@choco/api/runtime/workspace-trust';

let workDir: string;
let storeDir: string;
let storeFile: string;
let savedStoreEnv: string | undefined;
let savedGeminiEnv: string | undefined;

beforeEach(() => {
  // Isolate the trust store + workspace per test (hermetic; real data/ untouched).
  storeDir = mkdtempSync(join(tmpdir(), 'choco-trust-store-'));
  workDir = mkdtempSync(join(tmpdir(), 'choco-ws-'));
  storeFile = join(storeDir, 'trusted-workspaces.json');
  savedStoreEnv = process.env[TRUST_STORE_ENV];
  savedGeminiEnv = process.env[GEMINI_TRUST_ENV_KEY];
  process.env[TRUST_STORE_ENV] = storeFile;
  // Start each test with the trust env CLEARED so an adversarial assert that a
  // grant SETS it is honest (not a leftover from a prior test or the real env).
  delete process.env[GEMINI_TRUST_ENV_KEY];
});

afterEach(() => {
  if (savedStoreEnv === undefined) delete process.env[TRUST_STORE_ENV];
  else process.env[TRUST_STORE_ENV] = savedStoreEnv;
  if (savedGeminiEnv === undefined) delete process.env[GEMINI_TRUST_ENV_KEY];
  else process.env[GEMINI_TRUST_ENV_KEY] = savedGeminiEnv;
  rmSync(storeDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

function injectApp(workspace: string | undefined): BuiltApp {
  const db = new Database(':memory:');
  const fakes = { 'claude-opus': new FakeAgentService([]) };
  return buildApp(
    workspace === undefined
      ? { db, agentServices: fakes }
      : { db, agentServices: fakes, defaultWorkspace: workspace },
  );
}

describe('POST /api/trust — body validation (edge)', () => {
  it('rejects a missing body with 400 invalid_params', async () => {
    const app = injectApp(workDir);

    const res = await app.api.inject({ method: 'POST', url: '/api/trust' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_params' });

    await app.close();
  });

  it('rejects an empty-object body (no trust field) with 400 invalid_params', async () => {
    const app = injectApp(workDir);

    const res = await app.api.inject({ method: 'POST', url: '/api/trust', payload: {} });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_params' });

    await app.close();
  });

  it('rejects a non-boolean trust ("yes" string) with 400 invalid_params', async () => {
    const app = injectApp(workDir);

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/trust',
      payload: { trust: 'yes' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_params' });

    await app.close();
  });

  it('rejects a numeric trust (1) with 400 invalid_params — must be a real boolean', async () => {
    const app = injectApp(workDir);

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/trust',
      payload: { trust: 1 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_params' });

    await app.close();
  });

  it('does NOT mutate the trust env when the body is rejected (no side effect on a 400)', async () => {
    const app = injectApp(workDir);

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/trust',
      payload: { trust: 'yes' },
    });

    expect(res.statusCode).toBe(400);
    // A rejected request must never set gemini's trust env — only a real grant does.
    expect(process.env[GEMINI_TRUST_ENV_KEY]).toBeUndefined();

    await app.close();
  });
});

describe('POST /api/trust — decline path (edge)', () => {
  it('leaves the workspace untrusted and does NOT persist trust when trust:false', async () => {
    const app = injectApp(workDir);

    const decline = await app.api.inject({
      method: 'POST',
      url: '/api/trust',
      payload: { trust: false },
    });
    expect(decline.statusCode).toBe(200);
    expect(decline.json()).toEqual({ workspace: workDir, trusted: false });

    // A follow-up GET still reports untrusted — declining wrote nothing.
    const after = await app.api.inject({ method: 'GET', url: '/api/trust' });
    expect(after.json()).toEqual({ workspace: workDir, trusted: false });

    await app.close();
  });

  it('does NOT set gemini\'s trust env on a decline (restricted run keeps it off)', async () => {
    const app = injectApp(workDir);

    await app.api.inject({ method: 'POST', url: '/api/trust', payload: { trust: false } });

    expect(process.env[GEMINI_TRUST_ENV_KEY]).toBeUndefined();

    await app.close();
  });
});

describe('POST /api/trust — grant side effects (adversarial)', () => {
  it('sets process.env.GEMINI_CLI_TRUST_WORKSPACE="true" so the next agent spawn inherits trust', async () => {
    const app = injectApp(workDir);

    // Precondition: cleared in beforeEach — prove the grant is what sets it.
    expect(process.env[GEMINI_TRUST_ENV_KEY]).toBeUndefined();

    const grant = await app.api.inject({
      method: 'POST',
      url: '/api/trust',
      payload: { trust: true },
    });
    expect(grant.statusCode).toBe(200);
    expect(grant.json()).toEqual({ workspace: workDir, trusted: true });

    // The actual ADVERSARIAL assertion: the live process env was mutated.
    expect(process.env[GEMINI_TRUST_ENV_KEY]).toBe('true');

    await app.close();
  });

  it('persists trust across a SEPARATE app instance over the same store + workspace (survives a restart)', async () => {
    // App A grants — writes the shared CHOCO_TRUST_STORE file.
    const appA = injectApp(workDir);
    const grant = await appA.api.inject({
      method: 'POST',
      url: '/api/trust',
      payload: { trust: true },
    });
    expect(grant.json()).toEqual({ workspace: workDir, trusted: true });
    await appA.close();

    // App B is a brand-new instance (a "restart") over the SAME store path + the
    // SAME workspace — its first GET must already report trusted from disk.
    const appB = injectApp(workDir);
    const status = await appB.api.inject({ method: 'GET', url: '/api/trust' });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ workspace: workDir, trusted: true });

    await appB.close();
  });

  it('is idempotent: a double-grant still reports trusted with no error', async () => {
    const app = injectApp(workDir);

    const first = await app.api.inject({ method: 'POST', url: '/api/trust', payload: { trust: true } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ workspace: workDir, trusted: true });

    const second = await app.api.inject({ method: 'POST', url: '/api/trust', payload: { trust: true } });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ workspace: workDir, trusted: true });

    // Still trusted after the redundant grant (no corruption / flip-back).
    const after = await app.api.inject({ method: 'GET', url: '/api/trust' });
    expect(after.json()).toEqual({ workspace: workDir, trusted: true });

    await app.close();
  });
});

describe('GET/POST /api/trust — per-workspace isolation (adversarial)', () => {
  it('trusting workspace A does NOT trust a DIFFERENT workspace B over the same store', async () => {
    const workDirB = mkdtempSync(join(tmpdir(), 'choco-ws-b-'));
    try {
      // Grant trust to A only.
      const appA = injectApp(workDir);
      const grant = await appA.api.inject({ method: 'POST', url: '/api/trust', payload: { trust: true } });
      expect(grant.json()).toEqual({ workspace: workDir, trusted: true });
      await appA.close();

      // A fresh app pointed at workspace B (same store file) must still be untrusted —
      // trust is per-directory, granting /ws/a never leaks to /ws/b.
      const appB = injectApp(workDirB);
      const statusB = await appB.api.inject({ method: 'GET', url: '/api/trust' });
      expect(statusB.json()).toEqual({ workspace: workDirB, trusted: false });
      await appB.close();
    } finally {
      rmSync(workDirB, { recursive: true, force: true });
    }
  });
});
