// @vitest-environment jsdom
//
// Dev (happy / component) tests for the .d-choco core-workspace redesign:
// demonstrate the new design STRUCTURE renders and the existing wiring is
// intact. Gating edge/adversarial coverage is authored separately by QA (≠ the
// dev who wrote the product code). These are NOT the gating tests.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentMessage } from '../../packages/web/src/components/AgentMessage.js';
import { AgentStatus } from '../../packages/web/src/components/AgentStatus.js';
import { ThreadList } from '../../packages/web/src/components/ThreadList.js';
import { ChatInput } from '../../packages/web/src/components/ChatInput.js';
import { Diff, Think, Decision } from '../../packages/web/src/components/choco/blocks.js';
import { renderForToolBlock, parseDiffPayload } from '../../packages/web/src/components/choco/tool-render.js';
import { monoInitials, modelBadge, shortName } from '../../packages/web/src/components/choco/primitives.js';
import { useChatStore } from '../../packages/web/src/stores/chat-store.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import { CLAUDE, ROSTER, makeThread, makeUserMessage, makeAgentReply } from './fixtures.js';

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

describe('primitives (helpers)', () => {
  it('derives mono initials, short name, and model badge from a roster entry', () => {
    const claude = ROSTER[0];
    expect(monoInitials(claude.displayName)).toBe('CL');
    expect(shortName(claude)).toBe('Claude');
    expect(modelBadge(claude)).toBe('Opus');
  });
});

describe('AgentMessage (.d-choco structure)', () => {
  it('renders the avatar + name + model badge + bubble for an agent turn', () => {
    render(
      <AgentMessage
        view={{
          agentId: CLAUDE,
          displayName: 'Claude (Opus)',
          avatarName: 'Claude',
          model: 'Opus',
          text: 'TODO API 已实现，含 zod 校验。',
          thinking: '',
          toolBlocks: [],
          isStreaming: false,
          color: '#6366f1',
        }}
      />,
    );
    const msg = screen.getByTestId('agent-message');
    expect(msg).toHaveClass('msg-agent');
    expect(msg).toHaveAttribute('data-agent', 'claude-opus');
    expect(within(msg).getByText('CL')).toBeInTheDocument(); // avatar initials
    expect(within(msg).getByText('Opus')).toBeInTheDocument(); // model badge
    expect(screen.getByTestId('agent-text')).toHaveClass('body');
  });
});

describe('rich blocks', () => {
  it('Think splits multi-line reasoning into stepped lines when expanded', async () => {
    render(<Think thinking={'先确认数据模型\n再决定端点划分\n最后加 zod 校验'} accent="#6366f1" />);
    expect(screen.queryByTestId('thinking-body')).not.toBeInTheDocument();
    await userEvent.click(within(screen.getByTestId('thinking-block')).getByRole('button'));
    const body = screen.getByTestId('thinking-body');
    expect(within(body).getByText('先确认数据模型')).toBeInTheDocument();
    expect(within(body).getByText('最后加 zod 校验')).toBeInTheDocument();
  });

  it('Diff renders the file header, +/- stats, and colored add/del lines', () => {
    render(
      <Diff
        file="packages/cli/src/bootstrap.ts"
        added={2}
        removed={1}
        lines={[
          { text: '  export async function init() {' },
          { text: '-   await runAll(STEPS)', kind: 'del' },
          { text: '+   const ck = loadCheckpoint()', kind: 'add' },
          { text: '+   for (const step of STEPS) {}', kind: 'add' },
        ]}
      />,
    );
    const block = screen.getByTestId('diff-block');
    expect(within(block).getByText('packages/cli/src/bootstrap.ts')).toBeInTheDocument();
    expect(within(block).getByText('+2')).toBeInTheDocument();
    expect(within(block).getByText('−1')).toBeInTheDocument();
  });

  it('Decision renders the unresolved options as pickable buttons', async () => {
    const onPick = vi.fn();
    render(
      <Decision
        title="续跑状态提示，选哪种？"
        options={['简洁：从第 3/5 步继续', '安心：欢迎回来，进度都在', '工程：resume · cursor=migrate']}
        onPick={onPick}
        accent="#f59e0b"
      />,
    );
    const opts = screen.getAllByTestId('decision-option');
    expect(opts).toHaveLength(3);
    await userEvent.click(opts[1]);
    expect(onPick).toHaveBeenCalledWith(1, '安心：欢迎回来，进度都在');
  });

  it('Decision shows the adopted option when already resolved', () => {
    render(
      <Decision
        title="续跑状态提示，选哪种？"
        options={['简洁', '安心', '工程']}
        chosenIndex={1}
      />,
    );
    expect(screen.queryAllByTestId('decision-option')).toHaveLength(0);
    expect(screen.getByText(/已采纳 · 安心/)).toBeInTheDocument();
  });
});

