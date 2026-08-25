// @vitest-environment jsdom
//
// QA gating suite (dev≠QA, §0.5.3): §D frontend error/notice SURFACING. The
// silence-on-failure regression is gone — an `error` agent_event or a `system_info`
// notice frame is no longer silently dropped; it renders a VISIBLE bubble in the
// transcript, the streaming buffer is cleared, a persisted `system`-origin message
// renders too, duplicates collapse to one, and the notice bubble uses role=status
// (NOT a second `alert`, which the app-level error banner owns).
//
// Independently authored from the dev's product code (packages/web). Drives the
// FULL <App> with an injected fake ApiClient + a mock socket connector (the
// build-App-with-fakes idiom from choco-design.edge), plus directly seeded store
// state. NO product code modified.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../packages/web/src/App.js';
import { ApiClient } from '../../packages/web/src/lib/api.js';
import type { AgentRosterEntry } from '../../packages/web/src/lib/api.js';
import type { SocketLike, SocketConnector } from '../../packages/web/src/hooks/useSocket.js';
import { useChatStore } from '../../packages/web/src/stores/chat-store.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import type { AgentId, AgentMessage, StoredMessage, Thread } from '@choco/shared';
import {
  CLAUDE,
  CODEX,
  ROSTER,
  makeThread,
  makeUserMessage,
  makeAgentReply,
  textFrame,
  doneFrame,
} from './fixtures.js';

/** Mock socket that records emitted client events and replays server frames. */
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

interface ClientOptions {
  readonly roster?: readonly AgentRosterEntry[];
  readonly threads?: readonly Thread[];
  readonly messages?: readonly StoredMessage[];
}

function makeClient(opts: ClientOptions = {}): ApiClient {
  const client = new ApiClient({
    baseUrl: 'http://test',
    fetchFn: () => Promise.reject(new Error('no network in test')),
  });
  vi.spyOn(client, 'listAgents').mockResolvedValue(opts.roster ?? ROSTER);
  vi.spyOn(client, 'listThreads').mockResolvedValue(opts.threads ?? [makeThread()]);
  vi.spyOn(client, 'getMessages').mockResolvedValue(opts.messages ?? []);
  vi.spyOn(client, 'createThread').mockResolvedValue(
    makeThread({ id: 'thread_new', title: '新会话', participants: [] }),
  );
  vi.spyOn(client, 'sendMessage').mockResolvedValue({
    userMessage: makeUserMessage(),
    replies: [makeAgentReply()],
  });
  return client;
}

async function mountApp(opts: ClientOptions = {}): Promise<{ socket: MockSocket }> {
  const socket = new MockSocket();
  const connector: SocketConnector = () => socket;
  render(<App client={makeClient(opts)} socketConnector={connector} />);
  await waitFor(() => expect(useAgentStore.getState().roster.length).toBeGreaterThan(0));
  return { socket };
}

async function selectDefaultThread(): Promise<void> {
  const user = userEvent.setup();
  await screen.findByText('TODO API 设计与实现');
  await user.click(screen.getByText('TODO API 设计与实现'));
  await waitFor(() => expect(useChatStore.getState().activeThreadId).toBe('thread_todo_api'));
}

/** A `system_info` availability notice frame (the live broadcast shape). */
function systemInfoFrame(agentId: AgentId, content: string, ts: number): AgentMessage {
  return { type: 'system_info', agentId, content, invocationId: 'inv_notice', timestamp: ts };
}

/** An `error` agent_event frame (a failed agent turn). */
function errorFrame(agentId: AgentId, content: string, ts: number): AgentMessage {
  return { type: 'error', agentId, content, invocationId: 'inv_err', timestamp: ts };
}

/** A persisted `system`-origin StoredMessage (the durable notice copy). */
function systemMessage(agentId: AgentId, content: string, id = 'msg_sys_1'): StoredMessage {
  return {
    id,
    threadId: 'thread_todo_api',
    userId: 'user',
    agentId,
    content,
    mentions: [],
    origin: 'system',
    timestamp: 5,
  };
}

const CODEX_NOTICE = 'Codex 未启用（未检测到 CLI）— 可用：@claude';

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

