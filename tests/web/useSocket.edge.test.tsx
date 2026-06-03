// @vitest-environment jsdom
//
// M9 QA — edge + adversarial coverage for useSocket / registerSocketListeners.
// Focus: out-of-order frames (done-before-text, delta-after-done), event
// scoping via getActiveThreadId (events apply to the JOINED room, not the
// event's own id), null active thread, malformed thread_update / agent_status
// payloads, error frame with missing message, room join/leave transitions on
// active-thread change, and cancel with no active thread.
//
// dev≠QA: authored by the M9 QA instance; no product code modified.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  registerSocketListeners,
  useSocket,
  type SocketLike,
} from '../../packages/web/src/hooks/useSocket.js';
import { useChatStore } from '../../packages/web/src/stores/chat-store.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import type { AgentMessage } from '@choco/shared';
import {
  CLAUDE,
  CODEX,
  ROSTER,
  makeThread,
  makeAgentReply,
  textFrame,
  doneFrame,
  workingStatus,
} from './fixtures.js';

/** A mock socket recording handlers + emitted events; can replay frames. */
class MockSocket implements SocketLike {
  readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly emitted: Array<{ event: string; args: unknown[] }> = [];
  disconnected = false;

  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
    return this;
  }
  off(event: string, listener?: (...args: unknown[]) => void): this {
    if (listener === undefined) {
      this.handlers.delete(event);
      return this;
    }
    const list = (this.handlers.get(event) ?? []).filter((l) => l !== listener);
    this.handlers.set(event, list);
    return this;
  }
  emit(event: string, ...args: unknown[]): this {
    this.emitted.push({ event, args });
    return this;
  }
  disconnect(): this {
    this.disconnected = true;
    return this;
  }
  fire(event: string, payload: unknown): void {
    for (const l of this.handlers.get(event) ?? []) l(payload);
  }
}

function resetStores(active: string | null = 'thread_todo_api'): void {
  useChatStore.setState({
    threads: [],
    messagesByThread: {},
    streamingByThread: {},
    noticesByThread: {},
    activeThreadId: active,
  });
  useAgentStore.setState({ roster: ROSTER, statusById: {} });
}

