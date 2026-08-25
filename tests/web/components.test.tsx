// @vitest-environment jsdom
//
// M9 component render happy-path tests: ThreadList, ChatInput (@mention
// autocomplete), AgentMessage (text/tool_use/thinking blocks), AgentStatus
// (working/idle), ChatContainer (persisted + streaming messages).

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThreadList } from '../../packages/web/src/components/ThreadList.js';
import { ChatInput } from '../../packages/web/src/components/ChatInput.js';
import { AgentMessage } from '../../packages/web/src/components/AgentMessage.js';
import { AgentStatus } from '../../packages/web/src/components/AgentStatus.js';
import { ChatContainer } from '../../packages/web/src/components/ChatContainer.js';
import { useChatStore } from '../../packages/web/src/stores/chat-store.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import {
  CLAUDE,
  CODEX,
  ROSTER,
  makeThread,
  makeUserMessage,
  makeAgentReply,
} from './fixtures.js';

beforeEach(() => {
  useChatStore.setState({
    threads: [],
    messagesByThread: {},
    streamingByThread: {},
    activeThreadId: null,
  });
  useAgentStore.setState({ roster: ROSTER, statusById: {} });
});
afterEach(cleanup);

describe('ThreadList (render, happy path)', () => {
  it('lists threads and marks the active one', () => {
    useChatStore.setState({
      threads: [
        makeThread(),
        makeThread({ id: 'thread_evidence', title: 'Evidence 召回评审' }),
      ],
      activeThreadId: 'thread_evidence',
    });

    render(<ThreadList onCreateThread={vi.fn()} onSelectThread={vi.fn()} />);

    const items = screen.getAllByTestId('thread-item');
    expect(items).toHaveLength(2);
    expect(screen.getByText('TODO API 设计与实现')).toBeInTheDocument();
    const active = items.find((el) => el.getAttribute('data-thread') === 'thread_evidence');
    expect(active).toHaveAttribute('aria-current', 'true');
  });

  it('fires onSelectThread when a thread is clicked', async () => {
    const onSelect = vi.fn();
    useChatStore.setState({ threads: [makeThread()] });
    render(<ThreadList onCreateThread={vi.fn()} onSelectThread={onSelect} />);

    await userEvent.click(screen.getByText('TODO API 设计与实现'));
    expect(onSelect).toHaveBeenCalledWith('thread_todo_api');
  });
});

