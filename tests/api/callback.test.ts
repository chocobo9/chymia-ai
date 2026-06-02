// M8 dev happy-path suite for callback auth + callback routes.
// QA owns deep adversarial coverage (token-fuzzing, stale ordering, traversal).

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createAgentId } from '@choco/shared';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { InvocationRegistry } from '@choco/api/invocation/invocation-registry';
import { authenticateCallback } from '@choco/api/routes/callback-auth';

const CLAUDE = createAgentId('claude-opus');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe('authenticateCallback (happy path)', () => {
  it('accepts a correct invocationId + callbackToken pair', () => {
    const registry = new InvocationRegistry();
    const record = registry.create({ userId: 'user', agentId: CLAUDE, threadId: 'thread-1' });

    const result = authenticateCallback(
      {
        'x-invocation-id': record.invocationId,
        'x-callback-token': record.callbackToken,
      },
      registry,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.invocationId).toBe(record.invocationId);
      expect(result.record.threadId).toBe('thread-1');
    }
  });

  it('rejects a wrong token with a 401 + reason', () => {
    const registry = new InvocationRegistry();
    const record = registry.create({ userId: 'user', agentId: CLAUDE, threadId: 'thread-1' });

    const result = authenticateCallback(
      {
        'x-invocation-id': record.invocationId,
        'x-callback-token': 'not-the-real-token',
      },
      registry,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.reason).toBe('invalid_token');
    }
  });

  it('rejects an expired invocation with a 401', () => {
    let clock = 1_000_000;
    const registry = new InvocationRegistry({ now: () => clock });
    const record = registry.create({
      userId: 'user',
      agentId: CLAUDE,
      threadId: 'thread-1',
      ttlMs: 1000,
    });
    clock += 5000; // advance past expiry

    const result = authenticateCallback(
      {
        'x-invocation-id': record.invocationId,
        'x-callback-token': record.callbackToken,
      },
      registry,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.reason).toBe('expired');
    }
  });

  it('rejects missing credentials with a 401', () => {
    const registry = new InvocationRegistry();
    const result = authenticateCallback({}, registry);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });
});

describe('callback routes (happy path)', () => {
  /** Build an app and mint a live invocation by routing one real message. */
  async function appWithLiveInvocation(): Promise<{
    app: BuiltApp;
    invocationId: string;
    callbackToken: string;
    threadId: string;
  }> {
    const db = new Database(':memory:');
    const app = buildApp({ db });
    // Mint an invocation directly via the registry the app uses (no fake provider
    // needed — we are testing the callback seam, not the routing stream).
    const threadId = 'thread-callback';
    await app.stores.threadStore.ensureThread(threadId, 'callback test');
    const record = app.invocations.create({ userId: 'user', agentId: CLAUDE, threadId });
    return { app, invocationId: record.invocationId, callbackToken: record.callbackToken, threadId };
  }

  it('post_message with valid auth persists a callback message (201)', async () => {
    const { app, invocationId, callbackToken, threadId } = await appWithLiveInvocation();
    cleanups.push(app.close);

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/post_message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { content: '进度更新：已完成数据模型设计。' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ messageId: string }>().messageId).toBeTruthy();

    const stored = await app.stores.messageStore.getByThread(threadId);
    expect(stored.some((m) => m.origin === 'callback' && m.agentId === 'claude-opus')).toBe(true);
  });

  it('evidence_search with valid auth returns a search result', async () => {
    const { app, invocationId, callbackToken } = await appWithLiveInvocation();
    cleanups.push(app.close);

    app.stores.evidenceStore.upsert({
      anchor: 'decision:framework',
      kind: 'decision',
      status: 'active',
      title: 'Fastify 选型',
      summary: 'API 用 Fastify。',
      keywords: ['Fastify'],
      updatedAt: new Date().toISOString(),
    });

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/evidence_search',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { query: 'Fastify' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: unknown[] }>().items.length).toBeGreaterThanOrEqual(1);
  });

  it('callback with a wrong token is rejected 401', async () => {
    const { app, invocationId } = await appWithLiveInvocation();
    cleanups.push(app.close);

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/post_message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': 'wrong' },
      payload: { content: 'should not persist' },
    });
    expect(res.statusCode).toBe(401);
  });
});