describe('registerSocketListeners — out-of-order / hostile frames (adversarial)', () => {
  beforeEach(() => resetStores());

  it('done arriving BEFORE any text delta does not crash and creates no buffer', () => {
    const socket = new MockSocket();
    registerSocketListeners(socket, { getActiveThreadId: () => 'thread_todo_api' });

    expect(() => socket.fire('agent_event', doneFrame(CLAUDE, 1))).not.toThrow();
    expect(useChatStore.getState().streamingByThread['thread_todo_api']).toBeUndefined();
  });

  it('a stray SAME-invocation text delta AFTER done is IGNORED (settled reply not resurrected/mutated)', () => {
    const socket = new MockSocket();
    registerSocketListeners(socket, { getActiveThreadId: () => 'thread_todo_api' });

    socket.fire('agent_event', textFrame(CLAUDE, '已生成 CRUD 路由。', 1));
    socket.fire('agent_event', doneFrame(CLAUDE, 2));
    // `done` settles the buffer (kept, done:true), it is NOT dropped.
    const settled = useChatStore.getState().streamingByThread['thread_todo_api'];
    expect(settled).toHaveLength(1);
    expect(settled[0].done).toBe(true);
    expect(settled[0].text).toBe('已生成 CRUD 路由。');

    // A stray text frame for the SAME invocation (same agentId:invocationId key)
    // arrives after the turn already settled. The turn is over: the settled reply
    // must NOT be resurrected, extended, or re-opened. The frame is a no-op.
    socket.fire('agent_event', textFrame(CLAUDE, '补充：加了分页。', 3));
    const after = useChatStore.getState().streamingByThread['thread_todo_api'];
    expect(after).toHaveLength(1);
    expect(after[0].done).toBe(true);
    expect(after[0].text).toBe('已生成 CRUD 路由。'); // unchanged — no resurrection
  });

  it('a NEW turn for the same agent (DIFFERENT invocationId) opens its own fresh buffer beside the settled one', () => {
    const socket = new MockSocket();
    registerSocketListeners(socket, { getActiveThreadId: () => 'thread_todo_api' });

    // Turn 1 (inv_1) streams then settles on done.
    socket.fire('agent_event', textFrame(CLAUDE, '已生成 CRUD 路由。', 1));
    socket.fire('agent_event', doneFrame(CLAUDE, 2));

    // Turn 2 is a genuinely new invocation for the SAME agent → distinct key, so
    // it opens its own live buffer instead of being swallowed by the settled twin.
    const newTurn: AgentMessage = { ...textFrame(CLAUDE, '新一轮：开始重构分页逻辑。', 3), invocationId: 'inv_2' };
    socket.fire('agent_event', newTurn);

    const streams = useChatStore.getState().streamingByThread['thread_todo_api'];
    expect(streams).toHaveLength(2);
    const turn1 = streams.find((m) => m.invocationId === 'inv_1');
    const turn2 = streams.find((m) => m.invocationId === 'inv_2');
    expect(turn1?.done).toBe(true);
    expect(turn1?.text).toBe('已生成 CRUD 路由。');
    expect(turn2?.done).toBeUndefined(); // live
    expect(turn2?.text).toBe('新一轮：开始重构分页逻辑。');
  });

  it('an error agent_event clears the live buffer just like done', () => {
    const socket = new MockSocket();
    registerSocketListeners(socket, { getActiveThreadId: () => 'thread_todo_api' });

    socket.fire('agent_event', textFrame(CLAUDE, '流式中…', 1));
    socket.fire('agent_event', { type: 'error', agentId: CLAUDE, content: 'CLI 进程崩溃', invocationId: 'inv_1', timestamp: 2 } satisfies AgentMessage);
    expect(useChatStore.getState().streamingByThread['thread_todo_api']).toBeUndefined();
  });

  it('[parallel @all] one agent finishing (done) SETTLES it and does NOT wipe a sibling still streaming', () => {
    // The reported bug: in an @all broadcast, the faster agent's `done` wiped the
    // slower agent's live stream → "claude 输出到一半然后消失". The fix settles the
    // finished agent (keeps it, done:true) AND never touches the sibling: both
    // texts stay present.
    const socket = new MockSocket();
    registerSocketListeners(socket, { getActiveThreadId: () => 'thread_todo_api' });

    socket.fire('agent_event', textFrame(CLAUDE, 'Claude 正在分析 两数之和…', 1));
    socket.fire('agent_event', textFrame(CODEX, 'Codex 的思路…', 2));
    expect(useChatStore.getState().streamingByThread['thread_todo_api']).toHaveLength(2);

    // Codex finishes first → its done SETTLES codex (kept, done:true) and leaves
    // Claude live and untouched.
    socket.fire('agent_event', doneFrame(CODEX, 3));
    const streams = useChatStore.getState().streamingByThread['thread_todo_api'];
    expect(streams).toHaveLength(2);

    const claude = streams.find((m) => m.agentId === CLAUDE);
    const codex = streams.find((m) => m.agentId === CODEX);
    // Claude is still live (no done flag) with its full text — NOT wiped.
    expect(claude?.done).toBeUndefined();
    expect(claude?.text).toBe('Claude 正在分析 两数之和…');
    // Codex is settled (done:true) but its text survives.
    expect(codex?.done).toBe(true);
    expect(codex?.text).toBe('Codex 的思路…');
  });

  it('[parallel] an error for one agent clears only that agent, not a streaming sibling, + surfaces a notice', () => {
    const socket = new MockSocket();
    registerSocketListeners(socket, { getActiveThreadId: () => 'thread_todo_api' });

    socket.fire('agent_event', textFrame(CLAUDE, 'Claude 流式中…', 1));
    socket.fire('agent_event', textFrame(CODEX, 'Codex 流式中…', 2));
    socket.fire('agent_event', { type: 'error', agentId: CODEX, content: 'codex 崩溃', invocationId: 'inv_1', timestamp: 3 } satisfies AgentMessage);

    const streams = useChatStore.getState().streamingByThread['thread_todo_api'];
    expect(streams).toHaveLength(1);
    expect(streams[0].agentId).toBe(CLAUDE); // Claude's live stream survives
    expect(useChatStore.getState().noticesByThread['thread_todo_api']?.some((n) => n.kind === 'error')).toBe(true);
  });

  it('events are scoped to the JOINED room: applies to getActiveThreadId(), not corrupting a different thread', () => {
    // Active room is thread_todo_api. Seed a streaming buffer in thread_other.
    useChatStore.getState().applyAgentEvent('thread_other', textFrame(CODEX, '其他线程的旧流。', 0));
    const socket = new MockSocket();
    registerSocketListeners(socket, { getActiveThreadId: () => 'thread_todo_api' });

    // The server only ships events for the joined room; the frame carries no
    // threadId, so it must land on the active thread, never on thread_other.
    socket.fire('agent_event', textFrame(CLAUDE, '当前房间的输出。', 1));

    expect(useChatStore.getState().streamingByThread['thread_todo_api']?.[0].text).toBe('当前房间的输出。');
    // thread_other untouched.
    expect(useChatStore.getState().streamingByThread['thread_other']?.[0].text).toBe('其他线程的旧流。');
  });

  it('agent_event with NO active thread (null) is dropped — no buffer anywhere', () => {
    resetStores(null);
    const socket = new MockSocket();
    registerSocketListeners(socket, { getActiveThreadId: () => null });

    socket.fire('agent_event', textFrame(CLAUDE, '无房间归属。', 1));
    expect(useChatStore.getState().streamingByThread).toEqual({});
  });

  it('agent_status for an unknown/unrostered agent is stored without throwing', () => {
    const socket = new MockSocket();
    registerSocketListeners(socket, { getActiveThreadId: () => 'thread_todo_api' });

    socket.fire('agent_status', { id: 'phantom-agent', status: 'working', lastActiveAt: 5 });
    expect(useAgentStore.getState().statusById['phantom-agent']).toBe('working');
    // Rostered agents are untouched.
    expect(useAgentStore.getState().statusById['claude-opus']).toBeUndefined();
  });

  it('malformed thread_update (null / missing id) is ignored, not upserted', () => {
    const socket = new MockSocket();
    registerSocketListeners(socket, { getActiveThreadId: () => 'thread_todo_api' });

    socket.fire('thread_update', null);
    socket.fire('thread_update', { title: '没有 id 的脏数据' });
    expect(useChatStore.getState().threads).toHaveLength(0);

    // A well-formed one still works after the bad ones.
    socket.fire('thread_update', makeThread({ title: '正常会话' }));
    expect(useChatStore.getState().threads).toHaveLength(1);
  });

  it('malformed agent_status (null / missing id) is ignored, not applied', () => {
    const socket = new MockSocket();
    registerSocketListeners(socket, { getActiveThreadId: () => 'thread_todo_api' });

    socket.fire('agent_status', null);
    socket.fire('agent_status', { status: 'working', lastActiveAt: 1 }); // no id
    expect(useAgentStore.getState().statusById).toEqual({});

    socket.fire('agent_status', workingStatus(CLAUDE, 'thread_todo_api'));
    expect(useAgentStore.getState().statusById['claude-opus']).toBe('working');
  });

  it('error frame with a missing message field falls back to a default string', () => {
    const socket = new MockSocket();
    let captured: string | null = null;
    registerSocketListeners(socket, {
      getActiveThreadId: () => 'thread_todo_api',
      onError: (m) => {
        captured = m;
      },
    });
    socket.fire('error', {}); // no message
    expect(captured).toBe('socket error');
  });

  it('error frame with no onError handler does not throw', () => {
    const socket = new MockSocket();
    registerSocketListeners(socket, { getActiveThreadId: () => 'thread_todo_api' });
    expect(() => socket.fire('error', { message: '无 handler' })).not.toThrow();
  });

  it('disposer detaches every handler so post-dispose frames are inert', () => {
    const socket = new MockSocket();
    const dispose = registerSocketListeners(socket, { getActiveThreadId: () => 'thread_todo_api' });
    dispose();
    socket.fire('agent_event', textFrame(CLAUDE, '不应处理', 1));
    socket.fire('agent_status', workingStatus(CLAUDE, 'thread_todo_api'));
    socket.fire('thread_update', makeThread());
    expect(useChatStore.getState().streamingByThread['thread_todo_api']).toBeUndefined();
    expect(useAgentStore.getState().statusById).toEqual({});
    expect(useChatStore.getState().threads).toHaveLength(0);
  });
});

