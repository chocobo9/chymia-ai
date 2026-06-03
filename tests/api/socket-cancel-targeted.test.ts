// QA gate — per-agent (targeted) cancellation in SocketManager (the
// "collateral cancel" fix). dev≠QA: authored independently of the product code
// in packages/api/src/infrastructure/socket-manager.ts; NO product code touched.
//
// Drives the REAL SocketManager over a REAL socket.io Server (a listening
// buildApp) so the private cancelAgent/cancelThread paths are exercised through
// the actual `cancel` client event — the same wire the web client uses — while
// the per-route + per-agent controllers are observed through their public
// register surface. Covers the four properties:
//   • registerAgentCancel idempotency (one controller per (thread, agentId));
//   • targeted cancel aborts ONLY the named agent, not a sibling, not the batch;
//   • stop-all aborts the batch controller AND every per-agent controller;
//   • release removes the controller; cancelling released/unknown is a no-op;
//   • adversarial malformed payloads neither crash nor over-cancel.
//
// Real agent ids only (claude-opus / codex-gpt / gemini-pro) — no placeholders.

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { CLAUDE, CODEX, GEMINI } from './helpers.js';

interface Listening {
  readonly app: BuiltApp;
  readonly baseUrl: string;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

/** Start a listening buildApp (real Socket.io server) over an in-memory db. */
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
  const address = await app.api.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = typeof address === 'string' ? address : 'http://127.0.0.1';
  return { app, baseUrl };
}

/** Connect a raw socket.io client (no room join needed for cancel routing). */
async function connect(baseUrl: string): Promise<ClientSocket> {
  const socket = ioClient(baseUrl, { transports: ['websocket'], forceNew: true });
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve());
    socket.on('connect_error', reject);
  });
  cleanups.push(() => {
    socket.disconnect();
  });
  return socket;
}

/** Emit a `cancel` and give the server a tick to dispatch the handler. */
async function emitCancel(
  socket: ClientSocket,
  payload: unknown,
): Promise<void> {
  socket.emit('cancel', payload);
  await new Promise((r) => setTimeout(r, 50));
}

describe('SocketManager.registerAgentCancel — idempotency (unit)', () => {
  it('returns the SAME controller for repeat calls with the same (thread, agentId)', async () => {
    const { app } = await listen();
    const threadId = 'thread_todo_api';
    const first = app.socket.registerAgentCancel(threadId, CLAUDE);
    const second = app.socket.registerAgentCancel(threadId, CLAUDE);
    expect(second).toBe(first);
    expect(first.signal.aborted).toBe(false);
  });

  it('returns DISTINCT controllers for different agents on the same thread', async () => {
    const { app } = await listen();
    const threadId = 'thread_evidence';
    const claude = app.socket.registerAgentCancel(threadId, CLAUDE);
    const codex = app.socket.registerAgentCancel(threadId, CODEX);
    expect(claude).not.toBe(codex);
  });

  it('returns DISTINCT controllers for the same agent across different threads', async () => {
    const { app } = await listen();
    const a = app.socket.registerAgentCancel('thread_a', CLAUDE);
    const b = app.socket.registerAgentCancel('thread_b', CLAUDE);
    expect(a).not.toBe(b);
  });
});

describe('SocketManager targeted cancel — sibling isolation (edge)', () => {
  it('cancel {threadId, agentId: claude} aborts claude ONLY — codex + batch untouched', async () => {
    const { app, baseUrl } = await listen();
    const threadId = 'thread_todo_api';
    const claude = app.socket.registerAgentCancel(threadId, CLAUDE);
    const codex = app.socket.registerAgentCancel(threadId, CODEX);
    const batch = app.socket.registerCancel(threadId);

    const socket = await connect(baseUrl);
    await emitCancel(socket, { threadId, agentId: CLAUDE });

    expect(claude.signal.aborted).toBe(true);
    expect(codex.signal.aborted).toBe(false);
    expect(batch.signal.aborted).toBe(false);
  });

  it('targeted cancel of one agent does not abort a THIRD agent on the same thread', async () => {
    const { app, baseUrl } = await listen();
    const threadId = 'thread_evidence';
    const claude = app.socket.registerAgentCancel(threadId, CLAUDE);
    const codex = app.socket.registerAgentCancel(threadId, CODEX);
    const gemini = app.socket.registerAgentCancel(threadId, GEMINI);

    const socket = await connect(baseUrl);
    await emitCancel(socket, { threadId, agentId: CODEX });

    expect(codex.signal.aborted).toBe(true);
    expect(claude.signal.aborted).toBe(false);
    expect(gemini.signal.aborted).toBe(false);
  });

  it('a targeted cancel on one thread never crosses into another thread', async () => {
    const { app, baseUrl } = await listen();
    const a = app.socket.registerAgentCancel('thread_a', CLAUDE);
    const b = app.socket.registerAgentCancel('thread_b', CLAUDE);

    const socket = await connect(baseUrl);
    await emitCancel(socket, { threadId: 'thread_a', agentId: CLAUDE });

    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
  });
});

