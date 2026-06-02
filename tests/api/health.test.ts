// Operability dev happy-path: the /health liveness endpoint + the buildApp
// default-logger no-op guarantee.
//
// /health is exercised via Fastify inject (no listener). The no-op guarantee
// asserts buildApp() with NO injected logger never writes a log file (so the
// test suite stays clean) — the real file logger lives only at the edge (main.ts).

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, readdirSync } from 'node:fs';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { DEFAULT_LOG_DIR } from '@choco/api/infrastructure/logger';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { replyScript, CLAUDE } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

function injectApp(): BuiltApp {
  const db = new Database(':memory:');
  return buildApp({ db, agentServices: { 'claude-opus': new FakeAgentService([]) } });
}

describe('/health (happy path)', () => {
  it('returns { status: ok } with a numeric uptimeMs and timestamp', async () => {
    const app = injectApp();
    cleanups.push(app.close);

    const res = await app.api.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; uptimeMs: number; timestamp: number }>();
    expect(body.status).toBe('ok');
    expect(typeof body.uptimeMs).toBe('number');
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(typeof body.timestamp).toBe('number');
  });
});

describe('buildApp default logger no-op (happy path)', () => {
  it('drives a full message turn with NO injected logger and writes no log file', async () => {
    // Snapshot any pre-existing files in the default log dir so we can prove the
    // suite added none (the default logger is a silent no-op, never the file sink).
    const before = existsSync(DEFAULT_LOG_DIR) ? readdirSync(DEFAULT_LOG_DIR) : null;

    const db = new Database(':memory:');
    const app = buildApp({
      db,
      agentServices: { 'claude-opus': new FakeAgentService([replyScript(CLAUDE, 'ok, 已收到。')]) },
    });
    cleanups.push(app.close);

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/threads/thread-noop-logger/messages',
      payload: { content: '@claude 健康检查一下' },
    });
    expect(res.statusCode).toBe(200);

    const after = existsSync(DEFAULT_LOG_DIR) ? readdirSync(DEFAULT_LOG_DIR) : null;
    // Either the dir still does not exist, or its file set is unchanged.
    if (before === null) {
      expect(after).toBeNull();
    } else {
      expect(after).toEqual(before);
    }
  });
});
