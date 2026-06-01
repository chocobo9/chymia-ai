// @vitest-environment jsdom
//
// QA gating tests for the .d-choco core-workspace redesign (Part A). dev≠QA
// (§0.5.3): authored by a different instance than the one that wrote the product
// code in packages/web. NO product code modified.
//
// These drive the FULL <App> with an injected fake ApiClient + a mock socket
// connector (the build-App-with-fakes idiom established in g8-incremental), plus
// directly seeded store state, to gate:
//   • socket agent_event frames → the correct rich blocks (text/tool/diff/
//     thinking/streaming) and done/error clearing streaming; a non-diff edit
//     tool STAYS a tool block.
//   • agent_status idle→working→thinking→idle → StatusBar dot/data-status AND the
//     header online/idle chip.
//   • @mention autocomplete: live roster, CJK alias filter, in-place insert,
//     adversarial dismissal — driven through the real composer.
//   • empty/honest states: empty thread, honest-empty status bar, deferred
//     controls (bell/panel/owner-gear) present but inert.
//   • wiring/a11y intact: every dev-listed testid resolves; select/create/send
//     call the injected client; cancel emits via socket; ARIA preserved.
//   • accent/identity derive from the REAL roster color.primary/name (not
//     hardcoded), so a roster with different colors/names reflects.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../packages/web/src/App.js';
import { ApiClient } from '../../packages/web/src/lib/api.js';
import type { AgentRosterEntry } from '../../packages/web/src/lib/api.js';
import type { SocketLike, SocketConnector } from '../../packages/web/src/hooks/useSocket.js';
import { useChatStore } from '../../packages/web/src/stores/chat-store.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import type { AgentId, AgentMessage, AgentState, StoredMessage, Thread } from '@clowder/shared';
import { createAgentId } from '@clowder/shared';
import {
  CLAUDE,
  CODEX,
  GEMINI,
  ROSTER,
  makeThread,
  makeUserMessage,
  makeAgentReply,
  textFrame,
  thinkingFrame,
  toolUseFrame,
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
  readonly created?: Thread;
  readonly sendImpl?: () => Promise<{ userMessage: StoredMessage; replies: readonly StoredMessage[] }>;
}

/** Build a fake ApiClient with stubbed network methods (no real fetch). */
function makeClient(opts: ClientOptions = {}): ApiClient {
  const client = new ApiClient({
    baseUrl: 'http://test',
    fetchFn: () => Promise.reject(new Error('no network in test')),
  });
  vi.spyOn(client, 'listAgents').mockResolvedValue(opts.roster ?? ROSTER);
  vi.spyOn(client, 'listThreads').mockResolvedValue(opts.threads ?? [makeThread()]);
  vi.spyOn(client, 'getMessages').mockResolvedValue(opts.messages ?? []);
  vi.spyOn(client, 'createThread').mockResolvedValue(
    opts.created ?? makeThread({ id: 'thread_new', title: '新会话', participants: [] }),
  );
  vi.spyOn(client, 'sendMessage').mockImplementation(
    opts.sendImpl ??
      (() => Promise.resolve({ userMessage: makeUserMessage(), replies: [makeAgentReply()] })),
  );
  return client;
}

/** Mount App with fakes and wait for the initial roster/threads load to settle. */
async function mountApp(opts: ClientOptions = {}): Promise<{ socket: MockSocket; client: ApiClient }> {
  const socket = new MockSocket();
  const connector: SocketConnector = () => socket;
  const client = makeClient(opts);
  render(<App client={client} socketConnector={connector} />);
  // Roster populates the agent store after the initial load resolves.
  await waitFor(() => expect(useAgentStore.getState().roster.length).toBeGreaterThan(0));
  return { socket, client };
}

/** Select the default seeded thread (title from makeThread) and confirm active. */
async function selectDefaultThread(): Promise<void> {
  const user = userEvent.setup();
  await screen.findByText('TODO API 设计与实现');
  await user.click(screen.getByText('TODO API 设计与实现'));
  await waitFor(() => expect(useChatStore.getState().activeThreadId).toBe('thread_todo_api'));
}

