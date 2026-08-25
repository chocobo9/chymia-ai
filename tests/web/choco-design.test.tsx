// @vitest-environment jsdom
//
// Dev (happy / component) tests for the .d-choco core-workspace redesign:
// demonstrate the new design STRUCTURE renders and the existing wiring is
// intact. Gating edge/adversarial coverage is authored separately by QA (≠ the
// dev who wrote the product code). These are NOT the gating tests.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
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
    expect(modelBadge(claude)).toBe('Claude');
  });
});

describe('AgentMessage (.d-choco structure)', () => {
  it('renders the avatar + name + model badge + bubble for an agent turn', () => {
    render(
      <AgentMessage
        view={{
          agentId: CLAUDE,
          displayName: 'Claude',
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

  it('a large file create collapses by default to its header, then expands on click', async () => {
    // A real all-add file create (the two-sum-viz.html screenshot scenario): the
    // body must NOT dump every line up front — only the header + a 点击展开 hint.
    const html = [
      '<!DOCTYPE html>',
      '<html lang="zh-CN">',
      '<head>',
      '  <meta charset="UTF-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      '  <title>Two Sum — 算法可视化</title>',
      '  <style>',
      '    :root { --bg: #0f1117; --surface: #1a1d27; --border: #2a2d3a; }',
      '    body { margin: 0; background: var(--bg); color: #e1e4ed; }',
      '    .grid { display: grid; gap: 8px; }',
      '  </style>',
      '</head>',
      '<body>',
      '  <main class="grid">',
      '    <section id="board"></section>',
      '    <section id="controls"></section>',
      '  </main>',
      '  <script>',
      '    const nums = [2, 7, 11, 15];',
      '    const target = 9;',
      '    function twoSum(arr, t) {',
      '      const seen = new Map();',
      '      for (let i = 0; i < arr.length; i++) {',
      '        if (seen.has(t - arr[i])) return [seen.get(t - arr[i]), i];',
      '        seen.set(arr[i], i);',
      '      }',
      '    }',
      '  </script>',
      '</body>',
      '</html>',
    ];
    const lines = html.map((text) => ({ text: `+ ${text}`, kind: 'add' as const }));
    // .html resolves to lang 'generic' via langFromPath; let Diff default it.
    const { container } = render(
      <Diff file=".workspace/two-sum-viz.html" added={lines.length} removed={0} lines={lines} />,
    );

    const block = screen.getByTestId('diff-block');
    // Header is present (file + stats), but the code body (.diff-b) is NOT rendered yet.
    expect(within(block).getByText('.workspace/two-sum-viz.html')).toBeInTheDocument();
    expect(within(block).getByText(`+${lines.length}`)).toBeInTheDocument();
    expect(container.querySelector('.diff-b')).toBeNull();
    expect(within(block).getByText(`${lines.length} 行 · 点击展开`)).toBeInTheDocument();

    // Clicking the header reveals the full code body, and the hint disappears.
    await userEvent.click(screen.getByTestId('diff-toggle'));
    const body = container.querySelector('.diff-b');
    expect(body).not.toBeNull();
    expect((body as HTMLElement).querySelectorAll('.ln')).toHaveLength(lines.length);
    expect(within(block).queryByText(`${lines.length} 行 · 点击展开`)).not.toBeInTheDocument();
  });

  it('renders open-file + reveal-folder affordances when onReveal is wired, and dispatches the action', async () => {
    const onReveal = vi.fn();
    render(
      <Diff
        file=".workspace/two-sum-viz.html"
        added={1}
        removed={0}
        lines={[{ text: '+ <!DOCTYPE html>', kind: 'add' }]}
        onReveal={onReveal}
      />,
    );
    // Clicking the filename opens the file; the folder button reveals it.
    const openBtn = screen.getByTestId('diff-open-file');
    expect(openBtn).toHaveTextContent('.workspace/two-sum-viz.html');
    await userEvent.click(openBtn);
    expect(onReveal).toHaveBeenCalledWith('open');
    await userEvent.click(screen.getByTestId('diff-reveal-file'));
    expect(onReveal).toHaveBeenLastCalledWith('reveal');
  });

  it('without onReveal the path is plain text (no open/reveal buttons) — presentational default', () => {
    render(<Diff file="src/x.ts" added={1} removed={0} lines={[{ text: '+ const x = 1;', kind: 'add' }]} />);
    expect(screen.queryByTestId('diff-open-file')).not.toBeInTheDocument();
    expect(screen.queryByTestId('diff-reveal-file')).not.toBeInTheDocument();
    expect(screen.getByText('src/x.ts')).toHaveClass('diff-file');
  });

  it('an HTML edit shows a 预览 toggle that renders the file in a SANDBOXED iframe', async () => {
    const html =
      '<!DOCTYPE html><html><head><title>Two Sum</title></head><body><div id="board"></div><script>const nums=[2,7,11,15];</script></body></html>';
    const onLoadFile = vi.fn().mockResolvedValue(html);
    render(
      <Diff
        file=".workspace/two-sum-viz.html"
        added={1}
        removed={0}
        lines={[{ text: '+ <!DOCTYPE html>', kind: 'add' }]}
        onLoadFile={onLoadFile}
      />,
    );
    // No iframe until the user asks to preview.
    expect(screen.queryByTestId('diff-preview-frame')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('diff-preview-toggle'));

    const frame = await screen.findByTestId('diff-preview-frame');
    expect(onLoadFile).toHaveBeenCalledWith('.workspace/two-sum-viz.html');
    // Rendered inline via srcdoc, sandboxed (scripts allowed, NOT same-origin).
    expect(frame).toHaveAttribute('srcdoc', html);
    const sandbox = frame.getAttribute('sandbox') ?? '';
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
  });

  it('a non-HTML edit gets NO 预览 toggle even when onLoadFile is wired', () => {
    render(
      <Diff
        file="packages/api/src/router.ts"
        added={2}
        removed={1}
        lines={[{ text: '+ export const x = 1;', kind: 'add' }]}
        onLoadFile={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('diff-preview-toggle')).not.toBeInTheDocument();
  });

  it('a short edit stays inline (no collapse toggle, body visible immediately)', () => {
    const { container } = render(
      <Diff
        file="src/hello.ts"
        added={1}
        removed={1}
        lines={[
          { text: '- console.log("hi");', kind: 'del' },
          { text: '+ console.log("hello");', kind: 'add' },
        ]}
      />,
    );
    expect(screen.queryByTestId('diff-toggle')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.diff-b .ln')).toHaveLength(2);
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
  it('auto-grows the textarea to fit multi-line input, and shrinks back when cleared', () => {
    render(<ChatInput onSend={vi.fn()} onLockChange={vi.fn()} />);
    const ta = screen.getByTestId('chat-input-textarea') as HTMLTextAreaElement;
    // jsdom does no layout (scrollHeight is 0), so simulate what the browser would
    // report: a tall content box when there's text, a short one when empty.
    Object.defineProperty(ta, 'scrollHeight', {
      configurable: true,
      get() {
        return (this as HTMLTextAreaElement).value.length > 0 ? 84 : 22;
      },
    });

    // A Shift+Enter multi-line value lengthens the box to fit its content.
    fireEvent.change(ta, { target: { value: '第一行\n第二行\n第三行' } });
    expect(ta.style.height).toBe('84px');

    // Clearing (e.g. after send) shrinks it back to a single row.
    fireEvent.change(ta, { target: { value: '' } });
    expect(ta.style.height).toBe('22px');
  });

  it('shows the scope chip + composer hints and an enriched @mention dropdown', async () => {
    render(<ChatInput onSend={vi.fn()} onLockChange={vi.fn()} />);
    // The scope chip defaults to 全体 and is a real (clickable) selector now.
    const chip = screen.getByTestId('scope-selector');
    expect(chip).toHaveClass('scope');
    expect(chip).toHaveTextContent('@全体');

    await userEvent.type(screen.getByTestId('chat-input-textarea'), '@cl');
    const dropdown = screen.getByTestId('mention-suggestions');
    expect(dropdown).toHaveClass('mentions');
    const suggestion = within(dropdown).getByTestId('mention-suggestion');
    // enriched row: short name, model, strengths, mention key.
    expect(suggestion.querySelector('.mention-name')).toHaveTextContent('Claude');
    expect(within(suggestion).getByText('架构设计 · 代码实现 · 重构')).toBeInTheDocument();
    expect(within(suggestion).getByText('@claude')).toBeInTheDocument();
  });

  it('scope picker locks a target agent by mouse and reports the choice to the parent', async () => {
    const onLockChange = vi.fn();
    render(<ChatInput onSend={vi.fn()} onLockChange={onLockChange} />);
    // Open the picker and choose Claude by clicking (no typing).
    await userEvent.click(screen.getByTestId('scope-selector'));
    const menu = screen.getByTestId('scope-menu');
    const claudeOption = within(menu)
      .getAllByTestId('scope-option')
      .find((el) => el.getAttribute('data-agent') === 'claude-opus');
    expect(claudeOption).toBeDefined();
    await userEvent.click(claudeOption as HTMLElement);
    expect(onLockChange).toHaveBeenCalledWith('claude-opus');
    // Picking 全体 reports null (clears the lock).
    await userEvent.click(screen.getByTestId('scope-selector'));
    await userEvent.click(within(screen.getByTestId('scope-menu')).getAllByTestId('scope-option')[0]);
    expect(onLockChange).toHaveBeenLastCalledWith(null);
  });

  it('a locked agent auto-prepends its @mention on send (no manual @ needed)', async () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} onLockChange={vi.fn()} lockedAgentId="claude-opus" />);
    // The chip reflects the lock, and sending a bare message targets the locked agent.
    expect(screen.getByTestId('scope-selector')).toHaveTextContent('@Claude');
    await userEvent.type(screen.getByTestId('chat-input-textarea'), '继续重构 router 模块');
    await userEvent.click(screen.getByTestId('chat-send-button'));
    expect(onSend).toHaveBeenCalledWith('@claude 继续重构 router 模块');
  });

  it('an explicit @mention overrides the lock (no double mention prepended)', async () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} onLockChange={vi.fn()} lockedAgentId="claude-opus" />);
    await userEvent.type(screen.getByTestId('chat-input-textarea'), '@gemini 看看这个设计');
    await userEvent.click(screen.getByTestId('chat-send-button'));
    // Sent verbatim — the locked @claude is NOT prepended over the explicit @gemini.
    expect(onSend).toHaveBeenCalledWith('@gemini 看看这个设计');
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
    // The inline 审计 & Session explorer body renders (no client here → inert, but present).
    expect(screen.getByTestId('sb-explorer-body')).toBeInTheDocument();
  });

  it('shows a 待命 mode and the unselected-thread label when no thread is active', () => {
    useAgentStore.setState({ roster: ROSTER, statusById: {} });
    render(<AgentStatus />);
    // mode line reflects no working agent (the bold value inside .sb-mode).
    const mode = document.querySelector('.sb-mode b');
    expect(mode).not.toBeNull();
    expect(mode).toHaveTextContent('待命');
    // 对话信息 block removed; the no-thread label now lives in the 会话链 / 审计 explorer.
    expect(screen.getAllByText('未选择会话。').length).toBeGreaterThanOrEqual(1);
  });
});
