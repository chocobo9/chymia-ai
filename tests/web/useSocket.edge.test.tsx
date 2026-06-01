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
import type { AgentMessage } from '@clowder/shared';
import {
  CLAUDE,
  CODEX,
  ROSTER,
  makeThread,
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

  it('a text delta arriving AFTER done re-opens a fresh buffer (no resurrected text)', () => {
    const socket = new MockSocket();
    registerSocketListeners(socket, { getActiveThreadId: () => 'thread_todo_api' });

    socket.fire('agent_event', textFrame(CLAUDE, '已生成 CRUD 路由。', 1));
    socket.fire('agent_event', doneFrame(CLAUDE, 2));
    expect(useChatStore.getState().streamingByThread['thread_todo_api']).toBeUndefined();

    socket.fire('agent_event', textFrame(CLAUDE, '补充：加了分页。', 3));
    const streams = useChatStore.getState().streamingByThread['thread_todo_api'];
    expect(streams).toHaveLength(1);
    expect(streams[0].text).toBe('补充：加了分页。');
  });

  it('an error agent_event clears the live buffer just like done', () => {
    const socket = new MockSocket();
    registerSocketListeners(socket, { getActiveThreadId: () => 'thread_todo_api' });

    socket.fire('agent_event', textFrame(CLAUDE, '流式中…', 1));
    socket.fire('agent_event', { type: 'error', agentId: CLAUDE, content: 'CLI 进程崩溃', invocationId: 'inv_1', timestamp: 2 } satisfies AgentMessage);
    expect(useChatStore.getState().streamingByThread['thread_todo_api']).toBeUndefined();
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
