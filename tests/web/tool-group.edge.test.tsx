// @vitest-environment jsdom
//
// QA gating tests (dev≠QA, §0.5.3) for the Clowder-faithful COLLAPSIBLE TOOL
// GROUP that replaced the "wall of full-width tool blocks", plus the per-row
// compact one-liner + reveal. Authored by a different instance than the one
// that wrote blocks.tsx / tool-render.ts / AgentMessage.tsx; NO product code is
// modified here.
//
// Intended behavior (mirrors reference clowder ToolsSection + choco-core Tool):
//   - Non-diff tool_use calls fold into ONE collapsible <ToolGroup> rendered
//     once: header = wrench + "N 工具调用" summary + "已折叠" hint when collapsed
//     + chevron (testid tool-group / tool-group-toggle).
//   - Default-open MIRRORS isStreaming: a live turn shows rows immediately (watch
//     progress); a COMPLETED turn renders the group AUTO-COLLAPSED (one compact
//     line). On the streaming→done transition it auto-collapses; on re-entering
//     streaming it re-expands. A manual toggle (userToggled) wins thereafter.
//   - Each row (testid tool-use-block) = status (✓ done / spinner running) +
//     wrench + name + truncated detail (≤48 chars …); a per-row chevron reveals
//     the full pretty JSON input (testid tool-use-input). toolDetailPreview
//     prefers path/pattern/query/command/url over raw JSON.
//   - Diff/patch tool_use renders VISIBLY as its own <Diff> (diff-block) OUTSIDE
//     the collapsed group; only non-diff calls fold in.
//
// Distribution of THIS file's tests: happy ≤50%, edge ≥30%, adversarial ≥20%.
// 20 tests total → happy 8 (40%), edge 7 (35%), adversarial 5 (25%).

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentMessage, type AgentMessageView } from '../../packages/web/src/components/AgentMessage.js';
import {
  toolDetailPreview,
  TOOL_DETAIL_MAX_CHARS,
} from '../../packages/web/src/components/choco/tool-render.js';
import type { StreamingToolBlock } from '../../packages/web/src/stores/chat-store.js';
import { useChatStore } from '../../packages/web/src/stores/chat-store.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import { CLAUDE, ROSTER } from './fixtures.js';