describe('regression: a finished agent stays visible while a sibling streams (output does not disappear)', () => {
  beforeEach(() => resetStores());

  it('a finished agent\'s reply stays visible while a sibling is still streaming, then reconcile prunes the settled twin', () => {
    // The exact reported bug: "每个 agent 输出完后立刻消失，下一个 agent 还在跑" —
    // a settled agent's output vanished in the gap between its own `done` and the
    // end-of-turn POST (reconcileReplies). The fix SETTLES the buffer so it stays.
    const socket = new MockSocket();
    registerSocketListeners(socket, { getActiveThreadId: () => 'thread_todo_api' });

    // Claude finishes its turn: streams real prose, then `done` settles it.
    socket.fire('agent_event', textFrame(CLAUDE, '我已实现 TODO API：GET/POST /todos，并加了 zod 校验。', 1));
    socket.fire('agent_event', doneFrame(CLAUDE, 2));

    // The NEXT agent is still working (a fresh frame arrives, no `done` yet).
    socket.fire('agent_event', textFrame(CODEX, 'Codex 正在补充批量删除接口…', 3));

    // CRUX: with the whole-turn POST NOT yet resolved (no reconcileReplies call),
    // Claude's finished reply must STILL be present — it does not vanish while
    // Codex works — AND Codex is live.
    const live = useChatStore.getState().streamingByThread['thread_todo_api'];
    expect(live).toHaveLength(2);
    const claudeSettled = live.find((m) => m.agentId === CLAUDE);
    const codexLive = live.find((m) => m.agentId === CODEX);
    expect(claudeSettled?.done).toBe(true); // settled, not dropped
    expect(claudeSettled?.text).toBe('我已实现 TODO API：GET/POST /todos，并加了 zod 校验。');
    expect(codexLive?.done).toBeUndefined(); // still streaming
    expect(codexLive?.text).toBe('Codex 正在补充批量删除接口…');
    // The turn was never persisted yet — no StoredMessage exists for the thread.
    expect(useChatStore.getState().messagesByThread['thread_todo_api']).toBeUndefined();

    // End of turn: the POST resolves and reconcileReplies brings the authoritative
    // persisted Claude reply (carrying extra.invocationId = 'inv_1', matching the
    // streamed frames). It must PRUNE Claude's settled live twin (no duplicate) and
    // leave Codex's still-live stream untouched.
    const persistedClaude = makeAgentReply(); // agentId=CLAUDE, extra.invocationId='inv_1'
    useChatStore.getState().reconcileReplies([persistedClaude]);

    const afterReconcile = useChatStore.getState().streamingByThread['thread_todo_api'];
    // Claude's settled twin is gone; only Codex's live stream remains.
    expect(afterReconcile).toHaveLength(1);
    expect(afterReconcile[0].agentId).toBe(CODEX);
    expect(afterReconcile[0].done).toBeUndefined();
    expect(afterReconcile[0].text).toBe('Codex 正在补充批量删除接口…');
    // Claude is now the durable persisted message — exactly one bubble, no dupe.
    const persisted = useChatStore.getState().messagesByThread['thread_todo_api'];
    expect(persisted).toHaveLength(1);
    expect(persisted?.[0].id).toBe(persistedClaude.id);
    expect(persisted?.[0].agentId).toBe(CLAUDE);
  });
});