describe('SocketManager stop-all — aborts batch AND every per-agent (edge)', () => {
  it('cancel {threadId} (no agentId) aborts the batch controller AND all per-agent controllers', async () => {
    const { app, baseUrl } = await listen();
    const threadId = 'thread_todo_api';
    const claude = app.socket.registerAgentCancel(threadId, CLAUDE);
    const codex = app.socket.registerAgentCancel(threadId, CODEX);
    const batch = app.socket.registerCancel(threadId);

    const socket = await connect(baseUrl);
    await emitCancel(socket, { threadId });

    expect(batch.signal.aborted).toBe(true);
    expect(claude.signal.aborted).toBe(true);
    expect(codex.signal.aborted).toBe(true);
  });

  it('stop-all aborts EVERY batch controller in the per-thread Set (main route + nested A2A fan-out)', async () => {
    const { app, baseUrl } = await listen();
    const threadId = 'thread_evidence';
    // Two batch controllers on the same thread (the Set semantics: main user
    // route + a nested A2A post_message fan-out each register their own).
    const mainRoute = app.socket.registerCancel(threadId);
    const a2aFanout = app.socket.registerCancel(threadId);

    const socket = await connect(baseUrl);
    await emitCancel(socket, { threadId });

    expect(mainRoute.signal.aborted).toBe(true);
    expect(a2aFanout.signal.aborted).toBe(true);
  });

  it('stop-all on one thread leaves another thread entirely alone', async () => {
    const { app, baseUrl } = await listen();
    const aBatch = app.socket.registerCancel('thread_a');
    const aAgent = app.socket.registerAgentCancel('thread_a', CLAUDE);
    const bBatch = app.socket.registerCancel('thread_b');
    const bAgent = app.socket.registerAgentCancel('thread_b', CLAUDE);

    const socket = await connect(baseUrl);
    await emitCancel(socket, { threadId: 'thread_a' });

    expect(aBatch.signal.aborted).toBe(true);
    expect(aAgent.signal.aborted).toBe(true);
    expect(bBatch.signal.aborted).toBe(false);
    expect(bAgent.signal.aborted).toBe(false);
  });
});