describe('ThreadList kebab menu + rename + delete (happy path)', () => {
  it('opens the kebab menu (重命名 / 删除会话) and closes it via the outside-click scrim', async () => {
    useChatStore.setState({ threads: [makeThread()] });
    render(<ThreadList onCreateThread={vi.fn()} onSelectThread={vi.fn()} />);

    await userEvent.click(screen.getByTestId('thread-kebab'));
    const menu = screen.getByTestId('thread-menu');
    expect(within(menu).getByText('重命名')).toBeInTheDocument();
    expect(within(menu).getByText('删除会话')).toBeInTheDocument();

    // The outside-click scrim dismisses the menu.
    await userEvent.click(screen.getByTestId('thread-menu-scrim'));
    expect(screen.queryByTestId('thread-menu')).toBeNull();
  });

  it('opening the kebab does NOT select the thread (propagation stopped)', async () => {
    const onSelect = vi.fn();
    useChatStore.setState({ threads: [makeThread()] });
    render(<ThreadList onCreateThread={vi.fn()} onSelectThread={onSelect} />);

    await userEvent.click(screen.getByTestId('thread-kebab'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('重命名 enters inline edit seeded with the title; Enter commits via onRenameThread', async () => {
    const onRename = vi.fn();
    useChatStore.setState({ threads: [makeThread()] });
    render(
      <ThreadList onCreateThread={vi.fn()} onSelectThread={vi.fn()} onRenameThread={onRename} />,
    );

    await userEvent.click(screen.getByTestId('thread-kebab'));
    await userEvent.click(screen.getByText('重命名'));

    const input = screen.getByTestId('thread-rename-input') as HTMLInputElement;
    expect(input.value).toBe('TODO API 设计与实现');

    await userEvent.clear(input);
    await userEvent.type(input, 'TODO API 设计与实现 v2{Enter}');
    expect(onRename).toHaveBeenCalledWith('thread_todo_api', 'TODO API 设计与实现 v2');
    // Edit mode exits after commit.
    expect(screen.queryByTestId('thread-rename-input')).toBeNull();
  });

  it('Escape during inline rename cancels without calling onRenameThread', async () => {
    const onRename = vi.fn();
    useChatStore.setState({ threads: [makeThread()] });
    render(
      <ThreadList onCreateThread={vi.fn()} onSelectThread={vi.fn()} onRenameThread={onRename} />,
    );

    await userEvent.click(screen.getByTestId('thread-kebab'));
    await userEvent.click(screen.getByText('重命名'));
    const input = screen.getByTestId('thread-rename-input');
    await userEvent.type(input, ' 草稿{Escape}');

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByTestId('thread-rename-input')).toBeNull();
  });

  it('删除会话 opens a confirm modal naming the thread; 删除 fires onDeleteThread', async () => {
    const onDelete = vi.fn();
    useChatStore.setState({ threads: [makeThread()] });
    render(
      <ThreadList onCreateThread={vi.fn()} onSelectThread={vi.fn()} onDeleteThread={onDelete} />,
    );

    await userEvent.click(screen.getByTestId('thread-kebab'));
    await userEvent.click(screen.getByText('删除会话'));

    const confirm = screen.getByTestId('thread-delete-confirm');
    expect(within(confirm).getByText('TODO API 设计与实现')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('thread-delete-confirm-button'));
    expect(onDelete).toHaveBeenCalledWith('thread_todo_api');
    expect(screen.queryByTestId('thread-delete-confirm')).toBeNull();
  });

  it('删除 confirm 取消 dismisses the modal without deleting', async () => {
    const onDelete = vi.fn();
    useChatStore.setState({ threads: [makeThread()] });
    render(
      <ThreadList onCreateThread={vi.fn()} onSelectThread={vi.fn()} onDeleteThread={onDelete} />,
    );

    await userEvent.click(screen.getByTestId('thread-kebab'));
    await userEvent.click(screen.getByText('删除会话'));
    await userEvent.click(screen.getByText('取消'));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByTestId('thread-delete-confirm')).toBeNull();
  });
});

describe('ChatInput @mention autocomplete (render, happy path)', () => {
  it('shows mention suggestions matching the typed @token from the roster', async () => {
    render(<ChatInput onSend={vi.fn()} />);
    const textarea = screen.getByTestId('chat-input-textarea');

    await userEvent.type(textarea, '@cl');

    const suggestions = screen.getAllByTestId('mention-suggestion');
    const patterns = suggestions.map((s) => s.getAttribute('data-pattern'));
    expect(patterns).toContain('@claude');
    expect(patterns).not.toContain('@codex');
  });

  it('completes the @mention in place when a suggestion is picked', async () => {
    render(<ChatInput onSend={vi.fn()} />);
    const textarea = screen.getByTestId('chat-input-textarea') as HTMLTextAreaElement;

    await userEvent.type(textarea, '@cod');
    await userEvent.click(screen.getByText('@codex'));

    expect(textarea.value).toBe('@codex ');
  });

  it('sends the trimmed message and clears the input', async () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);
    const textarea = screen.getByTestId('chat-input-textarea') as HTMLTextAreaElement;

    await userEvent.type(textarea, '@claude 写一个带 CRUD 的 TODO API');
    await userEvent.click(screen.getByTestId('chat-send-button'));

    expect(onSend).toHaveBeenCalledWith('@claude 写一个带 CRUD 的 TODO API');
    expect(textarea.value).toBe('');
  });
});

describe('AgentMessage (render, happy path)', () => {
  it('renders the text body', () => {
    render(
      <AgentMessage
        view={{
          agentId: CLAUDE,
          displayName: 'Claude',
          text: 'TODO API 已实现，含 zod 校验。',
          thinking: '',
          toolBlocks: [],
          isStreaming: false,
        }}
      />,
    );
    expect(screen.getByTestId('agent-text')).toHaveTextContent('TODO API 已实现，含 zod 校验。');
  });

  it('folds tool_use calls into a collapsible group; expanding reveals a compact row whose JSON shows on click', async () => {
    render(
      <AgentMessage
        view={{
          agentId: CLAUDE,
          displayName: 'Claude',
          text: '',
          thinking: '',
          toolBlocks: [{ toolUseId: 't1', toolName: 'write_file', toolInput: { path: 'src/todo.ts' } }],
          isStreaming: false,
        }}
      />,
    );
    // Completed turn → the tool GROUP is auto-collapsed (Clowder-faithful): the
    // summary shows, the per-tool rows are hidden until the group is opened.
    expect(screen.getByText(/1 工具调用/)).toBeInTheDocument();
    expect(screen.queryByTestId('tool-use-block')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('tool-group-toggle'));
    const block = screen.getByTestId('tool-use-block');
    expect(within(block).getByText(/write_file/)).toBeInTheDocument();
    // Row collapsed by default — input hidden until the row is toggled.
    expect(screen.queryByTestId('tool-use-input')).not.toBeInTheDocument();

    await userEvent.click(within(block).getByRole('button'));
    expect(screen.getByTestId('tool-use-input')).toHaveTextContent('src/todo.ts');
  });

  it('renders a collapsible thinking block', async () => {
    render(
      <AgentMessage
        view={{
          agentId: CLAUDE,
          displayName: 'Claude',
          text: '',
          thinking: '先确认数据模型，再决定端点划分。',
          toolBlocks: [],
          isStreaming: false,
        }}
      />,
    );
    const block = screen.getByTestId('thinking-block');
    expect(screen.queryByTestId('thinking-body')).not.toBeInTheDocument();
    await userEvent.click(within(block).getByRole('button'));
    expect(screen.getByTestId('thinking-body')).toHaveTextContent('先确认数据模型');
  });

  it('shows a streaming indicator while the turn is live', () => {
    render(
      <AgentMessage
        view={{
          agentId: CLAUDE,
          displayName: 'Claude',
          text: '正在生成…',
          thinking: '',
          toolBlocks: [],
          isStreaming: true,
        }}
      />,
    );
    expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument();
  });
});

