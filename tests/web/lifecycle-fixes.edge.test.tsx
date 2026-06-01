// @vitest-environment jsdom
//
// QA gating tests (dev≠QA, §0.5.3) for the three dogfood-found message-lifecycle
// UX fixes in the web client. Authored by a different instance than the one that
// wrote the product code; NO product code is modified here.
//
//   Bug 1 — optimistic user message: the user bubble appears IMMEDIATELY on send
//           (before the post-turn POST resolves and before any socket frame),
//           is replaced (deduped) by the persisted userMessage on resolve, and is
//           REMOVED on reject (no stuck phantom). Rapid double-send → two distinct
//           optimistic bubbles that both reconcile.
//   Bug 2 — busy-only stop: the 停止 (cancel) button renders ONLY while a turn is
//           in flight; at idle (even with an active thread) the send button shows
//           and 停止 is absent (never both). Clicking 停止 emits the socket cancel;
//           busy clears on both resolve and reject.
//   Bug 3a — tool/diff blocks survive completion: a persisted reply carrying
//           extra.toolEvents re-renders its tool/diff blocks; tool_result entries
//           are ignored, malformed entries don't crash, no-extra → no blocks.
//   Bug 3b (render half) — extra.thinking surfaces a thinking-block on a COMPLETED
//           reply (the persist half is gated in tests/api/lifecycle-thinking.*).
//
// Distribution of THIS file's tests: happy ≤50%, edge ≥30%, adversarial ≥20%.
// The build-App-with-fakes + never-resolving-send idioms mirror g8-incremental /
// choco-design.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../packages/web/src/App.js';
import { ChatContainer } from '../../packages/web/src/components/ChatContainer.js';
import { ApiClient } from '../../packages/web/src/lib/api.js';
import type { SocketLike, SocketConnector } from '../../packages/web/src/hooks/useSocket.js';
import { useChatStore } from '../../packages/web/src/stores/chat-store.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import type { StoredMessage, Thread } from '@clowder/shared';
import {
  CODEX,
  ROSTER,
  makeThread,
  makeUserMessage,
  makeAgentReply,
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

/** A deferred promise whose resolve/reject the test drives explicitly. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type SendResult = { userMessage: StoredMessage; replies: readonly StoredMessage[] };

interface ClientOptions {
  readonly threads?: readonly Thread[];
  readonly messages?: readonly StoredMessage[];
  readonly sendImpl?: (threadId: string, body: { content: string }) => Promise<SendResult>;
}

/** Build a fake ApiClient with stubbed network methods (no real fetch). */
function makeClient(opts: ClientOptions = {}): ApiClient {
  const client = new ApiClient({
    baseUrl: 'http://test',
    fetchFn: () => Promise.reject(new Error('no network in test')),
  });
  vi.spyOn(client, 'listAgents').mockResolvedValue(ROSTER);
  vi.spyOn(client, 'listThreads').mockResolvedValue(opts.threads ?? [makeThread()]);
  vi.spyOn(client, 'getMessages').mockResolvedValue(opts.messages ?? []);
  vi.spyOn(client, 'sendMessage').mockImplementation(
    opts.sendImpl ?? (() => new Promise<SendResult>(() => {/* never resolves */})),
  );
  return client;
}

/** Mount App with fakes and wait for the initial roster/threads load to settle. */
async function mountApp(opts: ClientOptions = {}): Promise<{ socket: MockSocket; client: ApiClient }> {
  const socket = new MockSocket();
  const connector: SocketConnector = () => socket;
  const client = makeClient(opts);
  render(<App client={client} socketConnector={connector} />);
  await waitFor(() => expect(useAgentStore.getState().roster.length).toBeGreaterThan(0));
  return { socket, client };
}

/** Select the default seeded thread and confirm it is active. */
async function selectDefaultThread(): Promise<void> {
  await screen.findByText('TODO API 设计与实现');
  await userEvent.click(screen.getByText('TODO API 设计与实现'));
  await waitFor(() => expect(useChatStore.getState().activeThreadId).toBe('thread_todo_api'));
}

const USER_TEXT = '@claude 写一个带 CRUD 的 TODO API';

beforeEach(() => {
  useChatStore.setState({
    threads: [],
    messagesByThread: {},
    streamingByThread: {},
    activeThreadId: null,
  });
  useAgentStore.setState({ roster: [], statusById: {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ============================================================================
 * Bug 1 — optimistic user message lifecycle.
 * ========================================================================== */
describe('Bug 1 — optimistic user message', () => {
  it('the user bubble appears IMMEDIATELY on send — before POST resolves and before any socket frame (edge)', async () => {
    const sent = deferred<SendResult>();
    const { socket } = await mountApp({ sendImpl: () => sent.promise });
    await selectDefaultThread();

    // Sanity: no user bubble yet, and NO socket frame has been fired.
    expect(screen.queryByTestId('user-message')).not.toBeInTheDocument();

    await userEvent.type(screen.getByTestId('chat-input-textarea'), USER_TEXT);
    await userEvent.click(screen.getByTestId('chat-send-button'));

    // The optimistic bubble is present while the POST is still pending and before
    // a single agent_event frame has arrived (the store has no streaming buffer).
    await waitFor(() => expect(screen.getByTestId('user-message')).toHaveTextContent(USER_TEXT));
    expect(screen.queryByTestId('agent-message')).not.toBeInTheDocument();
    expect(useChatStore.getState().streamingByThread['thread_todo_api']).toBeUndefined();
    // The store row is a true optimistic temp id (agentId null, origin user).
    const rows = useChatStore.getState().messagesByThread['thread_todo_api'] ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id.startsWith('optimistic-')).toBe(true);
    expect(rows[0]?.agentId).toBeNull();
    expect(rows[0]?.origin).toBe('user');
    // No socket frame was ever fired to produce this — proves it is optimistic.
    expect(socket.emitted.some((e) => e.event === 'agent_event')).toBe(false);
  });

  it('on POST resolve the optimistic temp is replaced by the persisted userMessage with NO duplicate (happy)', async () => {
    const persistedUser = makeUserMessage({ id: 'msg_user_persisted', content: USER_TEXT });
    const sent = deferred<SendResult>();
    await mountApp({ sendImpl: () => sent.promise });
    await selectDefaultThread();

    await userEvent.type(screen.getByTestId('chat-input-textarea'), USER_TEXT);
    await userEvent.click(screen.getByTestId('chat-send-button'));
    await waitFor(() => expect(screen.getByTestId('user-message')).toBeInTheDocument());

    // Resolve the POST: temp swapped for persisted, reply reconciled.
    await act(async () => {
      sent.resolve({ userMessage: persistedUser, replies: [makeAgentReply()] });
      await sent.promise;
    });

    await waitFor(() => {
      const rows = useChatStore.getState().messagesByThread['thread_todo_api'] ?? [];
      const userRows = rows.filter((m) => m.agentId === null);
      expect(userRows).toHaveLength(1);
      expect(userRows[0]?.id).toBe('msg_user_persisted');
    });
    // Exactly one user bubble (no duplicate); the reconciled reply landed.
    expect(screen.getAllByTestId('user-message')).toHaveLength(1);
    expect(screen.getByText(/我已经实现了 TODO API/)).toBeInTheDocument();
    // No leftover optimistic temp id anywhere.
    const rows = useChatStore.getState().messagesByThread['thread_todo_api'] ?? [];
    expect(rows.some((m) => m.id.startsWith('optimistic-'))).toBe(false);
  });

  it('adversarial: POST REJECTS → the optimistic bubble is REMOVED and the error surfaces (no stuck phantom)', async () => {
    const sent = deferred<SendResult>();
    await mountApp({ sendImpl: () => sent.promise });
    await selectDefaultThread();

    await userEvent.type(screen.getByTestId('chat-input-textarea'), USER_TEXT);
    await userEvent.click(screen.getByTestId('chat-send-button'));
    await waitFor(() => expect(screen.getByTestId('user-message')).toBeInTheDocument());

    await act(async () => {
      sent.reject(new Error('CLI 进程超时'));
      await sent.promise.catch(() => undefined);
    });

    // The phantom optimistic bubble is gone and the error is surfaced.
    await waitFor(() => expect(screen.getByTestId('app-error')).toHaveTextContent('CLI 进程超时'));
    expect(screen.queryByTestId('user-message')).not.toBeInTheDocument();
    const rows = useChatStore.getState().messagesByThread['thread_todo_api'] ?? [];
    expect(rows).toHaveLength(0);
    expect(screen.getByTestId('app-root')).toBeInTheDocument();
  });

  it('adversarial: two concurrent in-flight sends → two distinct optimistic bubbles, both reconcile with no dupes', () => {
    // The UI intentionally swaps send→停止 while busy (Bug 2), so two TRULY
    // concurrent sends can't both go through the send button. The concurrency the
    // optimistic path must survive — two temps outstanding, each resolving
    // independently — flows through the store actions App.sendMessage orchestrates.
    // Drive those product reducers directly to model the interleaving.
    const threadId = 'thread_todo_api';
    useAgentStore.setState({ roster: ROSTER, statusById: {} });
    useChatStore.setState({
      threads: [makeThread()],
      activeThreadId: threadId,
      messagesByThread: {},
      streamingByThread: {},
    });
    const store = useChatStore.getState();

    // Both sends fire before either POST resolves → two outstanding temps.
    const tempA = store.addOptimisticUserMessage(threadId, '@claude 先写数据模型', 1_700_000_000_001);
    const tempB = store.addOptimisticUserMessage(threadId, '@codex 再补集成测试', 1_700_000_000_002);

    const optimisticRows = (useChatStore.getState().messagesByThread[threadId] ?? []).filter((m) =>
      m.id.startsWith('optimistic-'),
    );
    expect(optimisticRows).toHaveLength(2);
    expect(tempA).not.toBe(tempB);
    expect(optimisticRows.map((m) => m.content)).toEqual(['@claude 先写数据模型', '@codex 再补集成测试']);

    // Resolve OUT OF ORDER (B before A) — each replace targets only its own temp.
    const userA = makeUserMessage({ id: 'msg_user_a', content: '@claude 先写数据模型' });
    const userB = makeUserMessage({ id: 'msg_user_b', content: '@codex 再补集成测试' });
    const replyB = makeAgentReply({ id: 'msg_reply_b', agentId: CODEX, userId: 'codex-gpt', content: 'Codex: 集成测试已补齐。' });
    useChatStore.getState().replaceOptimisticMessage(threadId, tempB, userB);
    useChatStore.getState().reconcileReplies([replyB]);
    useChatStore.getState().replaceOptimisticMessage(threadId, tempA, userA);
    useChatStore.getState().reconcileReplies([makeAgentReply()]);

    const rows = useChatStore.getState().messagesByThread[threadId] ?? [];
    const userRows = rows.filter((m) => m.agentId === null);
    // Both optimistic temps reconciled to their distinct persisted users, no dupes.
    expect(userRows.map((m) => m.id).sort()).toEqual(['msg_user_a', 'msg_user_b']);
    expect(rows.some((m) => m.id.startsWith('optimistic-'))).toBe(false);
    // Both reconciled replies landed exactly once.
    expect(rows.filter((m) => m.id === 'msg_agent_1')).toHaveLength(1);
    expect(rows.filter((m) => m.id === 'msg_reply_b')).toHaveLength(1);
  });
});

/* ============================================================================
 * Bug 2 — busy-only stop button.
 * ========================================================================== */
describe('Bug 2 — busy-only stop button', () => {
  it('at idle (active thread, no in-flight turn): send button present, 停止 absent (adversarial — the original bug)', async () => {
    await mountApp();
    await selectDefaultThread();
    // Active thread but idle: send shows, NO 停止 button — the original dogfood bug
    // surfaced 停止 at idle.
    expect(screen.getByTestId('chat-send-button')).toBeInTheDocument();
    expect(screen.queryByTestId('cancel-button')).not.toBeInTheDocument();
    expect(screen.queryByText('停止')).not.toBeInTheDocument();
  });

  it('while a turn is in flight (held send): 停止 present, send ABSENT (never both) (edge)', async () => {
    const sent = deferred<SendResult>();
    await mountApp({ sendImpl: () => sent.promise });
    await selectDefaultThread();

    await userEvent.type(screen.getByTestId('chat-input-textarea'), USER_TEXT);
    await userEvent.click(screen.getByTestId('chat-send-button'));

    // Busy: 停止 replaces send — never both at once.
    await screen.findByTestId('cancel-button');
    expect(screen.queryByTestId('chat-send-button')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('cancel-button')).getByText('停止')).toBeInTheDocument();
  });

  it('clicking 停止 emits the socket cancel for the ACTIVE thread (edge)', async () => {
    const sent = deferred<SendResult>();
    const { socket } = await mountApp({ sendImpl: () => sent.promise });
    await selectDefaultThread();

    await userEvent.type(screen.getByTestId('chat-input-textarea'), USER_TEXT);
    await userEvent.click(screen.getByTestId('chat-send-button'));
    await userEvent.click(await screen.findByTestId('cancel-button'));

    const cancels = socket.emitted.filter((e) => e.event === 'cancel');
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.args[0]).toEqual({ threadId: 'thread_todo_api' });
  });

  it('busy clears on POST RESOLVE → send returns, 停止 gone (happy)', async () => {
    const sent = deferred<SendResult>();
    await mountApp({ sendImpl: () => sent.promise });
    await selectDefaultThread();

    await userEvent.type(screen.getByTestId('chat-input-textarea'), USER_TEXT);
    await userEvent.click(screen.getByTestId('chat-send-button'));
    await screen.findByTestId('cancel-button');

    await act(async () => {
      sent.resolve({ userMessage: makeUserMessage(), replies: [makeAgentReply()] });
      await sent.promise;
    });

    await waitFor(() => expect(screen.getByTestId('chat-send-button')).toBeInTheDocument());
    expect(screen.queryByTestId('cancel-button')).not.toBeInTheDocument();
  });

  it('busy clears on POST REJECT → send returns, 停止 gone (edge)', async () => {
    const sent = deferred<SendResult>();
    await mountApp({ sendImpl: () => sent.promise });
    await selectDefaultThread();

    await userEvent.type(screen.getByTestId('chat-input-textarea'), USER_TEXT);
    await userEvent.click(screen.getByTestId('chat-send-button'));
    await screen.findByTestId('cancel-button');

    await act(async () => {
      sent.reject(new Error('CLI 进程崩溃'));
      await sent.promise.catch(() => undefined);
    });

    await waitFor(() => expect(screen.getByTestId('chat-send-button')).toBeInTheDocument());
    expect(screen.queryByTestId('cancel-button')).not.toBeInTheDocument();
  });
});

/* ============================================================================
 * Bug 3a — tool/diff blocks survive on a COMPLETED persisted reply.
 * (ChatContainer driven directly with seeded store state.)
 * ========================================================================== */
describe('Bug 3a — tool/diff blocks on a completed reply (from extra.toolEvents)', () => {
  beforeEach(() => {
    useAgentStore.setState({ roster: ROSTER, statusById: {} });
  });

  it('a completed reply with a tool_use renders a tool-use-block; a tool_result entry is IGNORED (edge)', () => {
    const completed = makeAgentReply({
      id: 'msg_reply_tool',
      extra: {
        toolEvents: [
          {
            type: 'tool_use',
            toolName: 'run_tests',
            toolUseId: 'tu_run',
            toolInput: { suite: 'todo-crud' },
            invocationId: 'inv_1',
            timestamp: 2,
          },
          // tool_result must NOT become a block.
          { type: 'tool_result', toolUseId: 'tu_run', content: '12 passed', invocationId: 'inv_1', timestamp: 3 },
        ],
      },
    });
    useChatStore.setState({
      threads: [makeThread()],
      activeThreadId: 'thread_todo_api',
      messagesByThread: { thread_todo_api: [makeUserMessage(), completed] },
      streamingByThread: {},
    });
    render(<ChatContainer />);

    // Completed (not streaming) yet the tool block renders from the persisted extra.
    expect(screen.queryByTestId('streaming-indicator')).not.toBeInTheDocument();
    const toolBlocks = screen.getAllByTestId('tool-use-block');
    expect(toolBlocks).toHaveLength(1); // exactly one — tool_result ignored
    expect(within(toolBlocks[0]!).getByText(/run_tests/)).toBeInTheDocument();
  });

  it('a tool_use carrying a real unified diff renders a DIFF block on the completed reply (edge)', () => {
    const diff =
      '--- a/packages/api/src/todo.ts\n' +
      '+++ b/packages/api/src/todo.ts\n' +
      '@@ -1,2 +1,4 @@\n' +
      '  export const router = Router()\n' +
      '-  router.get("/todos", listTodos)\n' +
      '+  router.get("/todos", listTodos)\n' +
      '+  router.post("/todos", createTodo)\n' +
      '+  router.delete("/todos/:id", deleteTodo)\n' +
      '  export default router';
    const completed = makeAgentReply({
      id: 'msg_reply_diff',
      extra: {
        toolEvents: [
          {
            type: 'tool_use',
            toolName: 'apply_patch',
            toolUseId: 'tu_patch',
            toolInput: { path: 'packages/api/src/todo.ts', diff },
            invocationId: 'inv_1',
            timestamp: 2,
          },
        ],
      },
    });
    useChatStore.setState({
      threads: [makeThread()],
      activeThreadId: 'thread_todo_api',
      messagesByThread: { thread_todo_api: [completed] },
      streamingByThread: {},
    });
    render(<ChatContainer />);

    const block = screen.getByTestId('diff-block');
    expect(within(block).getByText('packages/api/src/todo.ts')).toBeInTheDocument();
    expect(within(block).getByText('+3')).toBeInTheDocument();
    expect(within(block).getByText('−1')).toBeInTheDocument();
    expect(screen.queryByTestId('tool-use-block')).not.toBeInTheDocument();
  });

  it('adversarial: malformed extra.toolEvents entries are skipped without crashing', () => {
    const completed = makeAgentReply({
      id: 'msg_reply_malformed',
      extra: {
        toolEvents: [
          null,
          'not-an-object',
          42,
          { type: 'tool_use' }, // missing toolName → defaults to "tool"
          { type: 'tool_use', toolName: 'lint', toolInput: 'not-an-object', toolUseId: 7 },
          { notType: 'x' },
        ],
      },
    });
    useChatStore.setState({
      threads: [makeThread()],
      activeThreadId: 'thread_todo_api',
      messagesByThread: { thread_todo_api: [completed] },
      streamingByThread: {},
    });
    // Render must not throw on the malformed bag.
    expect(() => render(<ChatContainer />)).not.toThrow();
    // The two valid-typed tool_use entries become blocks; junk entries are skipped.
    const blocks = screen.getAllByTestId('tool-use-block');
    expect(blocks).toHaveLength(2);
    expect(screen.getByText(/lint/)).toBeInTheDocument();
  });

  it('a completed reply with NO extra renders no tool/diff/thinking blocks (happy)', () => {
    const completed = makeAgentReply({ id: 'msg_reply_plain' });
    useChatStore.setState({
      threads: [makeThread()],
      activeThreadId: 'thread_todo_api',
      messagesByThread: { thread_todo_api: [completed] },
      streamingByThread: {},
    });
    render(<ChatContainer />);

    expect(screen.queryByTestId('tool-use-block')).not.toBeInTheDocument();
    expect(screen.queryByTestId('diff-block')).not.toBeInTheDocument();
    expect(screen.queryByTestId('thinking-block')).not.toBeInTheDocument();
    expect(screen.getByTestId('agent-text')).toHaveTextContent('我已经实现了 TODO API');
  });
});

/* ============================================================================
 * Bug 3b (render half) — extra.thinking surfaces a thinking-block on completion.
 * ========================================================================== */
describe('Bug 3b — thinking-block on a completed reply (from extra.thinking)', () => {
  beforeEach(() => {
    useAgentStore.setState({ roster: ROSTER, statusById: {} });
  });

  it('storedToView surfaces extra.thinking → a collapsible thinking-block renders on the completed reply (edge)', async () => {
    const REASONING = '先确认数据模型：Todo { id, title, done }。再划分端点。';
    const completed = makeAgentReply({
      id: 'msg_reply_thinking',
      extra: { thinking: REASONING },
    });
    useChatStore.setState({
      threads: [makeThread()],
      activeThreadId: 'thread_todo_api',
      messagesByThread: { thread_todo_api: [completed] },
      streamingByThread: {},
    });
    render(<ChatContainer />);

    // Completed (no streaming indicator) yet the Think block is recovered.
    expect(screen.queryByTestId('streaming-indicator')).not.toBeInTheDocument();
    const block = screen.getByTestId('thinking-block');
    // Collapsed by default; reveal the reasoning body on toggle.
    expect(screen.queryByTestId('thinking-body')).not.toBeInTheDocument();
    await userEvent.click(within(block).getByRole('button'));
    expect(screen.getByTestId('thinking-body')).toHaveTextContent('先确认数据模型');
  });

  it('a non-string extra.thinking is ignored (no empty thinking-block) (adversarial)', () => {
    const completed = makeAgentReply({
      id: 'msg_reply_bad_thinking',
      extra: { thinking: { not: 'a string' } },
    });
    useChatStore.setState({
      threads: [makeThread()],
      activeThreadId: 'thread_todo_api',
      messagesByThread: { thread_todo_api: [completed] },
      streamingByThread: {},
    });
    expect(() => render(<ChatContainer />)).not.toThrow();
    expect(screen.queryByTestId('thinking-block')).not.toBeInTheDocument();
  });
});