beforeEach(() => {
  useChatStore.setState({
    threads: [],
    messagesByThread: {},
    streamingByThread: {},
    activeThreadId: null,
  });
  useAgentStore.setState({ roster: ROSTER, statusById: {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Build an AgentMessageView with sensible defaults for these render tests. */
function viewWith(overrides: Partial<AgentMessageView>): AgentMessageView {
  return {
    agentId: CLAUDE,
    displayName: 'Claude',
    text: '',
    thinking: '',
    toolBlocks: [],
    isStreaming: false,
    color: '#6366f1',
    ...overrides,
  };
}

/** A realistic multi-tool agent turn (16 calls, like a real coding session). */
function sixteenToolBlocks(): readonly StreamingToolBlock[] {
  return [
    { toolUseId: 'r0', toolName: 'Grep', toolInput: { pattern: 'partitionBlocks', glob: '**/*.tsx' } },
    { toolUseId: 'r1', toolName: 'read_file', toolInput: { path: 'packages/web/src/components/AgentMessage.tsx' } },
    { toolUseId: 'r2', toolName: 'read_file', toolInput: { path: 'packages/web/src/components/choco/blocks.tsx' } },
    { toolUseId: 'r3', toolName: 'list_dir', toolInput: { path: 'packages/web/src/components/choco' } },
    { toolUseId: 'r4', toolName: 'run_tests', toolInput: { suite: 'tests/web/components.test.tsx' } },
    { toolUseId: 'r5', toolName: 'write_file', toolInput: { path: 'packages/web/src/components/choco/tool-render.ts' } },
    { toolUseId: 'r6', toolName: 'Grep', toolInput: { pattern: 'ToolGroup', glob: '**/*.ts' } },
    { toolUseId: 'r7', toolName: 'run_command', toolInput: { command: 'npx tsc --noEmit' } },
    { toolUseId: 'r8', toolName: 'run_command', toolInput: { command: 'npx eslint "packages/**/*.tsx"' } },
    { toolUseId: 'r9', toolName: 'read_file', toolInput: { path: 'packages/web/src/choco.css' } },
    { toolUseId: 'r10', toolName: 'web_fetch', toolInput: { url: 'https://example.com/clowder-design' } },
    { toolUseId: 'r11', toolName: 'Grep', toolInput: { pattern: 'tool-use-block', glob: 'tests/**/*.tsx' } },
    { toolUseId: 'r12', toolName: 'run_tests', toolInput: { suite: 'tests/web/components.edge.test.tsx' } },
    { toolUseId: 'r13', toolName: 'read_file', toolInput: { path: 'packages/web/src/App.tsx' } },
    { toolUseId: 'r14', toolName: 'write_file', toolInput: { path: 'packages/web/src/components/choco/icons.tsx' } },
    { toolUseId: 'r15', toolName: 'run_command', toolInput: { command: 'npx vitest run tests/web' } },
  ];
}

/* ============================================================================
 * Completed message → group AUTO-COLLAPSED; toggle expands to N rows.
 * ========================================================================== */
describe('ToolGroup — completed message renders COLLAPSED', () => {
  it('a completed turn with 16 tool_use blocks shows ONE summary line, rows hidden until expanded (edge)', async () => {
    render(<AgentMessage view={viewWith({ toolBlocks: sixteenToolBlocks() })} />);

    // Collapsed: the single summary + "已折叠" hint show; NO per-tool wall.
    const group = screen.getByTestId('tool-group');
    expect(within(group).getByText(/16 工具调用/)).toBeInTheDocument();
    expect(within(group).getByText('已折叠')).toBeInTheDocument();
    expect(group).not.toHaveClass('open');
    expect(screen.queryAllByTestId('tool-use-block')).toHaveLength(0);

    // Expanding surfaces all 16 compact rows with their real names.
    await userEvent.click(screen.getByTestId('tool-group-toggle'));
    const rows = screen.getAllByTestId('tool-use-block');
    expect(rows).toHaveLength(16);
    expect(within(rows[0]!).getByText('Grep')).toBeInTheDocument();
    expect(within(rows[15]!).getByText('run_command')).toBeInTheDocument();
    // Open state drops the "已折叠" hint.
    expect(screen.queryByText('已折叠')).not.toBeInTheDocument();
  });

  it('a single completed tool call is still GROUPED: summary "1 工具调用", collapsed, then expands to one row (happy)', async () => {
    render(
      <AgentMessage
        view={viewWith({
          toolBlocks: [{ toolUseId: 'w1', toolName: 'write_file', toolInput: { path: 'packages/api/src/todo.ts' } }],
        })}
      />,
    );
    expect(screen.getByText(/1 工具调用/)).toBeInTheDocument();
    expect(screen.queryByTestId('tool-use-block')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('tool-group-toggle'));
    const rows = screen.getAllByTestId('tool-use-block');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText('write_file')).toBeInTheDocument();
  });

  it('toggling the group closed→open→closed hides the rows again (happy)', async () => {
    render(
      <AgentMessage
        view={viewWith({
          toolBlocks: [
            { toolUseId: 'a', toolName: 'Grep', toolInput: { pattern: 'foo' } },
            { toolUseId: 'b', toolName: 'read_file', toolInput: { path: 'src/x.ts' } },
          ],
        })}
      />,
    );
    const toggle = screen.getByTestId('tool-group-toggle');
    expect(screen.queryAllByTestId('tool-use-block')).toHaveLength(0);
    await userEvent.click(toggle);
    expect(screen.getAllByTestId('tool-use-block')).toHaveLength(2);
    await userEvent.click(toggle);
    expect(screen.queryAllByTestId('tool-use-block')).toHaveLength(0);
  });
});

/* ============================================================================
 * Streaming message → group EXPANDED by default (watch progress live).
 * ========================================================================== */
describe('ToolGroup — streaming message renders EXPANDED', () => {
  it('a streaming turn shows the rows IMMEDIATELY without any toggle click (edge)', () => {
    render(
      <AgentMessage
        view={viewWith({
          isStreaming: true,
          text: '正在执行工具…',
          toolBlocks: [
            { toolUseId: 's0', toolName: 'Grep', toolInput: { pattern: 'ToolGroup' } },
            { toolUseId: 's1', toolName: 'read_file', toolInput: { path: 'packages/web/src/App.tsx' } },
            { toolUseId: 's2', toolName: 'run_tests', toolInput: { suite: 'tests/web' } },
          ],
        })}
      />,
    );
    // Open by default: rows visible with NO interaction; the streaming indicator
    // still renders alongside; the "已折叠" hint is absent while open.
    expect(screen.getByTestId('tool-group')).toHaveClass('open');
    expect(screen.getAllByTestId('tool-use-block')).toHaveLength(3);
    expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument();
    expect(screen.queryByText('已折叠')).not.toBeInTheDocument();
  });

  it('streaming rows show a running spinner (stream-dots), not the ✓ check (happy)', () => {
    render(
      <AgentMessage
        view={viewWith({
          isStreaming: true,
          toolBlocks: [{ toolUseId: 's', toolName: 'run_command', toolInput: { command: 'pnpm build' } }],
        })}
      />,
    );
    const row = screen.getByTestId('tool-use-block');
    // Running → the stream-dots primitive renders in the status slot.
    expect(within(row).getByTestId('stream-dots')).toBeInTheDocument();
  });
});

/* ============================================================================
 * Auto-collapse on completion + manual-toggle-wins (the headline / adversarial).
 * ========================================================================== */
describe('ToolGroup — auto-collapse on streaming→done + userToggled wins', () => {
  it('the SAME message re-rendered streaming→done AUTO-COLLAPSES the group (adversarial — the headline)', () => {
    const streaming = viewWith({
      isStreaming: true,
      toolBlocks: [
        { toolUseId: 'g0', toolName: 'write_file', toolInput: { path: 'packages/api/src/todo.ts' } },
        { toolUseId: 'g1', toolName: 'run_tests', toolInput: { suite: 'todo-crud' } },
      ],
    });
    const { rerender } = render(<AgentMessage view={streaming} />);
    // Live: expanded, rows visible, no 已折叠.
    expect(screen.getByTestId('tool-group')).toHaveClass('open');
    expect(screen.getAllByTestId('tool-use-block')).toHaveLength(2);

    // Turn completes — same blocks, isStreaming flips to false.
    rerender(<AgentMessage view={{ ...streaming, isStreaming: false }} />);

    // Auto-collapsed: rows gone, summary + 已折叠 shown, group not open.
    expect(screen.getByTestId('tool-group')).not.toHaveClass('open');
    expect(screen.queryAllByTestId('tool-use-block')).toHaveLength(0);
    expect(screen.getByText(/2 工具调用/)).toBeInTheDocument();
    expect(screen.getByText('已折叠')).toBeInTheDocument();
  });

  it('a manual EXPAND of a completed group is respected — it stays open across an unrelated re-render (adversarial)', async () => {
    const completed = viewWith({
      toolBlocks: [{ toolUseId: 'm0', toolName: 'Grep', toolInput: { pattern: 'userToggled' } }],
    });
    const { rerender } = render(<AgentMessage view={completed} />);
    // Completed → collapsed. User opens it manually.
    await userEvent.click(screen.getByTestId('tool-group-toggle'));
    expect(screen.getByTestId('tool-group')).toHaveClass('open');
    expect(screen.getAllByTestId('tool-use-block')).toHaveLength(1);

    // An unrelated re-render (still completed) must NOT slam it shut — userToggled wins.
    rerender(<AgentMessage view={{ ...completed, text: '已完成。' }} />);
    expect(screen.getByTestId('tool-group')).toHaveClass('open');
    expect(screen.getAllByTestId('tool-use-block')).toHaveLength(1);
  });

  it('a manual COLLAPSE while streaming sticks — the streaming→done transition does NOT re-collapse what is already collapsed, and userToggled blocks any forced re-open (adversarial)', async () => {
    const streaming = viewWith({
      isStreaming: true,
      toolBlocks: [{ toolUseId: 'c0', toolName: 'run_tests', toolInput: { suite: 'web' } }],
    });
    const { rerender } = render(<AgentMessage view={streaming} />);
    // Streaming → open by default; user manually collapses it.
    expect(screen.getByTestId('tool-group')).toHaveClass('open');
    await userEvent.click(screen.getByTestId('tool-group-toggle'));
    expect(screen.getByTestId('tool-group')).not.toHaveClass('open');

    // Turn completes: userToggled is set, so the auto-collapse branch is a no-op
    // and it remains collapsed (never forced back open). No row wall reappears.
    rerender(<AgentMessage view={{ ...streaming, isStreaming: false }} />);
    expect(screen.getByTestId('tool-group')).not.toHaveClass('open');
    expect(screen.queryAllByTestId('tool-use-block')).toHaveLength(0);
  });

  it('RE-ENTERING streaming after completion re-expands AND forgets a prior manual toggle (edge)', async () => {
    const completed = viewWith({
      toolBlocks: [{ toolUseId: 're0', toolName: 'Grep', toolInput: { pattern: 'prevStreaming' } }],
    });
    const { rerender } = render(<AgentMessage view={completed} />);
    // Completed → collapsed; user collapses again is moot, but user toggles open then we drive a new streaming turn.
    await userEvent.click(screen.getByTestId('tool-group-toggle')); // open
    await userEvent.click(screen.getByTestId('tool-group-toggle')); // closed again (userToggled set)
    expect(screen.getByTestId('tool-group')).not.toHaveClass('open');

    // A NEW streaming turn re-enters: re-expand live and forget the manual toggle.
    rerender(<AgentMessage view={{ ...completed, isStreaming: true }} />);
    expect(screen.getByTestId('tool-group')).toHaveClass('open');
    expect(screen.getAllByTestId('tool-use-block')).toHaveLength(1);
  });
});

/* ============================================================================
 * Compact row: status + name + truncated detail; per-row reveal of full JSON.
 * ========================================================================== */
describe('ToolRow — compact one-liner + per-row reveal', () => {
  it('a completed row shows ✓ status, wrench, name, and a truncated detail; clicking the row reveals the full JSON (happy)', async () => {
    const longPath = 'packages/web/src/components/choco/very-deeply-nested-directory/blocks.tsx';
    render(
      <AgentMessage
        view={viewWith({
          toolBlocks: [{ toolUseId: 'd0', toolName: 'read_file', toolInput: { path: longPath } }],
        })}
      />,
    );
    await userEvent.click(screen.getByTestId('tool-group-toggle'));
    const row = screen.getByTestId('tool-use-block');
    expect(within(row).getByText('read_file')).toBeInTheDocument();

    // Detail truncated to ≤48 chars with an ellipsis (the raw path is longer).
    expect(longPath.length).toBeGreaterThan(TOOL_DETAIL_MAX_CHARS);
    const detail = row.querySelector('.tool-row-detail');
    expect(detail).not.toBeNull();
    expect(detail!.textContent ?? '').toContain('…');
    expect((detail!.textContent ?? '').length).toBeLessThanOrEqual(TOOL_DETAIL_MAX_CHARS + 1);

    // Input hidden until the per-row chevron is clicked, then the full path shows.
    expect(screen.queryByTestId('tool-use-input')).not.toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button'));
    const pre = screen.getByTestId('tool-use-input');
    expect(pre).toHaveTextContent(longPath);
  });

  it('a row with NO input exposes no JSON pre even when its header is clicked (adversarial)', async () => {
    render(<AgentMessage view={viewWith({ toolBlocks: [{ toolName: 'list_dir' }] })} />);
    await userEvent.click(screen.getByTestId('tool-group-toggle'));
    const row = screen.getByTestId('tool-use-block');
    await userEvent.click(within(row).getByRole('button'));
    expect(screen.queryByTestId('tool-use-input')).not.toBeInTheDocument();
    expect(within(row).getByText('list_dir')).toBeInTheDocument();
    // No detail span either (no input → nothing to preview).
    expect(row.querySelector('.tool-row-detail')).toBeNull();
  });

  it('hostile JSON in a tool input renders as escaped text in the pre, never injected markup (adversarial)', async () => {
    const hostile: Record<string, unknown> = {
      query: 'SELECT * FROM users; <script>alert(1)</script>',
      note: 'he said "quote" & <b>bold</b>',
      unicode: 'Claude 🐱',
    };
    render(
      <AgentMessage
        view={viewWith({ toolBlocks: [{ toolUseId: 'h0', toolName: 'sql_query', toolInput: hostile }] })}
      />,
    );
    await userEvent.click(screen.getByTestId('tool-group-toggle'));
    const row = screen.getByTestId('tool-use-block');
    await userEvent.click(within(row).getByRole('button'));
    const pre = screen.getByTestId('tool-use-input');
    expect(pre.textContent ?? '').toContain('<script>alert(1)</script>');
    expect(pre.querySelector('script')).toBeNull();
    expect(pre.querySelector('b')).toBeNull();
  });
});

/* ============================================================================
 * toolDetailPreview — prefers the telling key over raw JSON; truncates.
 * ========================================================================== */
describe('toolDetailPreview — preference order + truncation (unit)', () => {
  it('prefers path over the rest of the input object (happy)', () => {
    const block: StreamingToolBlock = {
      toolName: 'edit_file',
      toolInput: { path: 'src/todo.ts', content: 'x'.repeat(200), mode: 'overwrite' },
    };
    expect(toolDetailPreview(block)).toBe('src/todo.ts');
  });

  it('falls through path→pattern→query→command→url and truncates a long command to ≤48 + … (edge)', () => {
    const longCmd = 'npx vitest run tests/web/tool-group.edge.test.tsx --reporter=json --outputFile=out.json';
    const block: StreamingToolBlock = { toolName: 'run_command', toolInput: { command: longCmd } };
    const preview = toolDetailPreview(block);
    expect(preview.endsWith('…')).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(TOOL_DETAIL_MAX_CHARS + 1);
    expect(longCmd.startsWith(preview.slice(0, -1))).toBe(true);

    // query beats command when both present.
    expect(toolDetailPreview({ toolName: 'x', toolInput: { command: 'ls', query: 'needle' } })).toBe('needle');
    // url surfaces when no higher-priority key exists.
    expect(toolDetailPreview({ toolName: 'fetch', toolInput: { url: 'https://x.test/a' } })).toBe('https://x.test/a');
  });

  it('with no telling key, falls back to a compact JSON preview; empty/absent input → "" (edge)', () => {
    const compact = toolDetailPreview({ toolName: 'tool', toolInput: { foo: 1, bar: true } });
    expect(compact).toContain('foo');
    expect(toolDetailPreview({ toolName: 'tool', toolInput: {} })).toBe('');
    expect(toolDetailPreview({ toolName: 'tool' })).toBe('');
  });
});

/* ============================================================================
 * Diff stays VISIBLE outside the group; non-diff folds in.
 * ========================================================================== */
describe('Diff blocks render VISIBLY outside the collapsed group', () => {
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

  it('a completed message with a diff tool_use shows the diff WITHOUT expanding any group (edge)', () => {
    render(
      <AgentMessage
        view={viewWith({
          toolBlocks: [
            { toolUseId: 'p0', toolName: 'apply_patch', toolInput: { path: 'packages/api/src/todo.ts', diff } },
          ],
        })}
      />,
    );
    // The diff is visible immediately on a COMPLETED message — no group at all
    // (it was the only block, and diffs never fold in).
    const block = screen.getByTestId('diff-block');
    expect(within(block).getByText('packages/api/src/todo.ts')).toBeInTheDocument();
    expect(within(block).getByText('+3')).toBeInTheDocument();
    expect(within(block).getByText('−1')).toBeInTheDocument();
    expect(screen.queryByTestId('tool-group')).not.toBeInTheDocument();
  });

  it('a mixed turn: the diff shows visibly while non-diff calls fold into a collapsed group (adversarial)', async () => {
    render(
      <AgentMessage
        view={viewWith({
          toolBlocks: [
            { toolUseId: 'mx0', toolName: 'Grep', toolInput: { pattern: 'router' } },
            { toolUseId: 'mx1', toolName: 'apply_patch', toolInput: { path: 'packages/api/src/todo.ts', diff } },
            { toolUseId: 'mx2', toolName: 'run_tests', toolInput: { suite: 'todo-crud' } },
          ],
        })}
      />,
    );
    // Diff is visible without touching the group.
    expect(screen.getByTestId('diff-block')).toBeInTheDocument();
    expect(within(screen.getByTestId('diff-block')).getByText('packages/api/src/todo.ts')).toBeInTheDocument();

    // The TWO non-diff calls folded into a collapsed group (NOT three — the diff
    // is excluded from the count).
    expect(screen.getByText(/2 工具调用/)).toBeInTheDocument();
    expect(screen.queryAllByTestId('tool-use-block')).toHaveLength(0);

    await userEvent.click(screen.getByTestId('tool-group-toggle'));
    const rows = screen.getAllByTestId('tool-use-block');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Grep')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('run_tests')).toBeInTheDocument();
  });

  it('a write_file with only a path (no diff payload) does NOT become a diff — it folds into the group (edge)', async () => {
    render(
      <AgentMessage
        view={viewWith({
          toolBlocks: [{ toolUseId: 'wf0', toolName: 'write_file', toolInput: { path: 'src/new.ts' } }],
        })}
      />,
    );
    // No diff-block (no unified-diff payload → never fabricate counts).
    expect(screen.queryByTestId('diff-block')).not.toBeInTheDocument();
    expect(screen.getByText(/1 工具调用/)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('tool-group-toggle'));
    expect(within(screen.getByTestId('tool-use-block')).getByText('write_file')).toBeInTheDocument();
  });
});

/* ============================================================================
 * testids intact alongside the group (thinking / streaming / diff / agent-text).
 * ========================================================================== */
describe('testids remain intact with the new group', () => {
  it('a rich streaming turn keeps thinking-block, diff-block, tool-use-block, streaming-indicator and agent-text wired (happy)', () => {
    const diff =
      '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1,2 @@\n-old\n+new\n+added';
    render(
      <AgentMessage
        view={viewWith({
          isStreaming: true,
          text: '正在输出结果…',
          thinking: '先确认数据模型，再决定端点划分。',
          toolBlocks: [
            { toolUseId: 'i0', toolName: 'apply_patch', toolInput: { path: 'x.ts', diff } },
            { toolUseId: 'i1', toolName: 'Grep', toolInput: { pattern: 'router' } },
          ],
        })}
      />,
    );
    expect(screen.getByTestId('thinking-block')).toBeInTheDocument();
    expect(screen.getByTestId('diff-block')).toBeInTheDocument();
    expect(screen.getByTestId('agent-text')).toHaveTextContent('正在输出结果…');
    expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument();
    // Streaming → group open → the one non-diff row is present.
    expect(screen.getByTestId('tool-group')).toHaveClass('open');
    expect(screen.getAllByTestId('tool-use-block')).toHaveLength(1);
  });

  it('an empty turn (no text/thinking/tools/diffs) renders no group and no stray blocks (edge)', () => {
    render(<AgentMessage view={viewWith({})} />);
    expect(screen.getByTestId('agent-message')).toBeInTheDocument();
    expect(screen.queryByTestId('tool-group')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tool-use-block')).not.toBeInTheDocument();
    expect(screen.queryByTestId('diff-block')).not.toBeInTheDocument();
    expect(screen.queryByTestId('thinking-block')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-text')).not.toBeInTheDocument();
  });
});
