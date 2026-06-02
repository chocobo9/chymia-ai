// @vitest-environment jsdom
//
// M9 QA — G8 contract integration: the UI renders the agent turn INCREMENTALLY
// from socket `agent_event` frames, NOT from the POST /messages promise. We
// mount the full <App>, inject a fake ApiClient whose sendMessage() never
// resolves, and a mock socket connector. Pushing text/tool/thinking frames must
// fill the transcript while the POST is still pending; only after the POST
// resolves does the user message + reconciled replies appear.
//
// dev≠QA: authored by the M9 QA instance; no product code modified.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../packages/web/src/App.js';
import { ApiClient } from '../../packages/web/src/lib/api.js';
import type { SocketLike, SocketConnector } from '../../packages/web/src/hooks/useSocket.js';
import { useChatStore } from '../../packages/web/src/stores/chat-store.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import type { Thread, StoredMessage } from '@choco/shared';
import {
  CLAUDE,
  ROSTER,
  makeThread,
  makeUserMessage,
  makeAgentReply,
  textFrame,
  toolUseFrame,
  doneFrame,
} from './fixtures.js';

/** Mock socket that lets the test replay server→client frames into the app. */
class MockSocket implements SocketLike {
  readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly emitted: Array<{ event: string; args: unknown[] }> = [];
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

/**
 * A fake ApiClient whose sendMessage NEVER resolves (so the POST promise stays
 * pending) — proving the transcript fills purely from socket frames (G8).
 */
function makeClient(opts: {
  threads?: readonly Thread[];
  messages?: readonly StoredMessage[];
  sendImpl?: () => Promise<{ userMessage: StoredMessage; replies: readonly StoredMessage[] }>;
}): ApiClient {
  const client = new ApiClient({ baseUrl: 'http://test', fetchFn: () => Promise.reject(new Error('no network in test')) });
  vi.spyOn(client, 'listAgents').mockResolvedValue(ROSTER);
  vi.spyOn(client, 'listThreads').mockResolvedValue(opts.threads ?? [makeThread()]);
  vi.spyOn(client, 'getMessages').mockResolvedValue(opts.messages ?? []);
  vi.spyOn(client, 'sendMessage').mockImplementation(
    opts.sendImpl ?? (() => new Promise(() => {/* never resolves */})),
  );
  return client;
}

beforeEach(() => {
  useChatStore.setState({ threads: [], messagesByThread: {}, streamingByThread: {}, activeThreadId: null });
  useAgentStore.setState({ roster: [], statusById: {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('G8 — incremental render from socket frames (integration, adversarial)', () => {
  it('fills the transcript from agent_event frames while POST /messages stays PENDING', async () => {
    const socket = new MockSocket();
    const connector: SocketConnector = () => socket;
    const client = makeClient({ threads: [makeThread()] });

    render(<App client={client} socketConnector={connector} />);

    // Roster + threads load; select the thread to make it active (joins room).
    await screen.findByText('TODO API 设计与实现');
    await userEvent.click(screen.getByText('TODO API 设计与实现'));
    await waitFor(() => expect(useChatStore.getState().activeThreadId).toBe('thread_todo_api'));

    // Send a message — sendMessage() will hang (never resolves).
    const textarea = screen.getByTestId('chat-input-textarea');
    await userEvent.type(textarea, '@claude 写一个带 CRUD 的 TODO API');
    await userEvent.click(screen.getByTestId('chat-send-button'));
    expect(client.sendMessage).toHaveBeenCalledTimes(1);

    // RECONCILED (Bug 1 optimistic-send): the user message now shows IMMEDIATELY
    // on send — before the (still-pending) POST resolves and before any socket
    // frame — instead of only appearing once the whole turn completes.
    await waitFor(() => {
      expect(screen.getByTestId('user-message')).toHaveTextContent(
        '@claude 写一个带 CRUD 的 TODO API',
      );
    });

    // ...and socket frames drive the agent reply transcript incrementally.
    act(() => socket.fire('agent_event', textFrame(CLAUDE, '我先设计数据模型，', 1)));
    act(() => socket.fire('agent_event', toolUseFrame(CLAUDE, 'write_file', { path: 'src/todo.ts' }, 2)));
    act(() => socket.fire('agent_event', textFrame(CLAUDE, '再写 CRUD 路由。', 3)));

    await waitFor(() => {
      expect(screen.getByTestId('agent-text')).toHaveTextContent('我先设计数据模型，再写 CRUD 路由。');
    });
    expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument();
    expect(screen.getByTestId('tool-use-block')).toBeInTheDocument();

    // The optimistic user message stays put (single bubble) while POST is pending.
    expect(screen.getAllByTestId('user-message')).toHaveLength(1);
  });

  it('done frame drops the streaming view; the resolved POST then reconciles the persisted reply', async () => {
    const socket = new MockSocket();
    const resolved = {
      userMessage: makeUserMessage(),
      replies: [makeAgentReply()],
    };
    const client = makeClient({ threads: [makeThread()], sendImpl: () => Promise.resolve(resolved) });

    render(<App client={client} socketConnector={() => socket} />);
    await screen.findByText('TODO API 设计与实现');
    await userEvent.click(screen.getByText('TODO API 设计与实现'));
    await waitFor(() => expect(useChatStore.getState().activeThreadId).toBe('thread_todo_api'));

    await userEvent.type(screen.getByTestId('chat-input-textarea'), '@claude 写一个带 CRUD 的 TODO API');

    // Stream a partial turn first, before the POST resolves.
    act(() => socket.fire('agent_event', textFrame(CLAUDE, '流式输出中…', 1)));
    await waitFor(() => expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument());

    // Now click send: POST resolves → user bubble + reconciled reply appear.
    await userEvent.click(screen.getByTestId('chat-send-button'));
    await waitFor(() => {
      expect(screen.getByTestId('user-message')).toHaveTextContent('@claude 写一个带 CRUD 的 TODO API');
    });

    // done frame clears the live streaming buffer.
    act(() => socket.fire('agent_event', doneFrame(CLAUDE, 9)));
    await waitFor(() => {
      expect(screen.queryByTestId('streaming-indicator')).not.toBeInTheDocument();
    });
    expect(screen.getByText(/我已经实现了 TODO API/)).toBeInTheDocument();
  });

  it('a send failure surfaces the error banner without crashing the app', async () => {
    const socket = new MockSocket();
    const client = makeClient({
      threads: [makeThread()],
      sendImpl: () => Promise.reject(new Error('CLI 进程超时')),
    });
    render(<App client={client} socketConnector={() => socket} />);
    await screen.findByText('TODO API 设计与实现');
    await userEvent.click(screen.getByText('TODO API 设计与实现'));
    await waitFor(() => expect(useChatStore.getState().activeThreadId).toBe('thread_todo_api'));

    await userEvent.type(screen.getByTestId('chat-input-textarea'), '@claude 写代码');
    await userEvent.click(screen.getByTestId('chat-send-button'));

    await waitFor(() => {
      expect(screen.getByTestId('app-error')).toHaveTextContent('CLI 进程超时');
    });
    expect(screen.getByTestId('app-root')).toBeInTheDocument();
  });
});