describe('useSocket — room transitions + cancel (edge)', () => {
  beforeEach(() => resetStores());

  it('switching active thread leaves the old room and joins the new one in order', () => {
    const socket = new MockSocket();
    const connector = (): SocketLike => socket;
    const { rerender } = renderHook(
      (props: { activeThreadId: string | null }) =>
        useSocket({ activeThreadId: props.activeThreadId, connector }),
      { initialProps: { activeThreadId: 'thread_todo_api' } },
    );

    rerender({ activeThreadId: 'thread_evidence' });

    const joins = socket.emitted.filter((e) => e.event === 'join_thread').map((e) => e.args[0]);
    const leaves = socket.emitted.filter((e) => e.event === 'leave_thread').map((e) => e.args[0]);
    expect(joins).toContainEqual({ threadId: 'thread_todo_api' });
    expect(joins).toContainEqual({ threadId: 'thread_evidence' });
    expect(leaves).toContainEqual({ threadId: 'thread_todo_api' });
  });

  it('starting with a null active thread emits no join until one is selected', () => {
    const socket = new MockSocket();
    const { rerender } = renderHook(
      (props: { activeThreadId: string | null }) =>
        useSocket({ activeThreadId: props.activeThreadId, connector: () => socket }),
      { initialProps: { activeThreadId: null as string | null } },
    );
    expect(socket.emitted.filter((e) => e.event === 'join_thread')).toHaveLength(0);

    rerender({ activeThreadId: 'thread_todo_api' });
    expect(socket.emitted.filter((e) => e.event === 'join_thread')).toHaveLength(1);
  });

  it('cancel() with a null active thread emits nothing (no spurious cancel)', () => {
    const socket = new MockSocket();
    const { result } = renderHook(() =>
      useSocket({ activeThreadId: null, connector: () => socket }),
    );
    result.current.cancel();
    expect(socket.emitted.filter((e) => e.event === 'cancel')).toHaveLength(0);
  });
});