describe('AgentStatus (render, happy path)', () => {
  it('reflects working vs idle per agent from the agent store', () => {
    useAgentStore.setState({
      roster: ROSTER,
      statusById: { 'claude-opus': 'working', 'codex-gpt': 'idle' },
    });
    render(<AgentStatus />);

    const items = screen.getAllByTestId('agent-status-item');
    const claude = items.find((el) => el.getAttribute('data-agent') === 'claude-opus');
    const codex = items.find((el) => el.getAttribute('data-agent') === 'codex-gpt');
    expect(claude).toHaveAttribute('data-status', 'working');
    expect(codex).toHaveAttribute('data-status', 'idle');
    expect(within(claude as HTMLElement).getByText('工作中')).toBeInTheDocument();
  });
});

describe('ChatContainer (render, happy path)', () => {
  it('renders persisted user + agent messages for the active thread', () => {
    useChatStore.setState({
      threads: [makeThread()],
      activeThreadId: 'thread_todo_api',
      messagesByThread: { thread_todo_api: [makeUserMessage(), makeAgentReply()] },
      streamingByThread: {},
    });
    render(<ChatContainer />);

    expect(screen.getByTestId('user-message')).toHaveTextContent('@claude 写一个带 CRUD 的 TODO API');
    expect(screen.getByTestId('agent-text')).toHaveTextContent('我已经实现了 TODO API');
  });

  it('renders a live streaming message alongside persisted history (G8)', () => {
    useChatStore.setState({
      threads: [makeThread()],
      activeThreadId: 'thread_todo_api',
      messagesByThread: { thread_todo_api: [makeUserMessage()] },
      streamingByThread: {
        thread_todo_api: [
          {
            key: 'codex-gpt:inv_1',
            agentId: CODEX,
            invocationId: 'inv_1',
            text: '我正在补充集成测试…',
            thinking: '',
            toolBlocks: [],
            startedAt: 1,
          },
        ],
      },
    });
    render(<ChatContainer />);

    expect(screen.getByTestId('user-message')).toBeInTheDocument();
    expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument();
    expect(screen.getByTestId('agent-text')).toHaveTextContent('我正在补充集成测试…');
  });

  it('re-shows Think + Tool blocks on a COMPLETED reply from extra.thinking/extra.toolEvents (Bug 3)', () => {
    // A persisted reply whose extra carries the same reasoning + tool_use the
    // streaming view rendered live (backend message-handler persists both).
    const completed = makeAgentReply({
      extra: {
        thinking: '先确认数据模型，再决定端点划分。',
        toolEvents: [
          {
            type: 'tool_use',
            toolName: 'write_file',
            toolUseId: 'tu_1',
            toolInput: { path: 'src/todo.ts' },
            invocationId: 'inv_1',
            timestamp: 2,
          },
          // a tool_result is ignored — only tool_use becomes a block
          { type: 'tool_result', toolUseId: 'tu_1', content: 'ok', invocationId: 'inv_1', timestamp: 3 },
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

    // Not streaming, yet the Think block + the (auto-collapsed) tool GROUP render
    // from the persisted extra. Expanding the group surfaces the tool row.
    expect(screen.queryByTestId('streaming-indicator')).not.toBeInTheDocument();
    expect(screen.getByTestId('thinking-block')).toBeInTheDocument();
    expect(screen.getByText(/1 工具调用/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('tool-group-toggle'));
    const tool = screen.getByTestId('tool-use-block');
    expect(within(tool).getByText(/write_file/)).toBeInTheDocument();
    expect(screen.getByTestId('agent-text')).toHaveTextContent('我已经实现了 TODO API');
  });

  it('shows the empty state when no thread is active', () => {
    render(<ChatContainer />);
    expect(screen.getByText('选择或新建一个会话开始对话。')).toBeInTheDocument();
  });
});