describe('SocketManager.releaseAgentCancel — removal + no-op semantics (edge)', () => {
  it('after release, a later registerAgentCancel returns a FRESH controller (the old one is gone)', async () => {
    const { app } = await listen();
    const threadId = 'thread_todo_api';
    const first = app.socket.registerAgentCancel(threadId, CLAUDE);
    app.socket.releaseAgentCancel(threadId, CLAUDE);
    const second = app.socket.registerAgentCancel(threadId, CLAUDE);
    expect(second).not.toBe(first);
  });

  it('a released agent is no longer caught by a stop-all (it has been removed from the registry)', async () => {
    const { app, baseUrl } = await listen();
    const threadId = 'thread_evidence';
    const claude = app.socket.registerAgentCancel(threadId, CLAUDE);
    const codex = app.socket.registerAgentCancel(threadId, CODEX);
    app.socket.releaseAgentCancel(threadId, CLAUDE);

    const socket = await connect(baseUrl);
    await emitCancel(socket, { threadId });

    // claude was released BEFORE the stop-all, so its (now detached) controller
    // is not aborted; codex (still registered) is.
    expect(claude.signal.aborted).toBe(false);
    expect(codex.signal.aborted).toBe(true);
  });

  it('releasing an unknown (thread, agentId) does not throw', async () => {
    const { app } = await listen();
    expect(() => app.socket.releaseAgentCancel('thread_never', GEMINI)).not.toThrow();
    // Releasing twice (double-release) is also inert.
    app.socket.registerAgentCancel('thread_x', CLAUDE);
    app.socket.releaseAgentCancel('thread_x', CLAUDE);
    expect(() => app.socket.releaseAgentCancel('thread_x', CLAUDE)).not.toThrow();
  });

  it('cancelling a never-registered / already-released agent over the wire is a no-op (no throw, no over-cancel)', async () => {
    const { app, baseUrl } = await listen();
    const threadId = 'thread_todo_api';
    const codex = app.socket.registerAgentCancel(threadId, CODEX);

    const socket = await connect(baseUrl);
    // claude was never registered on this thread → the targeted cancel finds
    // nothing and must not disturb the registered sibling codex.
    await emitCancel(socket, { threadId, agentId: CLAUDE });

    expect(codex.signal.aborted).toBe(false);
  });
});

describe('SocketManager cancel — malformed payloads (adversarial)', () => {
  it('a cancel with NO threadId is dropped: no per-agent or batch controller is aborted', async () => {
    const { app, baseUrl } = await listen();
    const claude = app.socket.registerAgentCancel('thread_todo_api', CLAUDE);
    const batch = app.socket.registerCancel('thread_todo_api');

    const socket = await connect(baseUrl);
    await emitCancel(socket, { agentId: CLAUDE }); // threadId missing
    await emitCancel(socket, {}); // wholly empty
    await emitCancel(socket, undefined);
    await emitCancel(socket, null);

    expect(claude.signal.aborted).toBe(false);
    expect(batch.signal.aborted).toBe(false);
  });

  it('an empty-string threadId is treated as absent (no over-cancel) and does not crash', async () => {
    const { app, baseUrl } = await listen();
    const claude = app.socket.registerAgentCancel('thread_todo_api', CLAUDE);

    const socket = await connect(baseUrl);
    await emitCancel(socket, { threadId: '', agentId: 'claude-opus' });

    expect(claude.signal.aborted).toBe(false);
  });

  it('a non-string / empty-string agentId degrades to a STOP-ALL (agentId absent), aborting the batch', async () => {
    const { app, baseUrl } = await listen();
    const threadId = 'thread_evidence';
    const claude = app.socket.registerAgentCancel(threadId, CLAUDE);
    const batch = app.socket.registerCancel(threadId);

    const socket = await connect(baseUrl);
    // agentId is a number → extractAgentId returns undefined → cancelThread.
    await emitCancel(socket, { threadId, agentId: 42 });

    // Degraded to stop-all: both the agent and the batch are aborted. The key
    // adversarial property is "does not crash"; the documented contract is that a
    // missing/invalid agentId means stop-all, so over-cancel here is BY DESIGN.
    expect(batch.signal.aborted).toBe(true);
    expect(claude.signal.aborted).toBe(true);
  });

  it('an empty-string agentId likewise degrades to stop-all without throwing', async () => {
    const { app, baseUrl } = await listen();
    const threadId = 'thread_x';
    const codex = app.socket.registerAgentCancel(threadId, CODEX);
    const batch = app.socket.registerCancel(threadId);

    const socket = await connect(baseUrl);
    await emitCancel(socket, { threadId, agentId: '' });

    expect(batch.signal.aborted).toBe(true);
    expect(codex.signal.aborted).toBe(true);
  });

  it('a cancel for a thread with NO registered controllers at all is an inert no-op', async () => {
    const { baseUrl } = await listen();
    const socket = await connect(baseUrl);
    // Nothing registered for thread_ghost; neither variant must throw.
    await expect(emitCancel(socket, { threadId: 'thread_ghost' })).resolves.toBeUndefined();
    await expect(
      emitCancel(socket, { threadId: 'thread_ghost', agentId: GEMINI }),
    ).resolves.toBeUndefined();
  });
});
