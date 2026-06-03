// @vitest-environment jsdom
//
// Right status-bar — restored 审计 & Session TAB block (改回原版 tab layout, 2026-06-02).
// The original tabbed design is back (审计事件 / Session / 搜索 tabs, the ＋打开会话链
// link, the 运行日志 · 查看日志 foot) — but unlike the original it is NOT inert: every
// surface is wired to REAL store data and the real on-demand panels. These gate:
//   • the three tabs render and preview the thread's REAL activity / session chain;
//   • rows + 查看日志 / 打开会话链 open the real AuditPanel / SessionPanel;
//   • 搜索 filters the preview live;
//   • honest empties (该会话还没有活动 / …session) — never a permanent 暂无审计记录,
//     never the design's mock prose (checkpoint_saved / 绑定外部 / feat/resume-bootstrap).
//
// Distribution: happy ≤50%, edge ≥30%, adversarial ≥20%.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentStatus } from '../../packages/web/src/components/AgentStatus.js';
import { useChatStore } from '../../packages/web/src/stores/chat-store.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import { ROSTER, makeThread, makeUserMessage, makeAgentReply } from './fixtures.js';

const THREAD = 'thread_todo_api';

function seed(
  opts: { messages?: readonly ReturnType<typeof makeUserMessage>[]; activeThreadId?: string | null } = {},
): void {
  useChatStore.setState({
    threads: [makeThread()],
    activeThreadId: opts.activeThreadId === undefined ? THREAD : opts.activeThreadId,
    messagesByThread: { [THREAD]: opts.messages ?? [] },
    streamingByThread: {},
    noticesByThread: {},
  });
  useAgentStore.setState({ roster: ROSTER, statusById: {} });
}

/** A populated thread: a user @mention + two replies, one of them in a 2nd session. */
function populated(): readonly ReturnType<typeof makeUserMessage>[] {
  return [
    makeUserMessage({ id: 'm1' }),
    makeAgentReply({ id: 'm2', sessionId: 'sess-3f2a9c11' }),
    makeAgentReply({ id: 'm3', sessionId: 'sess-3f2a9c11' }),
    makeAgentReply({ id: 'm4', sessionId: 'sess-9c1b0400' }),
  ];
}

beforeEach(() => seed());
afterEach(cleanup);

