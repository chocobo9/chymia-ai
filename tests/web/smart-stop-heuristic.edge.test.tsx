// @vitest-environment jsdom
//
// QA gate — the App 停止 smart-stop heuristic (App.tsx handleStop): EXACTLY ONE
// working agent → targeted cancel {threadId, agentId:<that one>}; TWO+ working →
// stop-all {threadId} (no agentId). dev≠QA: authored independently of App.tsx /
// useSocket.ts; NO product code touched.
//
// Drives the FULL <App> with an injected fake ApiClient + a mock socket
// connector (the build-App-with-fakes idiom), holds a never-resolving send to
// surface the busy-only 停止 button, then seeds useAgentStore.statusById to put a
// precise number of agents in 'working' and asserts the emitted cancel payload.
//
// Real agent ids only (claude-opus / codex-gpt / gemini-pro).

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../packages/web/src/App.js';
import { ApiClient } from '../../packages/web/src/lib/api.js';
import type { SocketLike, SocketConnector } from '../../packages/web/src/hooks/useSocket.js';
import { useChatStore } from '../../packages/web/src/stores/chat-store.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import type { StoredMessage } from '@choco/shared';
import { ROSTER, makeThread } from './fixtures.js';

/** Mock socket recording emitted client events. */
class MockSocket implements SocketLike {
  readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly emitted: Array<{ event: string; args: readonly unknown[] }> = [];
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
    this.handlers.set(event, (this.handlers.get(event) ?? []).filter((l) => l !== listener));
    return this;
  }
  emit(event: string, ...args: unknown[]): this {
    this.emitted.push({ event, args });
    return this;
  }
  disconnect(): this {
    return this;
  }
  fire(event: string, payload: unknown): void {
    for (const l of this.handlers.get(event) ?? []) l(payload);
  }
}

function makeClient(): ApiClient {
  const client = new ApiClient({
    baseUrl: 'http://test',
    fetchFn: () => Promise.reject(new Error('no network in test')),
  });
  vi.spyOn(client, 'listAgents').mockResolvedValue(ROSTER);
  vi.spyOn(client, 'listThreads').mockResolvedValue([makeThread()]);
  vi.spyOn(client, 'getMessages').mockResolvedValue([]);
  vi.spyOn(client, 'createThread').mockResolvedValue(
    makeThread({ id: 'thread_new', title: '新会话', participants: [] }),
  );
  // Never-resolving send → keeps the composer busy so the 停止 button renders.
  vi.spyOn(client, 'sendMessage').mockImplementation(
    () => new Promise<{ userMessage: StoredMessage; replies: readonly StoredMessage[] }>(() => {}),
  );
  return client;
}

/** Mount App, select the seeded thread, and start a busy send so 停止 shows. */
async function mountBusyApp(): Promise<MockSocket> {
  const socket = new MockSocket();
  const connector: SocketConnector = () => socket;
  render(<App client={makeClient()} socketConnector={connector} />);
  await waitFor(() => expect(useAgentStore.getState().roster.length).toBeGreaterThan(0));
  const user = userEvent.setup();
  await screen.findByText('TODO API 设计与实现');
  await user.click(screen.getByText('TODO API 设计与实现'));
  await waitFor(() => expect(useChatStore.getState().activeThreadId).toBe('thread_todo_api'));
  // Type + send to enter the busy state (the send never resolves).
  await user.type(screen.getByTestId('chat-input-textarea'), '@claude @codex 各自实现一版');
  await user.click(screen.getByTestId('chat-send-button'));
  await screen.findByTestId('cancel-button');
  return socket;
}

/** Set the live working-status overlay for the named agent ids. */
function setWorking(workingIds: readonly string[]): void {
  const statusById: Record<string, 'working' | 'idle'> = {};
  for (const entry of ROSTER) {
    statusById[entry.id] = workingIds.includes(entry.id) ? 'working' : 'idle';
  }
  act(() => {
    useAgentStore.setState({ statusById });
  });
}

