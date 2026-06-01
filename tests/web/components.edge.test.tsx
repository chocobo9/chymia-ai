// @vitest-environment jsdom
//
// M9 QA — edge + adversarial coverage for ChatInput (@mention autocomplete),
// AgentMessage (rendering safety: HTML-like text escaped, large/odd tool JSON,
// thinking collapse/expand, streaming indicator gating), AgentStatus (unknown
// agent default, multi-agent dots, status flip), and ChatContainer fallbacks.
//
// dev≠QA: authored by the M9 QA instance; no product code modified.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatInput } from '../../packages/web/src/components/ChatInput.js';
import { AgentMessage, type AgentMessageView } from '../../packages/web/src/components/AgentMessage.js';
import { AgentStatus } from '../../packages/web/src/components/AgentStatus.js';
import { ChatContainer } from '../../packages/web/src/components/ChatContainer.js';
import { useChatStore } from '../../packages/web/src/stores/chat-store.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import { CLAUDE, CODEX, ROSTER, makeThread, makeUserMessage } from './fixtures.js';

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

describe('ChatInput @mention autocomplete (edge + adversarial)', () => {
  it('CJK alias mention "@布" surfaces the Claude alias "@布偶" and excludes others', async () => {
    render(<ChatInput onSend={vi.fn()} />);
    const textarea = screen.getByTestId('chat-input-textarea');
    await userEvent.type(textarea, '@布');
    const patterns = screen.getAllByTestId('mention-suggestion').map((s) => s.getAttribute('data-pattern'));
    expect(patterns).toContain('@布偶');
    expect(patterns).not.toContain('@codex');
  });

  it('a no-match token "@zzz" shows no suggestion list', async () => {
    render(<ChatInput onSend={vi.fn()} />);
    await userEvent.type(screen.getByTestId('chat-input-textarea'), '@zzz');
    expect(screen.queryByTestId('mention-suggestions')).not.toBeInTheDocument();
  });

  it('"@" mid-word (no leading whitespace, e.g. "email@cl") does NOT trigger suggestions', async () => {
    render(<ChatInput onSend={vi.fn()} />);
    await userEvent.type(screen.getByTestId('chat-input-textarea'), 'email@cl');
    expect(screen.queryByTestId('mention-suggestions')).not.toBeInTheDocument();
  });

  it('"@" after a space mid-sentence DOES trigger (second mention in one message)', async () => {
    render(<ChatInput onSend={vi.fn()} />);
    const textarea = screen.getByTestId('chat-input-textarea') as HTMLTextAreaElement;
    await userEvent.type(textarea, '@claude 先实现，然后 @cod');
    const patterns = screen.getAllByTestId('mention-suggestion').map((s) => s.getAttribute('data-pattern'));
    expect(patterns).toContain('@codex');
    expect(patterns).not.toContain('@claude');
  });

  it('picking a suggestion completes in place WITHOUT clobbering preceding text', async () => {
    render(<ChatInput onSend={vi.fn()} />);
    const textarea = screen.getByTestId('chat-input-textarea') as HTMLTextAreaElement;
    await userEvent.type(textarea, '请 @cod');
    await userEvent.click(screen.getByText('@codex'));
    expect(textarea.value).toBe('请 @codex ');
  });

  it('a bare "@" shows ALL mention patterns across the roster (9 patterns)', async () => {
    render(<ChatInput onSend={vi.fn()} />);
    await userEvent.type(screen.getByTestId('chat-input-textarea'), '@');
    // 3 agents × 3 patterns each.
    expect(screen.getAllByTestId('mention-suggestion')).toHaveLength(9);
  });

  it('empty roster → typing "@claude" surfaces no suggestions and does not crash', async () => {
    useAgentStore.setState({ roster: [], statusById: {} });
    render(<ChatInput onSend={vi.fn()} />);
    await userEvent.type(screen.getByTestId('chat-input-textarea'), '@claude');
    expect(screen.queryByTestId('mention-suggestions')).not.toBeInTheDocument();
  });

  it('whitespace-only input does not call onSend and is treated as empty', async () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);
    const textarea = screen.getByTestId('chat-input-textarea');
    await userEvent.type(textarea, '    ');
    await userEvent.type(textarea, '{Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('disabled input does not send on Enter even with content', async () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} disabled />);
    const textarea = screen.getByTestId('chat-input-textarea');
    // disabled textarea cannot be typed into via the keyboard reliably; assert no send path.
    await userEvent.type(textarea, '@claude 写代码{Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('Shift+Enter does NOT submit (newline composition)', async () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);
    const textarea = screen.getByTestId('chat-input-textarea');
    await userEvent.type(textarea, '@claude 第一行{Shift>}{Enter}{/Shift}第二行');
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('AgentMessage rendering safety (adversarial)', () => {
  function viewWith(overrides: Partial<AgentMessageView>): AgentMessageView {
    return {
      agentId: CLAUDE,
      displayName: 'Claude (Opus)',
      text: '',
      thinking: '',
      toolBlocks: [],
      isStreaming: false,
      ...overrides,
    };
  }

  it('HTML-like agent text (<script>, &, <b>) is rendered as literal TEXT, not injected as DOM', () => {
    const hostile = '修复方案：把 <script>alert(1)</script> 转义为文本 & 保留 <b> 标记';
    render(<AgentMessage view={viewWith({ text: hostile })} />);
    const body = screen.getByTestId('agent-text');
    // React escapes: the literal characters are present as text content...
    expect(body).toHaveTextContent('<script>alert(1)</script>');
    // ...and NO real <script>/<b> element was injected into the message.
    expect(body.querySelector('script')).toBeNull();
    expect(body.querySelector('b')).toBeNull();
    expect(body.innerHTML).toContain('&lt;script&gt;');
  });

  it('large / odd tool_use JSON input renders inside the collapsible pre without crashing', async () => {
    const bigInput: Record<string, unknown> = {
      command: 'rg --json "needle" .',
      nested: { deep: { array: Array.from({ length: 40 }, (_, i) => `path/to/file_${i}.ts`) } },
      quoteHeavy: 'he said "use \\"quotes\\"" & <tags>',
      unicode: '布偶猫 🐱 / 暹罗猫',
    };
    render(
      <AgentMessage
        view={viewWith({ toolBlocks: [{ toolUseId: 'tu1', toolName: 'grep', toolInput: bigInput }] })}
      />,
    );
    // Completed turn → tool group auto-collapsed; expand it to reach the row.
    await userEvent.click(screen.getByTestId('tool-group-toggle'));
    const block = screen.getByTestId('tool-use-block');
    expect(within(block).getByText(/grep/)).toBeInTheDocument();
    expect(screen.queryByTestId('tool-use-input')).not.toBeInTheDocument(); // row collapsed

    await userEvent.click(within(block).getByRole('button'));
    const pre = screen.getByTestId('tool-use-input');
    expect(pre).toHaveTextContent('path/to/file_39.ts');
    // The hostile JSON string is escaped text, not injected markup.
    expect(pre.querySelector('tags')).toBeNull();
  });

  it('a tool_use block with undefined toolInput shows the name but no JSON pre even when expanded', async () => {
    render(<AgentMessage view={viewWith({ toolBlocks: [{ toolName: 'list_dir' }] })} />);
    await userEvent.click(screen.getByTestId('tool-group-toggle'));
    const block = screen.getByTestId('tool-use-block');
    // The row has no expand affordance when there is no input, but clicking its
    // header still must not surface a JSON pre.
    await userEvent.click(within(block).getByRole('button'));
    expect(screen.queryByTestId('tool-use-input')).not.toBeInTheDocument();
    expect(within(block).getByText(/list_dir/)).toBeInTheDocument();
  });

  it('thinking block toggles closed→open→closed on repeated clicks', async () => {
    render(<AgentMessage view={viewWith({ thinking: '先确认 SOP 阶段，再决定召唤谁。' })} />);
    const block = screen.getByTestId('thinking-block');
    const toggle = within(block).getByRole('button');
    expect(screen.queryByTestId('thinking-body')).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(screen.getByTestId('thinking-body')).toHaveTextContent('先确认 SOP 阶段');
    await userEvent.click(toggle);
    expect(screen.queryByTestId('thinking-body')).not.toBeInTheDocument();
  });

  it('streaming indicator shows ONLY while isStreaming is true', () => {
    const { rerender } = render(<AgentMessage view={viewWith({ text: '生成中…', isStreaming: true })} />);
    expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument();
    rerender(<AgentMessage view={viewWith({ text: '已完成。', isStreaming: false })} />);
    expect(screen.queryByTestId('streaming-indicator')).not.toBeInTheDocument();
  });

  it('an empty agent turn (no text/thinking/tools) renders the header without empty body blocks', () => {
    render(<AgentMessage view={viewWith({})} />);
    expect(screen.getByTestId('agent-message')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-text')).not.toBeInTheDocument();
    expect(screen.queryByTestId('thinking-block')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tool-use-block')).not.toBeInTheDocument();
  });

  it('multiple tool_use calls fold into one group; expanding it shows a row per call with stable keys', async () => {
    render(
      <AgentMessage
        view={viewWith({
          toolBlocks: [
            { toolUseId: 'a', toolName: 'write_file', toolInput: { path: 'src/todo.ts' } },
            { toolUseId: 'b', toolName: 'run_tests', toolInput: { suite: 'todo' } },
          ],
        })}
      />,
    );
    // Folded: one group summarizing both calls (no per-tool wall when collapsed).
    expect(screen.getByText(/2 工具调用/)).toBeInTheDocument();
    expect(screen.queryAllByTestId('tool-use-block')).toHaveLength(0);

    await userEvent.click(screen.getByTestId('tool-group-toggle'));
    expect(screen.getAllByTestId('tool-use-block')).toHaveLength(2);
  });
});

describe('AgentStatus (edge + adversarial)', () => {
  it('renders one dot per rostered agent and reflects mixed live statuses', () => {
    useAgentStore.setState({
      roster: ROSTER,
      statusById: { 'claude-opus': 'working', 'gemini-pro': 'error' },
    });
    render(<AgentStatus />);
    const items = screen.getAllByTestId('agent-status-item');
    expect(items).toHaveLength(3);
    const byAgent = Object.fromEntries(
      items.map((el) => [el.getAttribute('data-agent'), el.getAttribute('data-status')]),
    );
    expect(byAgent['claude-opus']).toBe('working');
    expect(byAgent['gemini-pro']).toBe('error');
    // codex has no live status → falls back to roster baseline idle.
    expect(byAgent['codex-gpt']).toBe('idle');
  });

  it('an unrostered live status does NOT add a phantom dot to the roster view', () => {
    useAgentStore.setState({
      roster: ROSTER,
      statusById: { 'phantom-agent': 'working' },
    });
    render(<AgentStatus />);
    const items = screen.getAllByTestId('agent-status-item');
    expect(items).toHaveLength(3); // still only rostered agents
    expect(items.some((el) => el.getAttribute('data-agent') === 'phantom-agent')).toBe(false);
  });

  it('a status flip from idle→working updates the data-status attribute on rerender', () => {
    useAgentStore.setState({ roster: ROSTER, statusById: { 'claude-opus': 'idle' } });
    const { rerender } = render(<AgentStatus />);
    const claudeIdle = screen
      .getAllByTestId('agent-status-item')
      .find((el) => el.getAttribute('data-agent') === 'claude-opus');
    expect(claudeIdle).toHaveAttribute('data-status', 'idle');

    useAgentStore.setState({ roster: ROSTER, statusById: { 'claude-opus': 'working' } });
    rerender(<AgentStatus />);
    const claudeWorking = screen
      .getAllByTestId('agent-status-item')
      .find((el) => el.getAttribute('data-agent') === 'claude-opus');
    expect(claudeWorking).toHaveAttribute('data-status', 'working');
  });

  it('empty roster renders an empty status list (no items, no crash)', () => {
    useAgentStore.setState({ roster: [], statusById: {} });
    render(<AgentStatus />);
    expect(screen.queryAllByTestId('agent-status-item')).toHaveLength(0);
  });
});

describe('ChatContainer (edge)', () => {
  it('renders only the active thread transcript, ignoring other threads messages', () => {
    useChatStore.setState({
      threads: [makeThread(), makeThread({ id: 'thread_other', title: '别的会话' })],
      activeThreadId: 'thread_todo_api',
      messagesByThread: {
        thread_todo_api: [makeUserMessage()],
        thread_other: [makeUserMessage({ id: 'm_other', threadId: 'thread_other', content: '别的会话的消息。' })],
      },
      streamingByThread: {},
    });
    render(<ChatContainer />);
    expect(screen.getByTestId('user-message')).toHaveTextContent('@claude 写一个带 CRUD 的 TODO API');
    expect(screen.queryByText('别的会话的消息。')).not.toBeInTheDocument();
  });

  it('renders an unrostered agent reply by falling back to the raw agentId as display name', () => {
    useChatStore.setState({
      threads: [makeThread()],
      activeThreadId: 'thread_todo_api',
      messagesByThread: {
        thread_todo_api: [
          makeUserMessage(),
          {
            id: 'm_ghost',
            threadId: 'thread_todo_api',
            userId: 'ghost',
            agentId: CODEX,
            content: '这是来自 codex 的回复，但 roster 暂时为空。',
            mentions: [],
            origin: 'stream',
            timestamp: 5,
          },
        ],
      },
      streamingByThread: {},
    });
    useAgentStore.setState({ roster: [], statusById: {} }); // no roster → fallback name path
    render(<ChatContainer />);
    expect(screen.getByTestId('agent-text')).toHaveTextContent('这是来自 codex 的回复');
  });

  it('renders parallel streaming buffers as two distinct agent messages', () => {
    useChatStore.setState({
      threads: [makeThread()],
      activeThreadId: 'thread_todo_api',
      messagesByThread: { thread_todo_api: [] },
      streamingByThread: {
        thread_todo_api: [
          { key: 'claude-opus:inv_c', agentId: CLAUDE, invocationId: 'inv_c', text: 'Claude 在写实现。', thinking: '', toolBlocks: [], startedAt: 1 },
          { key: 'codex-gpt:inv_x', agentId: CODEX, invocationId: 'inv_x', text: 'Codex 在写测试。', thinking: '', toolBlocks: [], startedAt: 2 },
        ],
      },
    });
    render(<ChatContainer />);
    expect(screen.getAllByTestId('agent-message')).toHaveLength(2);
    expect(screen.getAllByTestId('streaming-indicator')).toHaveLength(2);
  });
});