describe('right status-bar — restored 审计 & Session tab block (real data, real entries)', () => {
  it('renders the three original tabs (审计事件 / Session / 搜索), 审计事件 active by default', () => {
    render(<AgentStatus onOpenAudit={vi.fn()} onOpenSessions={vi.fn()} />);
    expect(screen.getByTestId('sb-audit-tab-审计事件')).toHaveClass('on');
    expect(screen.getByTestId('sb-audit-tab-Session')).toBeInTheDocument();
    expect(screen.getByTestId('sb-audit-tab-搜索')).toBeInTheDocument();
  });

  it('审计事件 tab previews the thread REAL messages; a row opens the audit panel', async () => {
    seed({ messages: populated() });
    const onOpenAudit = vi.fn();
    render(<AgentStatus onOpenAudit={onOpenAudit} onOpenSessions={vi.fn()} />);
    const body = screen.getByTestId('sb-audit-body');
    // Newest-first: the agent reply tag (its display name) and the 用户 tag both show.
    expect(within(body).getAllByText('Claude (Opus)').length).toBeGreaterThanOrEqual(1);
    expect(within(body).getByText('用户')).toBeInTheDocument();
    await userEvent.click(screen.getAllByTestId('sb-activity-row')[0]);
    expect(onOpenAudit).toHaveBeenCalledTimes(1);
  });

  it('the 查看日志 foot opens the audit panel; ＋打开会话链 opens the session panel', async () => {
    const onOpenAudit = vi.fn();
    const onOpenSessions = vi.fn();
    render(<AgentStatus onOpenAudit={onOpenAudit} onOpenSessions={onOpenSessions} />);
    await userEvent.click(screen.getByTestId('sb-open-audit'));
    expect(onOpenAudit).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByTestId('sb-open-sessions'));
    expect(onOpenSessions).toHaveBeenCalledTimes(1);
  });

  it('[edge] Session tab lists the DISTINCT real sessions with per-session counts; a row opens the panel', async () => {
    seed({ messages: populated() });
    const onOpenSessions = vi.fn();
    render(<AgentStatus onOpenAudit={vi.fn()} onOpenSessions={onOpenSessions} />);
    await userEvent.click(screen.getByTestId('sb-audit-tab-Session'));
    const rows = screen.getAllByTestId('sb-session-row');
    expect(rows).toHaveLength(2); // two DISTINCT sessionIds
    // sess-3f2a9c11 carries 2 messages, sess-9c1b0400 carries 1.
    expect(within(rows[0]).getByText('sess-3f2a9c11')).toBeInTheDocument();
    expect(within(rows[0]).getByText('2 条')).toBeInTheDocument();
    expect(within(rows[1]).getByText('1 条')).toBeInTheDocument();
    await userEvent.click(rows[0]);
    expect(onOpenSessions).toHaveBeenCalledTimes(1);
  });

  it('[edge] the Session Chain count reflects distinct sessionIds in the thread (real, not fabricated)', () => {
    seed({ messages: populated() });
    render(<AgentStatus onOpenAudit={vi.fn()} onOpenSessions={vi.fn()} />);
    expect(screen.getByText('2 session')).toBeInTheDocument();
  });

  it('[edge] 搜索 tab filters the preview live, and shows an honest empty when nothing matches', async () => {
    seed({ messages: populated() });
    render(<AgentStatus onOpenAudit={vi.fn()} onOpenSessions={vi.fn()} />);
    await userEvent.click(screen.getByTestId('sb-audit-tab-搜索'));
    const search = screen.getByTestId('sb-audit-search');
    // "Opus" matches the agent rows' who, not the 用户 row → it narrows the preview.
    await userEvent.type(search, 'Opus');
    const body = screen.getByTestId('sb-audit-body');
    expect(within(body).queryByText('用户')).not.toBeInTheDocument();
    expect(within(body).getAllByText('Claude (Opus)').length).toBeGreaterThanOrEqual(1);
    // A non-matching query → the honest "没有匹配" state (not a fabricated row).
    await userEvent.clear(search);
    await userEvent.type(search, 'zzz-nope');
    expect(screen.getByText('没有匹配的审计 / session。')).toBeInTheDocument();
  });

  it('[edge] with NO active thread the entries are disabled and the tab body is the honest 未选择会话', () => {
    seed({ activeThreadId: null });
    render(<AgentStatus onOpenAudit={vi.fn()} onOpenSessions={vi.fn()} />);
    expect(screen.getByTestId('sb-open-audit')).toBeDisabled();
    expect(screen.getByTestId('sb-open-sessions')).toBeDisabled();
    // The tabs still render (layout intact), but the body is the honest placeholder.
    expect(screen.getByTestId('sb-audit-tab-审计事件')).toBeInTheDocument();
    expect(screen.getByText('未选择会话。')).toBeInTheDocument();
    expect(screen.queryByTestId('sb-activity-row')).not.toBeInTheDocument();
  });

  it('[adversarial] empty thread → honest empties, never the dead 暂无审计记录 nor the design mock prose', async () => {
    seed({ messages: [] });
    render(<AgentStatus onOpenAudit={vi.fn()} onOpenSessions={vi.fn()} />);
    expect(screen.getByText('该会话还没有活动。')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('sb-audit-tab-Session'));
    expect(screen.getByText('该会话还没有 session。')).toBeInTheDocument();
    // The old inert placeholder + the mock design strings must never appear.
    expect(screen.queryByText('暂无审计记录。')).not.toBeInTheDocument();
    expect(screen.queryByText('＋ 绑定外部 Session')).not.toBeInTheDocument();
    expect(screen.queryByText('checkpoint_saved')).not.toBeInTheDocument();
    expect(screen.queryByText(/feat\/resume-bootstrap/)).not.toBeInTheDocument();
  });

  it('[adversarial] without the open callbacks the entries + rows are inert (disabled), never crash', () => {
    seed({ messages: populated() });
    render(<AgentStatus />); // no props at all
    expect(screen.getByTestId('sb-open-audit')).toBeDisabled();
    expect(screen.getByTestId('sb-open-sessions')).toBeDisabled();
    // Rows still render the real data, but are inert (no panel wired in).
    for (const row of screen.getAllByTestId('sb-activity-row')) {
      expect(row).toBeDisabled();
    }
  });
});