beforeEach(() => {
  useChatStore.setState({
    threads: [],
    messagesByThread: {},
    streamingByThread: {},
    noticesByThread: {},
    activeThreadId: null,
  });
  useAgentStore.setState({ roster: [], statusById: {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('App 停止 smart-stop heuristic (edge + adversarial)', () => {
  it('EXACTLY ONE working agent → cancel carries {threadId, agentId:<that one>} (targeted)', async () => {
    const socket = await mountBusyApp();
    // Only codex-gpt is working.
    setWorking(['codex-gpt']);

    await userEvent.click(screen.getByTestId('cancel-button'));

    const cancels = socket.emitted.filter((e) => e.event === 'cancel');
    expect(cancels).toHaveLength(1);
    expect(cancels[0].args[0]).toEqual({ threadId: 'thread_todo_api', agentId: 'codex-gpt' });
  });

  it('the single-working target is the ACTUAL working agent, not just the first roster entry', async () => {
    const socket = await mountBusyApp();
    // The lone worker is gemini-pro (3rd in the roster) — proves it is derived
    // from status, not position.
    setWorking(['gemini-pro']);

    await userEvent.click(screen.getByTestId('cancel-button'));

    const cancels = socket.emitted.filter((e) => e.event === 'cancel');
    expect(cancels).toHaveLength(1);
    expect(cancels[0].args[0]).toEqual({ threadId: 'thread_todo_api', agentId: 'gemini-pro' });
  });

  it('TWO working agents → cancel is a STOP-ALL {threadId} with NO agentId', async () => {
    const socket = await mountBusyApp();
    setWorking(['claude-opus', 'codex-gpt']);

    await userEvent.click(screen.getByTestId('cancel-button'));

    const cancels = socket.emitted.filter((e) => e.event === 'cancel');
    expect(cancels).toHaveLength(1);
    expect(cancels[0].args[0]).toEqual({ threadId: 'thread_todo_api' });
    expect((cancels[0].args[0] as Record<string, unknown>).agentId).toBeUndefined();
  });

  it('(adversarial) ALL THREE working → still a stop-all {threadId}, never a targeted cancel', async () => {
    const socket = await mountBusyApp();
    setWorking(['claude-opus', 'codex-gpt', 'gemini-pro']);

    await userEvent.click(screen.getByTestId('cancel-button'));

    const cancels = socket.emitted.filter((e) => e.event === 'cancel');
    expect(cancels).toHaveLength(1);
    expect(cancels[0].args[0]).toEqual({ threadId: 'thread_todo_api' });
  });

  it('(adversarial) ZERO working agents → stop-all {threadId} (no lone target to single out)', async () => {
    const socket = await mountBusyApp();
    // Everyone idle (the roster baseline) → working.length === 0 → undefined id.
    setWorking([]);

    await userEvent.click(screen.getByTestId('cancel-button'));

    const cancels = socket.emitted.filter((e) => e.event === 'cancel');
    expect(cancels).toHaveLength(1);
    expect(cancels[0].args[0]).toEqual({ threadId: 'thread_todo_api' });
  });

  it('(edge) transitioning from two-working to one-working flips stop-all → targeted on the next click', async () => {
    const socket = await mountBusyApp();
    setWorking(['claude-opus', 'codex-gpt']);
    await userEvent.click(screen.getByTestId('cancel-button'));

    // One finishes (idle); now only claude-opus is working.
    setWorking(['claude-opus']);
    await userEvent.click(screen.getByTestId('cancel-button'));

    const cancels = socket.emitted.filter((e) => e.event === 'cancel').map((e) => e.args[0]);
    expect(cancels).toHaveLength(2);
    expect(cancels[0]).toEqual({ threadId: 'thread_todo_api' }); // two working → stop-all
    expect(cancels[1]).toEqual({ threadId: 'thread_todo_api', agentId: 'claude-opus' }); // one → targeted
  });
});
