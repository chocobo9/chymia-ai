// @vitest-environment jsdom
//
// M9 useSocket happy-path tests: registerSocketListeners wires the four
// server→client events into the stores, and the React hook joins the active
// thread room + cancels. socket.io-client is replaced by a mock SocketLike.

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
import {
  CLAUDE,
  ROSTER,
  makeThread,
  textFrame,
  doneFrame,
  workingStatus,
  idleStatus,
} from './fixtures.js';

/** A mock socket recording handlers + emitted events. */
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
  /** Simulate the server pushing an event to this client. */
  fire(event: string, payload: unknown): void {
    for (const l of this.handlers.get(event) ?? []) l(payload);
  }
}

function resetStores(): void {
  useChatStore.setState({
    threads: [],
    messagesByThread: {},
    streamingByThread: {},
    activeThreadId: 'thread_todo_api',
  });
  useAgentStore.setState({ roster: ROSTER, statusById: {} });
}

describe('registerSocketListeners (unit, happy path)', () => {
  beforeEach(resetStores);

  it('dispatches agent_event text frames into the chat store streaming buffer', () => {
    const socket = new MockSocket();
    registerSocketListeners(socket, { getActiveThreadId: () => 'thread_todo_api' });

    socket.fire('agent_event', textFrame(CLAUDE, 'CRUD 路由已生成。', 1));

    const streams = useChatStore.getState().streamingByThread['thread_todo_api'];
    expect(streams).toHaveLength(1);
    expect(streams[0].text).toBe('CRUD 路由已生成。');
  });

  it('clears the streaming buffer on a done agent_event', () => {
    const socket = new MockSocket();
    registerSocketListeners(socket, { getActiveThreadId: () => 'thread_todo_api' });

    socket.fire('agent_event', textFrame(CLAUDE, '流式中…', 1));
    expect(useChatStore.getState().streamingByThread['thread_todo_api']).toHaveLength(1);
    socket.fire('agent_event', doneFrame(CLAUDE, 2));
    expect(useChatStore.getState().streamingByThread['thread_todo_api']).toBeUndefined();
  });

  it('dispatches agent_status frames into the agent store', () => {
    const socket = new MockSocket();
    registerSocketListeners(socket, { getActiveThreadId: () => 'thread_todo_api' });

    socket.fire('agent_status', workingStatus(CLAUDE, 'thread_todo_api'));
    expect(useAgentStore.getState().statusById['claude-opus']).toBe('working');
    socket.fire('agent_status', idleStatus(CLAUDE, 'thread_todo_api'));
    expect(useAgentStore.getState().statusById['claude-opus']).toBe('idle');
  });

  it('dispatches thread_update frames into the chat store', () => {
    const socket = new MockSocket();
    registerSocketListeners(socket, { getActiveThreadId: () => 'thread_todo_api' });

    socket.fire('thread_update', makeThread({ title: 'TODO API — 评审中', sopStageId: 'review' }));
    const threads = useChatStore.getState().threads;
    expect(threads).toHaveLength(1);
    expect(threads[0].sopStageId).toBe('review');
  });

  it('surfaces error frames via onError', () => {
    const socket = new MockSocket();
    let captured: string | null = null;
    registerSocketListeners(socket, {
      getActiveThreadId: () => 'thread_todo_api',
      onError: (m) => {
        captured = m;
      },
    });
    socket.fire('error', { message: 'CLI 进程超时' });
    expect(captured).toBe('CLI 进程超时');
  });

  it('disposer removes all registered listeners', () => {
    const socket = new MockSocket();
    const dispose = registerSocketListeners(socket, { getActiveThreadId: () => 'thread_todo_api' });
    dispose();
    socket.fire('agent_event', textFrame(CLAUDE, '不应被处理', 1));
    expect(useChatStore.getState().streamingByThread['thread_todo_api']).toBeUndefined();
  });
});

describe('useSocket (unit, happy path)', () => {
  beforeEach(resetStores);

  it('joins the active thread room on mount and cancels the live turn', () => {
    const socket = new MockSocket();
    const connector = (): SocketLike => socket;

    const { result } = renderHook(() =>
      useSocket({ activeThreadId: 'thread_todo_api', connector }),
    );

    const joins = socket.emitted.filter((e) => e.event === 'join_thread');
    expect(joins).toHaveLength(1);
    expect(joins[0].args[0]).toEqual({ threadId: 'thread_todo_api' });

    result.current.cancel();
    const cancels = socket.emitted.filter((e) => e.event === 'cancel');
    expect(cancels).toHaveLength(1);
    expect(cancels[0].args[0]).toEqual({ threadId: 'thread_todo_api' });
  });

  it('disconnects the socket on unmount', () => {
    const socket = new MockSocket();
    const { unmount } = renderHook(() =>
      useSocket({ activeThreadId: 'thread_todo_api', connector: () => socket }),
    );
    unmount();
    expect(socket.disconnected).toBe(true);
  });
});
