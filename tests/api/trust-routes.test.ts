// tests/api/trust-routes.test.ts — M8 dev happy-path: the browser-facing
// workspace-trust surface (GET/POST /api/trust). The VSCode-style web trust gate
// reads/writes through these. Inject-only (no listener); an isolated trust-store
// file under the OS temp dir so the real data/ store is untouched.
//
// dev happy-path only (GET untrusted → POST grant → GET trusted-persisted +
// no-workspace short-circuit). Edge/adversarial (bad body 400, deny path, env
// application, cross-instance persistence) are the QA instance's (dev≠QA).

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
let savedStoreEnv: string | undefined;
let savedGeminiEnv: string | undefined;

beforeEach(() => {
  // Isolate the trust store + workspace per test (hermetic; real data/ untouched).
  storeDir = mkdtempSync(join(tmpdir(), 'choco-trust-store-'));
  workDir = mkdtempSync(join(tmpdir(), 'choco-ws-'));
  savedStoreEnv = process.env[TRUST_STORE_ENV];
  savedGeminiEnv = process.env[GEMINI_TRUST_ENV_KEY];
  process.env[TRUST_STORE_ENV] = join(storeDir, 'trusted-workspaces.json');
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

describe('GET/POST /api/trust (dev happy path)', () => {
  it('reports the configured workspace as untrusted, then trusted after a grant that persists', async () => {
    const app = injectApp(workDir);

    const before = await app.api.inject({ method: 'GET', url: '/api/trust' });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ workspace: workDir, trusted: false });

    const grant = await app.api.inject({
      method: 'POST',
      url: '/api/trust',
      payload: { trust: true },
    });
    expect(grant.statusCode).toBe(200);
    expect(grant.json()).toEqual({ workspace: workDir, trusted: true });

    // Persisted: a fresh GET (same store file) now reports trusted.
    const after = await app.api.inject({ method: 'GET', url: '/api/trust' });
    expect(after.json()).toEqual({ workspace: workDir, trusted: true });

    await app.close();
  });

  it('short-circuits to trusted when no workspace is configured (nothing to gate)', async () => {
    const app = injectApp(undefined);

    const status = await app.api.inject({ method: 'GET', url: '/api/trust' });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ workspace: null, trusted: true });

    await app.close();
  });
});
