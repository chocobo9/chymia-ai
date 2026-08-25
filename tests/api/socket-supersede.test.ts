// QA gate — message supersede: a new message for the same thread cancels the
// old in-flight route so the mutex is released and the new message proceeds.
//
// Tests the public cancelExistingRoutes(threadId) method on SocketManager, which
// is the mechanism handleThreadMessage uses to supersede a prior route when a
// user sends a follow-up while the old invocation is still running (or retrying
// after timeout). Without this, the new invokeSingleAgent blocks on
// sessionMutex.acquire() until the old invocation finishes (up to 30 min).

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { CLAUDE, CODEX, GEMINI } from './helpers.js';

interface Listening {
  readonly app: BuiltApp;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

async function listen(): Promise<Listening> {
  const db = new Database(':memory:');
  const app = buildApp({
    db,
    agentServices: {
      'claude-opus': new FakeAgentService([]),
      'codex-gpt': new FakeAgentService([]),
      'gemini-pro': new FakeAgentService([]),
    },
  });
  cleanups.push(async () => {
    await app.close();
  });
  await app.api.listen({ port: 0, host: '127.0.0.1' });
  return { app };
}

describe('SocketManager.cancelExistingRoutes — supersede old route (unit)', () => {
  it('aborts all batch controllers on the thread', async () => {
    const { app } = await listen();
    const threadId = 'thread_supersede';
    const batch1 = app.socket.registerCancel(threadId);
    const batch2 = app.socket.registerCancel(threadId);

    app.socket.cancelExistingRoutes(threadId);

    expect(batch1.signal.aborted).toBe(true);
    expect(batch2.signal.aborted).toBe(true);
  });

  it('aborts all per-agent controllers on the thread', async () => {
    const { app } = await listen();
    const threadId = 'thread_supersede';
    const claude = app.socket.registerAgentCancel(threadId, CLAUDE);
    const codex = app.socket.registerAgentCancel(threadId, CODEX);

    app.socket.cancelExistingRoutes(threadId);

    expect(claude.signal.aborted).toBe(true);
    expect(codex.signal.aborted).toBe(true);
  });

  it('aborts BOTH batch and per-agent controllers together', async () => {
    const { app } = await listen();
    const threadId = 'thread_supersede';
    const batch = app.socket.registerCancel(threadId);
    const claude = app.socket.registerAgentCancel(threadId, CLAUDE);
    const gemini = app.socket.registerAgentCancel(threadId, GEMINI);

    app.socket.cancelExistingRoutes(threadId);

    expect(batch.signal.aborted).toBe(true);
    expect(claude.signal.aborted).toBe(true);
    expect(gemini.signal.aborted).toBe(true);
  });

  it('does NOT affect controllers on a different thread', async () => {
    const { app } = await listen();
    const batchA = app.socket.registerCancel('thread_a');
    const agentA = app.socket.registerAgentCancel('thread_a', CLAUDE);
    const batchB = app.socket.registerCancel('thread_b');
    const agentB = app.socket.registerAgentCancel('thread_b', CLAUDE);

    app.socket.cancelExistingRoutes('thread_a');

    expect(batchA.signal.aborted).toBe(true);
    expect(agentA.signal.aborted).toBe(true);
    expect(batchB.signal.aborted).toBe(false);
    expect(agentB.signal.aborted).toBe(false);
  });

  it('is a no-op when no controllers are registered for the thread', async () => {
    const { app } = await listen();
    expect(() => app.socket.cancelExistingRoutes('thread_ghost')).not.toThrow();
  });

  it('new controllers registered after supersede are fresh (not pre-aborted)', async () => {
    const { app } = await listen();
    const threadId = 'thread_supersede';
    const oldBatch = app.socket.registerCancel(threadId);
    const oldAgent = app.socket.registerAgentCancel(threadId, CLAUDE);

    app.socket.cancelExistingRoutes(threadId);

    expect(oldBatch.signal.aborted).toBe(true);
    expect(oldAgent.signal.aborted).toBe(true);

    const newBatch = app.socket.registerCancel(threadId);
    const newAgent = app.socket.registerAgentCancel(threadId, CLAUDE);

    expect(newBatch.signal.aborted).toBe(false);
    expect(newAgent.signal.aborted).toBe(false);
    expect(newBatch).not.toBe(oldBatch);
    expect(newAgent).not.toBe(oldAgent);
  });
});