describe('§D error agent_event → a VISIBLE error bubble (not silence)', () => {
  it('happy: an error frame for a turn with NO text renders a notice bubble carrying the reason', async () => {
    const { socket } = await mountApp();
    await selectDefaultThread();
    act(() => socket.fire('agent_event', errorFrame(CLAUDE, 'CLI 进程超时 (exit 124)', 9)));
    const notice = await screen.findByTestId('transcript-notice');
    expect(notice).toHaveAttribute('data-notice-kind', 'error');
    expect(notice).toHaveTextContent('CLI 进程超时 (exit 124)');
    // The user no longer stares at an empty transcript — the bubble is present.
    expect(screen.queryByTestId('empty-thread')).not.toBeInTheDocument();
  });

  it('edge: an error MID-stream clears the streaming buffer AND leaves a visible error bubble', async () => {
    const { socket } = await mountApp();
    await selectDefaultThread();
    act(() => socket.fire('agent_event', textFrame(CLAUDE, '部分输出…', 1)));
    await waitFor(() => expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument());
    act(() => socket.fire('agent_event', errorFrame(CLAUDE, '上游 CLI 进程意外退出 (exit 137)', 9)));
    // Streaming buffer cleared.
    await waitFor(() =>
      expect(screen.queryByTestId('streaming-indicator')).not.toBeInTheDocument(),
    );
    expect(useChatStore.getState().streamingByThread['thread_todo_api']).toBeUndefined();
    // The error is now VISIBLE, not dropped.
    const notice = screen.getByTestId('transcript-notice');
    expect(notice).toHaveAttribute('data-notice-kind', 'error');
    expect(notice).toHaveTextContent('exit 137');
  });

  it('adversarial: an error frame with NO content still renders a (fallback) error bubble — never silent', async () => {
    const { socket } = await mountApp();
    await selectDefaultThread();
    const bareError: AgentMessage = {
      type: 'error',
      agentId: CLAUDE,
      invocationId: 'inv_bare',
      timestamp: 9,
    };
    act(() => socket.fire('agent_event', bareError));
    const notice = await screen.findByTestId('transcript-notice');
    expect(notice).toHaveAttribute('data-notice-kind', 'error');
    // Fallback text is used — the bubble is non-empty.
    expect(notice.textContent?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('§D system_info notice → a VISIBLE notice bubble', () => {
  it('happy: a system_info availability notice renders a notice bubble with the exact text', async () => {
    const { socket } = await mountApp();
    await selectDefaultThread();
    act(() => socket.fire('agent_event', systemInfoFrame(CODEX, CODEX_NOTICE, 9)));
    const notice = await screen.findByTestId('transcript-notice');
    expect(notice).toHaveAttribute('data-notice-kind', 'notice');
    expect(notice).toHaveTextContent(CODEX_NOTICE);
    // It carries the agent it is about (drives roster styling).
    expect(notice).toHaveAttribute('data-agent', 'codex-gpt');
  });

  it('edge: a system_info about ANOTHER agent surfaces a notice but does NOT wipe a live stream (parallel-safe)', async () => {
    // Parallel @all reality: an unavailable-agent (codex) notice must NOT clear a
    // DIFFERENT agent's (claude) in-flight stream — that was the "输出到一半消失" bug.
    const { socket } = await mountApp();
    await selectDefaultThread();
    act(() => socket.fire('agent_event', textFrame(CLAUDE, '流式…', 1)));
    await waitFor(() => expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument());
    act(() => socket.fire('agent_event', systemInfoFrame(CODEX, CODEX_NOTICE, 9)));
    // The notice appears…
    expect(await screen.findByTestId('transcript-notice')).toHaveTextContent(CODEX_NOTICE);
    // …and Claude's live stream survives (codex's notice only clears codex).
    expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument();
  });
});

describe('§D persisted system message → renders as a notice bubble in history', () => {
  it('edge: a persisted system-origin message in history renders as a notice bubble (survives reload)', async () => {
    // Seed history with the durable system notice (as getByThread would return it).
    const persisted = systemMessage(CODEX, CODEX_NOTICE);
    useChatStore.setState({ messagesByThread: { thread_todo_api: [persisted] } });
    await mountApp({ messages: [persisted] });
    await selectDefaultThread();
    const notice = await screen.findByTestId('transcript-notice');
    expect(notice).toHaveAttribute('data-notice-kind', 'notice');
    expect(notice).toHaveTextContent(CODEX_NOTICE);
    // It is NOT rendered as a normal agent reply bubble.
    expect(screen.queryByTestId('agent-message')).not.toBeInTheDocument();
  });

  it('edge: persisted notice + a normal user message both render (notice does not swallow the turn)', async () => {
    const persisted = systemMessage(CODEX, CODEX_NOTICE);
    const user = makeUserMessage({ content: '@codex 帮我修一下 CI', mentions: [CODEX] });
    useChatStore.setState({ messagesByThread: { thread_todo_api: [user, persisted] } });
    await mountApp({ messages: [user, persisted] });
    await selectDefaultThread();
    expect(await screen.findByTestId('transcript-notice')).toHaveTextContent(CODEX_NOTICE);
    expect(screen.getByTestId('user-message')).toHaveTextContent('@codex 帮我修一下 CI');
  });
});

describe('§D dedup — the same notice live + persisted shows ONCE', () => {
  it('edge: a live system_info matching a persisted system message renders a single bubble', async () => {
    // Seed the persisted (durable) copy first.
    const persisted = systemMessage(CODEX, CODEX_NOTICE);
    useChatStore.setState({ messagesByThread: { thread_todo_api: [persisted] } });
    const { socket } = await mountApp({ messages: [persisted] });
    await selectDefaultThread();
    // Then fire the matching live notice (same agent + text).
    act(() => socket.fire('agent_event', systemInfoFrame(CODEX, CODEX_NOTICE, 9)));
    await waitFor(() =>
      expect(screen.getByTestId('transcript-notice')).toHaveTextContent(CODEX_NOTICE),
    );
    // Exactly ONE bubble — the live copy is suppressed in favor of the persisted one.
    expect(screen.getAllByTestId('transcript-notice')).toHaveLength(1);
  });

  it('edge: the same live notice fired TWICE (same id) dedupes to one bubble', async () => {
    const { socket } = await mountApp();
    await selectDefaultThread();
    const frame = systemInfoFrame(CODEX, CODEX_NOTICE, 9); // same invocationId → same id
    act(() => socket.fire('agent_event', frame));
    act(() => socket.fire('agent_event', frame));
    await waitFor(() => expect(screen.getByTestId('transcript-notice')).toBeInTheDocument());
    expect(screen.getAllByTestId('transcript-notice')).toHaveLength(1);
    // Store-level dedup: only one notice recorded for the thread.
    expect(useChatStore.getState().noticesByThread['thread_todo_api']).toHaveLength(1);
  });
});

describe('§D a11y — notice is role=status, not a second alert', () => {
  it('edge: a notice bubble exposes role=status (a polite live region)', async () => {
    const { socket } = await mountApp();
    await selectDefaultThread();
    act(() => socket.fire('agent_event', systemInfoFrame(CODEX, CODEX_NOTICE, 9)));
    const notice = await screen.findByTestId('transcript-notice');
    expect(notice).toHaveAttribute('role', 'status');
  });

  it('adversarial: a transcript notice does NOT introduce a second alert role (the banner owns alert)', async () => {
    const { socket } = await mountApp();
    await selectDefaultThread();
    // Fire a transcript-notice AND a socket `error` (which surfaces the alert banner).
    act(() => socket.fire('agent_event', systemInfoFrame(CODEX, CODEX_NOTICE, 9)));
    await screen.findByTestId('transcript-notice');
    act(() => socket.fire('error', { message: '上游模型已降级' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('上游模型已降级');
    // Still exactly ONE alert role on the page — the transcript notice is status, not alert.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    // The transcript notice is found via role=status (proving it is not the alert).
    expect(screen.getByRole('status')).toHaveAttribute('data-testid', 'transcript-notice');
  });

  it('edge: a done frame still clears streaming and does NOT create a notice bubble (no false positive)', async () => {
    const { socket } = await mountApp();
    await selectDefaultThread();
    act(() => socket.fire('agent_event', textFrame(CLAUDE, '输出中…', 1)));
    await waitFor(() => expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument());
    act(() => socket.fire('agent_event', doneFrame(CLAUDE, 9)));
    await waitFor(() =>
      expect(screen.queryByTestId('streaming-indicator')).not.toBeInTheDocument(),
    );
    // A clean done is not an error/notice — no transcript-notice bubble.
    expect(screen.queryByTestId('transcript-notice')).not.toBeInTheDocument();
  });
});
