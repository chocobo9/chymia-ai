// QA gate — message-handler end-to-end: targeted-cancelling ONE agent mid-stream
// leaves the OTHER agent's reply intact + persisted (the collateral-cancel fix at
// the integration seam). dev≠QA: authored independently of message-handler.ts;
// NO product code touched.
//
// Drives the REAL buildApp pipeline (router + InvokeAgentFn seam + SocketManager)
// via POST /api/threads/:id/messages. A `@claude @codex` message has 2 targets →
// `ideate` intent → PARALLEL routing, so the two agents are independent. One
// provider (codex) blocks on its abort signal; the other (claude) replies and
// finishes. We fire a TARGETED cancel of codex by aborting its per-agent
// controller through the real SocketManager (registerAgentCancel is idempotent —
// it returns the SAME controller the handler's signalForAgent registered). The
// POST resolves with claude's reply persisted; codex produced none.
//
// Also gates the WIRING directly: per-agent controllers register during the turn
// and are RELEASED in the handler's finally (so a fresh register after the turn
// returns a new controller).

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentId, AgentMessage, StoredMessage } from '@choco/shared';
import type { AgentService, InvokeOptions } from '@choco/api/providers/base';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { CLAUDE, CODEX, replyScript } from './helpers.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

function injectApp(services: Record<string, AgentService>): BuiltApp {
  const db = new Database(':memory:');
  const app = buildApp({ db, agentServices: services });
  cleanups.push(async () => {
    await app.close();
  });
  return app;
}

/**
 * A provider whose stream emits ONLY a session_init (no user-visible text), then
 * BLOCKS on its abort signal. A cancelled turn therefore produces NO persisted
 * reply (no text, no tool events). When aborted it ends WITHOUT a done; a hard
 * cap prevents a hang if a bug breaks abort propagation. Exposes a promise that
 * resolves once the stream is live, so the test can cancel deterministically.
 */