describe('tool-render (Tool vs Diff)', () => {
  it('renders a plain write_file (path only, no patch) as a Tool block', () => {
    const r = renderForToolBlock({ toolUseId: 't', toolName: 'write_file', toolInput: { path: 'src/todo.ts' } });
    expect(r.kind).toBe('tool');
  });

  it('renders a file edit carrying a real unified-diff payload as a Diff block', () => {
    const r = renderForToolBlock({
      toolUseId: 't',
      toolName: 'apply_patch',
      toolInput: {
        path: 'src/todo.ts',
        diff: '@@ -1,2 +1,3 @@\n-old line\n+new line one\n+new line two\n context',
      },
    });
    expect(r.kind).toBe('diff');
    if (r.kind === 'diff') {
      expect(r.file).toBe('src/todo.ts');
      expect(r.added).toBe(2);
      expect(r.removed).toBe(1);
    }
  });

  it('parseDiffPayload skips diff headers and counts add/del lines', () => {
    const parsed = parseDiffPayload('--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-gone\n+added a\n+added b\n kept');
    expect(parsed.added).toBe(2);
    expect(parsed.removed).toBe(1);
    expect(parsed.lines.some((l) => l.kind === 'add')).toBe(true);
  });
});

describe('ThreadList (.col-threads structure)', () => {
  it('renders the 新建会话 button, a thread row with participant accent dots, and the owner footer', () => {
    useChatStore.setState({
      threads: [makeThread({ participants: [CLAUDE] })],
      activeThreadId: 'thread_todo_api',
    });
    render(<ThreadList onCreateThread={vi.fn()} onSelectThread={vi.fn()} />);

    expect(screen.getByTestId('new-thread-button')).toHaveClass('btn-new');
    const item = screen.getByTestId('thread-item');
    expect(item).toHaveClass('thread', 'active');
    expect(item).toHaveAttribute('aria-current', 'true');
    // participant dot uses the roster accent color.
    expect(item.querySelector('.thread-dots .dot')).not.toBeNull();
    // owner footer rendered (gear deferred).
    expect(screen.getByText('project owner')).toBeInTheDocument();
  });
});

describe('ChatInput (.composer structure)', () => {
  it('shows the scope chip + composer hints and an enriched @mention dropdown', async () => {
    render(<ChatInput onSend={vi.fn()} />);
    expect(screen.getByText('@all')).toHaveClass('scope');

    await userEvent.type(screen.getByTestId('chat-input-textarea'), '@cl');
    const dropdown = screen.getByTestId('mention-suggestions');
    expect(dropdown).toHaveClass('mentions');
    const suggestion = within(dropdown).getByTestId('mention-suggestion');
    // enriched row: short name, model, strengths, mention key.
    expect(within(suggestion).getByText('Claude')).toBeInTheDocument();
    expect(within(suggestion).getByText('架构设计 · 代码实现 · 重构')).toBeInTheDocument();
    expect(within(suggestion).getByText('@claude')).toBeInTheDocument();
  });
});

describe('AgentStatus / StatusBar (right column, real data)', () => {
  it('computes 消息统计 from the active thread and shows honest empty audit state', () => {
    useChatStore.setState({
      threads: [makeThread()],
      activeThreadId: 'thread_todo_api',
      messagesByThread: { thread_todo_api: [makeUserMessage(), makeAgentReply()] },
      streamingByThread: {},
    });
    useAgentStore.setState({ roster: ROSTER, statusById: { 'claude-opus': 'working' } });
    render(<AgentStatus />);

    // live agent statuses still render with the wiring testids.
    const items = screen.getAllByTestId('agent-status-item');
    expect(items).toHaveLength(3);
    expect(items.find((el) => el.getAttribute('data-agent') === 'claude-opus')).toHaveAttribute(
      'data-status',
      'working',
    );

    // 消息统计: 2 total (1 user + 1 agent) — computed, not fabricated.
    expect(screen.getByText('状态栏')).toBeInTheDocument();
    expect(screen.getByText('协作中')).toBeInTheDocument(); // mode reflects a working agent
    // honest empty audit state (no fabricated audit rows).
    expect(screen.getByText('暂无审计记录。')).toBeInTheDocument();
  });

  it('shows a 待命 mode and the unselected-thread label when no thread is active', () => {
    useAgentStore.setState({ roster: ROSTER, statusById: {} });
    render(<AgentStatus />);
    // mode line reflects no working agent (the bold value inside .sb-mode).
    const mode = document.querySelector('.sb-mode b');
    expect(mode).not.toBeNull();
    expect(mode).toHaveTextContent('待命');
    expect(screen.getByText('未选择会话')).toBeInTheDocument();
  });
});