beforeEach(() => {
  useChatStore.setState({
    threads: [],
    messagesByThread: {},
    streamingByThread: {},
    // Reset the §D transcript-notice map too, so an error/notice frame fired in
    // one test (e.g. the "ERROR frame clears streaming" case) does not leak a
    // visible notice into a later same-thread test (empty-state / alert-count).
    noticesByThread: {},
    activeThreadId: null,
  });
  useAgentStore.setState({ roster: [], statusById: {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ============================================================================
 * 1. Socket agent_event frames render the right rich blocks. (happy + edge)
 * ========================================================================== */
describe('socket agent_event → rich blocks', () => {
  it('a text frame renders agent prose inside the bubble (.body / agent-text)', async () => {
    const { socket } = await mountApp();
    await selectDefaultThread();
    act(() =>
      socket.fire('agent_event', textFrame(CLAUDE, '我已实现 TODO API，含 zod 校验。', 1)),
    );
    await waitFor(() =>
      expect(screen.getByTestId('agent-text')).toHaveTextContent('我已实现 TODO API，含 zod 校验。'),
    );
    // The text lives inside the .bubble structure of an agent message.
    const msg = screen.getByTestId('agent-message');
    expect(within(msg).getByTestId('agent-text')).toHaveClass('body');
  });

  it('a plain edit tool (path only, no patch) renders as a TOOL block — NOT a diff', async () => {
    const { socket } = await mountApp();
    await selectDefaultThread();
    // write_file matches the edit-tool name but carries no diff payload → tool.
    act(() =>
      socket.fire(
        'agent_event',
        toolUseFrame(CODEX, 'write_file', { path: 'packages/api/src/todo.ts' }, 2),
      ),
    );
    await waitFor(() => expect(screen.getByTestId('tool-use-block')).toBeInTheDocument());
    expect(screen.queryByTestId('diff-block')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('tool-use-block')).getByText(/write_file/)).toBeInTheDocument();
  });

  it('an edit tool carrying a real unified diff renders a DIFF block with correct +/- counts', async () => {
    const { socket } = await mountApp();
    await selectDefaultThread();
    const diff =
      '--- a/packages/cli/src/bootstrap.ts\n' +
      '+++ b/packages/cli/src/bootstrap.ts\n' +
      '@@ -1,2 +1,4 @@\n' +
      '  export async function init() {\n' +
      '-   await runAll(STEPS)\n' +
      '+   const ck = loadCheckpoint()\n' +
      '+   for (const step of STEPS) ck.run(step)\n' +
      '+   persist(ck)\n' +
      '  }';
    act(() =>
      socket.fire(
        'agent_event',
        toolUseFrame(CODEX, 'apply_patch', { path: 'packages/cli/src/bootstrap.ts', diff }, 3),
      ),
    );
    const block = await screen.findByTestId('diff-block');
    expect(within(block).getByText('packages/cli/src/bootstrap.ts')).toBeInTheDocument();
    expect(within(block).getByText('+3')).toBeInTheDocument();
    expect(within(block).getByText('−1')).toBeInTheDocument();
    expect(screen.queryByTestId('tool-use-block')).not.toBeInTheDocument();
  });

  it('a thinking frame renders a collapsible THINKING block (collapsed by default)', async () => {
    const { socket } = await mountApp();
    await selectDefaultThread();
    act(() =>
      socket.fire(
        'agent_event',
        thinkingFrame(CLAUDE, '先确认数据模型\n再决定端点划分\n最后加 zod 校验', 1),
      ),
    );
    const think = await screen.findByTestId('thinking-block');
    // Collapsed: the body is not yet in the DOM until toggled.
    expect(screen.queryByTestId('thinking-body')).not.toBeInTheDocument();
    await userEvent.click(within(think).getByRole('button'));
    const body = screen.getByTestId('thinking-body');
    expect(within(body).getByText('先确认数据模型')).toBeInTheDocument();
    expect(within(body).getByText('最后加 zod 校验')).toBeInTheDocument();
  });

  it('streaming before done shows the streaming indicator; done CLEARS it', async () => {
    const { socket } = await mountApp();
    await selectDefaultThread();
    act(() => socket.fire('agent_event', textFrame(CLAUDE, '流式输出中…', 1)));
    await waitFor(() => expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument());
    act(() => socket.fire('agent_event', doneFrame(CLAUDE, 9)));
    await waitFor(() =>
      expect(screen.queryByTestId('streaming-indicator')).not.toBeInTheDocument(),
    );
    // The streaming buffer is dropped from the store on done.
    expect(useChatStore.getState().streamingByThread['thread_todo_api']).toBeUndefined();
  });

  it('an ERROR frame also clears the streaming buffer without crashing (adversarial)', async () => {
    const { socket } = await mountApp();
    await selectDefaultThread();
    act(() => socket.fire('agent_event', textFrame(CLAUDE, '部分输出…', 1)));
    await waitFor(() => expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument());
    const errorFrame: AgentMessage = {
      type: 'error',
      agentId: CLAUDE,
      content: 'CLI 进程超时',
      invocationId: 'inv_1',
      timestamp: 9,
    };
    act(() => socket.fire('agent_event', errorFrame));
    await waitFor(() =>
      expect(screen.queryByTestId('streaming-indicator')).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('app-root')).toBeInTheDocument();
  });

  it('text+thinking+tool frames for ONE turn fold into a single agent message (edge)', async () => {
    const { socket } = await mountApp();
    await selectDefaultThread();
    act(() => socket.fire('agent_event', thinkingFrame(CLAUDE, '先想清楚再写。', 1)));
    act(() => socket.fire('agent_event', textFrame(CLAUDE, '我先设计数据模型，', 2)));
    act(() =>
      socket.fire('agent_event', toolUseFrame(CLAUDE, 'run_tests', { suite: 'todo' }, 3)),
    );
    act(() => socket.fire('agent_event', textFrame(CLAUDE, '再写 CRUD 路由。', 4)));
    await waitFor(() =>
      expect(screen.getByTestId('agent-text')).toHaveTextContent('我先设计数据模型，再写 CRUD 路由。'),
    );
    // One folded turn → exactly one agent message carrying all three block kinds.
    expect(screen.getAllByTestId('agent-message')).toHaveLength(1);
    expect(screen.getByTestId('thinking-block')).toBeInTheDocument();
    expect(screen.getByTestId('tool-use-block')).toBeInTheDocument();
  });
});

/* ============================================================================
 * 2. agent_status → StatusBar + header chip. (happy + edge)
 * ========================================================================== */
describe('agent_status frames → StatusBar dot + header chip', () => {
  function statusFrame(id: AgentId, status: AgentState['status']): AgentState {
    return { id, status, currentThreadId: 'thread_todo_api', lastActiveAt: 100 };
  }

  it('idle→working→thinking→idle reflects in the StatusBar item data-status', async () => {
    const { socket } = await mountApp();
    await selectDefaultThread();

    const claudeItem = (): HTMLElement | undefined =>
      screen.getAllByTestId('agent-status-item').find((el) => el.getAttribute('data-agent') === 'claude-opus');

    // baseline roster status is idle.
    await waitFor(() => expect(claudeItem()).toHaveAttribute('data-status', 'idle'));

    act(() => socket.fire('agent_status', statusFrame(CLAUDE, 'working')));
    await waitFor(() => expect(claudeItem()).toHaveAttribute('data-status', 'working'));

    act(() => socket.fire('agent_status', statusFrame(CLAUDE, 'thinking')));
    await waitFor(() => expect(claudeItem()).toHaveAttribute('data-status', 'thinking'));

    act(() => socket.fire('agent_status', statusFrame(CLAUDE, 'idle')));
    await waitFor(() => expect(claudeItem()).toHaveAttribute('data-status', 'idle'));
  });

  it('a working agent paints its status dot with the roster accent color (edge)', async () => {
    const { socket } = await mountApp();
    await selectDefaultThread();
    act(() => socket.fire('agent_status', statusFrame(GEMINI, 'working')));
    await waitFor(() => {
      const item = screen
        .getAllByTestId('agent-status-item')
        .find((el) => el.getAttribute('data-agent') === 'gemini-pro');
      expect(item).toHaveAttribute('data-status', 'working');
      const dot = within(item as HTMLElement).getByTestId('agent-status-dot');
      // Gemini's roster color.primary is #f59e0b → rgb(245,158,11).
      expect(dot).toHaveStyle({ background: 'rgb(245, 158, 11)' });
    });
  });

  it('the header chip reflects online vs idle counts and updates as statuses change', async () => {
    const { socket } = await mountApp();
    await selectDefaultThread();
    // All 3 rostered agents start idle → 3 online · 3 idle.
    await waitFor(() => expect(screen.getByText(/3 online · 3 idle/)).toBeInTheDocument());
    // Two go to working → still 3 online, only 1 idle.
    act(() => socket.fire('agent_status', statusFrame(CLAUDE, 'working')));
    act(() => socket.fire('agent_status', statusFrame(CODEX, 'thinking')));
    await waitFor(() => expect(screen.getByText(/3 online · 1 idle/)).toBeInTheDocument());
    // One goes offline → 2 online.
    act(() => socket.fire('agent_status', statusFrame(GEMINI, 'offline')));
    await waitFor(() => expect(screen.getByText(/2 online · 0 idle/)).toBeInTheDocument());
  });

  it('the status-bar mode flips 待命 → 协作中 when any agent is working (edge)', async () => {
    const { socket } = await mountApp();
    await selectDefaultThread();
    const mode = (): Element | null => document.querySelector('.sb-mode b');
    await waitFor(() => expect(mode()).toHaveTextContent('待命'));
    act(() => socket.fire('agent_status', statusFrame(CODEX, 'working')));
    await waitFor(() => expect(mode()).toHaveTextContent('协作中'));
  });
});

/* ============================================================================
 * 3. @mention autocomplete driven through the real composer. (edge + adv)
 * ========================================================================== */
describe('@mention autocomplete (live roster)', () => {
  it('typing "@" surfaces suggestions from the LIVE roster (9 patterns, 3×3)', async () => {
    await mountApp();
    await selectDefaultThread();
    await userEvent.type(screen.getByTestId('chat-input-textarea'), '@');
    const dropdown = await screen.findByTestId('mention-suggestions');
    expect(dropdown).toHaveClass('mentions');
    expect(within(dropdown).getAllByTestId('mention-suggestion')).toHaveLength(9);
  });

  it('"@cl" filters to the Claude latin patterns only (edge)', async () => {
    await mountApp();
    await selectDefaultThread();
    await userEvent.type(screen.getByTestId('chat-input-textarea'), '@cl');
    const patterns = screen
      .getAllByTestId('mention-suggestion')
      .map((s) => s.getAttribute('data-pattern'));
    expect(patterns).toEqual(['@claude']);
  });

  it('a CJK alias "@橘" filters to Codex\'s "@橘猫" and excludes others (edge)', async () => {
    await mountApp();
    await selectDefaultThread();
    await userEvent.type(screen.getByTestId('chat-input-textarea'), '@橘');
    const patterns = screen
      .getAllByTestId('mention-suggestion')
      .map((s) => s.getAttribute('data-pattern'));
    expect(patterns).toContain('@橘猫');
    expect(patterns).not.toContain('@claude');
    expect(patterns).not.toContain('@gemini');
  });

  it('selecting a suggestion inserts the mention WITHOUT clobbering preceding text', async () => {
    await mountApp();
    await selectDefaultThread();
    const ta = screen.getByTestId('chat-input-textarea') as HTMLTextAreaElement;
    await userEvent.type(ta, '先让 @gem');
    await userEvent.click(screen.getByText('@gemini'));
    expect(ta.value).toBe('先让 @gemini ');
    // Dropdown dismisses after the completed token (trailing space, no @token).
    expect(screen.queryByTestId('mention-suggestions')).not.toBeInTheDocument();
  });

  it('adversarial: "@" mid-word ("issue@cl") does NOT trigger the dropdown', async () => {
    await mountApp();
    await selectDefaultThread();
    await userEvent.type(screen.getByTestId('chat-input-textarea'), 'issue@cl');
    expect(screen.queryByTestId('mention-suggestions')).not.toBeInTheDocument();
  });

  it('adversarial: a no-match token "@zzz" shows no suggestions', async () => {
    await mountApp();
    await selectDefaultThread();
    await userEvent.type(screen.getByTestId('chat-input-textarea'), '@zzz');
    expect(screen.queryByTestId('mention-suggestions')).not.toBeInTheDocument();
  });

  it('adversarial: a SECOND "@" mid-message triggers afresh on the new token', async () => {
    await mountApp();
    await selectDefaultThread();
    await userEvent.type(
      screen.getByTestId('chat-input-textarea'),
      '@claude 你定架构，然后 @cod',
    );
    const patterns = screen
      .getAllByTestId('mention-suggestion')
      .map((s) => s.getAttribute('data-pattern'));
    expect(patterns).toContain('@codex');
    expect(patterns).not.toContain('@claude');
  });
});

/* ============================================================================
 * 4. Empty / honest states + deferred controls inert. (edge + adv)
 * ========================================================================== */
describe('empty / honest states + deferred controls', () => {
  it('a thread with no messages shows the empty-thread state (no fabricated content)', async () => {
    await mountApp({ messages: [] });
    await selectDefaultThread();
    expect(await screen.findByTestId('empty-thread')).toBeInTheDocument();
    expect(screen.queryByTestId('user-message')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-message')).not.toBeInTheDocument();
    // Design mock prose like "bootstrap" / "--resume" must NOT be fabricated.
    expect(screen.queryByText(/--resume/)).not.toBeInTheDocument();
  });

  it('the status bar shows HONEST empties, not the design mock numbers (adversarial)', async () => {
    await mountApp({ messages: [] });
    await selectDefaultThread();
    // 消息统计 totals are computed from real (empty) data → 0, not mock "12".
    await waitFor(() => {
      const stats = Array.from(document.querySelectorAll('.sb-stat')).map((el) => el.textContent ?? '');
      expect(stats.some((t) => /总数0/.test(t.replace(/\s/g, '')))).toBe(true);
    });
    expect(screen.queryByText('12 messages')).not.toBeInTheDocument();
    // Audit feed has no backend → honest empty, not fabricated rows.
    expect(screen.getByText('暂无审计记录。')).toBeInTheDocument();
    // Session Chain shows 0 session for an empty thread.
    expect(screen.getByText(/0 session/)).toBeInTheDocument();
  });

  // RECONCILED (overlays dev wave): the bell + panel buttons were previously
  // `disabled` placeholders ("…（即将上线）"). They are now REAL overlay triggers
  // (NotifInbox / WorkspacePanel), so they are enabled and carry the final
  // aria-labels. The shell-level *deferred* no-ops that remain are the StatusBar's
  // ＋ 绑定外部 Session button and the 查看日志 link — assert those stay inert.
  it('shell controls: bell/panel are real (enabled) triggers; remaining StatusBar affordances stay inert', async () => {
    await mountApp();
    await selectDefaultThread();
    const bell = screen.getByLabelText('待你处理');
    const panel = screen.getByLabelText('打开 Workspace');
    expect(bell).toBeEnabled();
    expect(panel).toBeEnabled();
    // The owner footer is now a real trigger but its label/text is preserved.
    expect(screen.getByText('project owner')).toBeInTheDocument();
    // Still-deferred StatusBar affordances remain inert (no backend yet).
    const bind = screen.getByText('＋ 绑定外部 Session');
    expect(bind).toBeDisabled();
    await userEvent.click(screen.getByText('查看日志')); // disabled span, inert
    expect(screen.getByTestId('app-root')).toBeInTheDocument();
  });

  it('with NO thread selected, the center + status columns show honest unselected labels', async () => {
    await mountApp();
    // Do not select a thread.
    await waitFor(() => expect(useAgentStore.getState().roster.length).toBe(3));
    expect(useChatStore.getState().activeThreadId).toBeNull();
    // The center main-bar title shows the unselected label (it also appears in
    // the status bar's Thread row, so scope to .main-title here).
    expect(document.querySelector('.main-title')).toHaveTextContent('未选择会话');
    // Composer is disabled until a thread is active.
    expect(screen.getByTestId('chat-input-textarea')).toBeDisabled();
  });
});

/* ============================================================================
 * 5. Wiring / a11y intact. (adversarial + edge)
 * ========================================================================== */
describe('wiring / a11y intact', () => {
  it('every dev-listed testid resolves on the mounted populated app', async () => {
    useChatStore.setState({
      messagesByThread: { thread_todo_api: [makeUserMessage(), makeAgentReply()] },
    });
    // RECONCILED (Bug 2 busy-only stop): the cancel/stop button now renders ONLY
    // while a turn is in flight (busy), so we hold a never-resolving send to keep
    // the composer busy — at idle the send button shows instead (asserted below).
    await mountApp({ messages: [makeUserMessage(), makeAgentReply()], sendImpl: () => new Promise(() => {}) });
    await selectDefaultThread();
    // At idle: send button present, no cancel/stop button.
    expect(screen.getByTestId('chat-send-button')).toBeInTheDocument();
    expect(screen.queryByTestId('cancel-button')).not.toBeInTheDocument();
    // Go busy → the 停止 (cancel) button replaces send.
    await userEvent.type(screen.getByTestId('chat-input-textarea'), '@claude 写代码');
    await userEvent.click(screen.getByTestId('chat-send-button'));
    await screen.findByTestId('cancel-button');
    for (const id of [
      'app-root',
      'thread-list',
      'new-thread-button',
      'thread-item',
      'chat-container',
      'chat-input',
      'chat-input-textarea',
      'agent-status',
      'cancel-button',
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    // thread-item carries its data-thread + aria-current wiring hooks.
    const item = screen.getByTestId('thread-item');
    expect(item).toHaveAttribute('data-thread', 'thread_todo_api');
    expect(item).toHaveAttribute('aria-current', 'true');
    // user + agent messages render with their testids; agent carries data-agent.
    // (Two user bubbles now: the seeded one + the optimistic one from the busy
    // send above — Bug 1 inserts the user message immediately on send.)
    expect(screen.getAllByTestId('user-message').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTestId('agent-message')[0]).toHaveAttribute('data-agent', 'claude-opus');
  });

  it('select / create / send each call the injected client (no real backend dependency)', async () => {
    const created = makeThread({ id: 'thread_created', title: '新建的会话', participants: [] });
    const { client } = await mountApp({ created });

    // create → client.createThread.
    await userEvent.click(screen.getByTestId('new-thread-button'));
    await waitFor(() => expect(client.createThread).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useChatStore.getState().activeThreadId).toBe('thread_created'));

    // select an existing thread → client.getMessages for that id.
    await userEvent.click(screen.getByText('TODO API 设计与实现'));
    await waitFor(() => expect(client.getMessages).toHaveBeenCalledWith('thread_todo_api'));

    // send → client.sendMessage on the active thread.
    await userEvent.type(screen.getByTestId('chat-input-textarea'), '@claude 写一个带 CRUD 的 TODO API');
    await userEvent.click(screen.getByTestId('chat-send-button'));
    await waitFor(() =>
      expect(client.sendMessage).toHaveBeenCalledWith('thread_todo_api', {
        content: '@claude 写一个带 CRUD 的 TODO API',
      }),
    );
  });

  it('the cancel/stop button EMITS a cancel frame over the socket for the active thread', async () => {
    // RECONCILED (Bug 2 busy-only stop): the cancel button only renders while a
    // turn is in flight, so hold a never-resolving send to surface it, then click.
    const { socket } = await mountApp({ sendImpl: () => new Promise(() => {}) });
    await selectDefaultThread();
    await userEvent.type(screen.getByTestId('chat-input-textarea'), '@claude 写代码');
    await userEvent.click(screen.getByTestId('chat-send-button'));
    await userEvent.click(await screen.findByTestId('cancel-button'));
    const cancels = socket.emitted.filter((e) => e.event === 'cancel');
    expect(cancels).toHaveLength(1);
    expect(cancels[0].args[0]).toEqual({ threadId: 'thread_todo_api' });
  });

  it('ARIA roles/labels are preserved (listbox/option dropdown, alert banner)', async () => {
    const { socket } = await mountApp();
    await selectDefaultThread();
    // mention dropdown exposes listbox/option roles.
    await userEvent.type(screen.getByTestId('chat-input-textarea'), '@cl');
    expect(screen.getByRole('listbox')).toBe(screen.getByTestId('mention-suggestions'));
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
    // an error socket frame surfaces an alert-role banner.
    act(() => socket.fire('error', { message: '上游模型已降级' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('上游模型已降级');
  });
});

/* ============================================================================
 * 6. Accent / identity derive from the REAL roster, not hardcoded. (edge + adv)
 * ========================================================================== */
describe('accent / identity from the live roster', () => {
  it('agent name + accent color come from the roster color.primary (not a mock table)', async () => {
    useChatStore.setState({ messagesByThread: { thread_todo_api: [makeAgentReply()] } });
    await mountApp({ messages: [makeAgentReply()] });
    await selectDefaultThread();
    const msg = await screen.findByTestId('agent-message');
    // accent flows to --ac (roster claude color.primary = #6366f1) and the name color.
    expect(msg).toHaveStyle({ '--ac': '#6366f1' });
    const name = within(msg).getByText('Claude (Opus)');
    expect(name).toHaveStyle({ color: 'rgb(99, 102, 241)' });
  });

  it('adversarial: a DIFFERENT roster (recolored + renamed) reflects, proving no hardcoding', async () => {
    const RECOLORED: readonly AgentRosterEntry[] = [
      {
        id: 'claude-opus',
        name: '布偶猫',
        displayName: 'Athena (Sonnet)',
        clientId: 'anthropic',
        color: { primary: '#e11d48', secondary: '#fb7185' },
        mentionPatterns: ['@athena'],
        strengths: ['架构设计'],
        status: 'idle',
      },
    ];
    const reply: StoredMessage = {
      id: 'msg_recolored',
      threadId: 'thread_todo_api',
      userId: 'claude-opus',
      agentId: createAgentId('claude-opus'),
      content: '已按新方案重构。',
      mentions: [],
      origin: 'stream',
      timestamp: 5,
    };
    useChatStore.setState({ messagesByThread: { thread_todo_api: [reply] } });
    await mountApp({ roster: RECOLORED, messages: [reply] });
    await selectDefaultThread();
    const msg = await screen.findByTestId('agent-message');
    // Renamed display name + model badge come from the new roster.
    expect(within(msg).getByText('Athena (Sonnet)')).toBeInTheDocument();
    expect(within(msg).getByText('Sonnet')).toBeInTheDocument();
    // Recolored accent (#e11d48 = rgb(225,29,72)) flows through, not the old indigo.
    expect(msg).toHaveStyle({ '--ac': '#e11d48' });
    expect(within(msg).getByText('Athena (Sonnet)')).toHaveStyle({ color: 'rgb(225, 29, 72)' });
    // mono initials derive from the (short) name → "AT", not a hardcoded "CL".
    expect(within(msg).getByText('AT')).toBeInTheDocument();
  });
});