class BlockingAgentService implements AgentService {
  readonly state = { live: false, aborted: false };
  private resolveLive!: () => void;
  readonly liveSignal: Promise<void>;
  constructor(
    private readonly agentId: AgentId,
    private readonly capMs = 3000,
  ) {
    this.liveSignal = new Promise<void>((resolve) => {
      this.resolveLive = resolve;
    });
  }
  invoke(_prompt: string, options?: InvokeOptions): AsyncIterable<AgentMessage> {
    const agentId = this.agentId;
    const signal = options?.signal;
    const state = this.state;
    const markLive = this.resolveLive;
    const capMs = this.capMs;
    return (async function* (): AsyncIterable<AgentMessage> {
      yield { type: 'session_init', agentId, content: `sess-${agentId as string}`, timestamp: Date.now() };
      state.live = true;
      markLive();
      await new Promise<void>((resolve) => {
        const cap = setTimeout(resolve, capMs);
        const onAbort = (): void => {
          state.aborted = true;
          clearTimeout(cap);
          resolve();
        };
        if (signal !== undefined) {
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
      });
      // No done on abort — the cancelled turn produced no final reply.
    })();
  }
}

describe('message-handler — targeted cancel leaves the sibling intact (integration)', () => {
  it('cancelling codex mid-stream still persists claude full reply; codex persists nothing', async () => {
    const claudeReply = '我已实现 TODO API：GET/POST /todos、PATCH/DELETE /todos/:id，并加了 zod 校验。';
    const codex = new BlockingAgentService(CODEX);
    const app = injectApp({
      'claude-opus': new FakeAgentService([replyScript(CLAUDE, claudeReply)]),
      'codex-gpt': codex,
    });
    const threadId = 'thread_todo_api';

    // Fire the multi-agent turn (parallel: 2 targets → ideate). Do NOT await — it
    // stays live until codex is cancelled.
    const post = app.api.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: '@claude @codex 各自实现一版 TODO API' },
    });

    // Wait until codex's stream is live, then targeted-cancel codex only. The
    // handler already registered codex's per-agent controller via signalForAgent;
    // registerAgentCancel is idempotent, so this returns that SAME controller.
    await codex.liveSignal;
    app.socket.registerAgentCancel(threadId, CODEX).abort();

    const res = await post;
    expect(res.statusCode).toBe(200);
    const replies = res.json<{ replies: StoredMessage[] }>().replies;

    // Claude's full reply is present in the returned + persisted replies.
    const claudePersisted = replies.find((m) => m.agentId === CLAUDE);
    expect(claudePersisted).toBeDefined();
    expect(claudePersisted?.content).toBe(claudeReply);

    // Codex was cancelled mid-stream → it produced no text → no reply persisted.
    expect(replies.some((m) => m.agentId === CODEX)).toBe(false);
    expect(codex.state.aborted).toBe(true);

    // Durable check: the message store holds claude's reply but no codex reply.
    const history = await app.stores.messageStore.getByThread(threadId);
    expect(history.some((m) => m.agentId === CLAUDE && m.content === claudeReply)).toBe(true);
    expect(history.some((m) => m.agentId === CODEX && m.origin === 'stream')).toBe(false);
    // The user message persisted regardless.
    expect(history.some((m) => m.origin === 'user' && m.content.includes('各自实现一版'))).toBe(true);
  });

  it('a targeted cancel does NOT abort the sibling provider (claude finishes normally)', async () => {
    // Both agents block; cancel ONLY codex. Claude must still be releasable and
    // complete — its signal must not be aborted by codex's cancel.
    const claude = new BlockingAgentService(CLAUDE);
    const codex = new BlockingAgentService(CODEX);
    const app = injectApp({ 'claude-opus': claude, 'codex-gpt': codex });
    const threadId = 'thread_evidence';

    const post = app.api.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: '@claude @codex 并行处理' },
    });

    await Promise.all([claude.liveSignal, codex.liveSignal]);
    // Targeted-cancel codex; claude's controller is left untouched.
    app.socket.registerAgentCancel(threadId, CODEX).abort();
    // Give the abort a tick to propagate; claude must NOT have been aborted.
    await new Promise((r) => setTimeout(r, 100));
    expect(codex.state.aborted).toBe(true);
    expect(claude.state.aborted).toBe(false);

    // Now let the turn wind down cleanly by also aborting claude's per-agent
    // controller (so its blocking provider stops and the POST can resolve).
    app.socket.registerAgentCancel(threadId, CLAUDE).abort();
    const res = await post;
    expect(res.statusCode).toBe(200);
    expect(claude.state.aborted).toBe(true);
  });
});

describe('message-handler — per-agent controller lifecycle (wiring)', () => {
  it('registers each routed agent per-agent controller and RELEASES them after the turn', async () => {
    // A normal completed turn: both agents reply and finish. After the POST
    // resolves, the handler must have released the per-agent controllers in its
    // finally — so a fresh registerAgentCancel returns a NEW controller (the old
    // entry is gone), and the just-registered fresh controller is not aborted.
    const app = injectApp({
      'claude-opus': new FakeAgentService([replyScript(CLAUDE, '我实现了端点。')]),
      'codex-gpt': new FakeAgentService([replyScript(CODEX, '我复查了实现。')]),
    });
    const threadId = 'thread_x';

    // Pre-register a controller for claude; capture it. The handler's
    // signalForAgent will reuse THIS controller during the turn (idempotent),
    // then release it in finally.
    const preTurn = app.socket.registerAgentCancel(threadId, CLAUDE);

    const res = await app.api.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: '@claude @codex 各自处理' },
    });
    expect(res.statusCode).toBe(200);
    const replies = res.json<{ replies: StoredMessage[] }>().replies;
    // Both agents ran to completion and persisted.
    expect(replies.some((m) => m.agentId === CLAUDE)).toBe(true);
    expect(replies.some((m) => m.agentId === CODEX)).toBe(true);

    // After the turn the controller was released: a fresh register yields a NEW
    // controller, and it is not aborted (a clean completion never aborts).
    const postTurn = app.socket.registerAgentCancel(threadId, CLAUDE);
    expect(postTurn).not.toBe(preTurn);
    expect(postTurn.signal.aborted).toBe(false);
  });
});
