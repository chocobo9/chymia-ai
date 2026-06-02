// @vitest-environment jsdom
//
// Coverage for the right status-bar fix (2026-06-01): the 审计 & Session tabs
// (审计事件 / Session / 搜索) were INERT — clicking them changed nothing (the body
// always showed "暂无审计记录"). Now each tab switches to its own honest content:
//   审计事件 → real agent errors / system notices for the active thread
//   Session  → distinct sessionIds (with message counts) from the thread
//   搜索      → a working input that filters the notices locally
// No fabricated data — empty states stay honest.
//
// Distribution: happy ≤50%, edge ≥30%, adversarial ≥20%.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentStatus } from '../../packages/web/src/components/AgentStatus.js';
import { useChatStore, type TranscriptNotice } from '../../packages/web/src/stores/chat-store.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import { ROSTER, CLAUDE, GEMINI, makeThread, makeUserMessage, makeAgentReply } from './fixtures.js';

const THREAD = 'thread_todo_api';

function errorNotice(over: Partial<TranscriptNotice> = {}): TranscriptNotice {
  return {
    id: 'ntc_err_1',
    agentId: GEMINI,
    kind: 'error',
    text: 'gemini · upstream 429 降级，已自动切到备用',
    timestamp: Date.UTC(2026, 4, 31, 11, 0, 0),
    ...over,
  };
}

function systemNotice(over: Partial<TranscriptNotice> = {}): TranscriptNotice {
  return {
    id: 'ntc_sys_1',
    agentId: CLAUDE,
    kind: 'notice',
    text: 'codex 未启用（未检测到 CLI）— 可用：@claude',
    timestamp: Date.UTC(2026, 4, 31, 11, 30, 0),
    ...over,
  };
}

function seed(opts: {
  notices?: readonly TranscriptNotice[];
  messages?: readonly ReturnType<typeof makeUserMessage>[];
} = {}): void {
  useChatStore.setState({
    threads: [makeThread()],
    activeThreadId: THREAD,
    messagesByThread: { [THREAD]: opts.messages ?? [] },
    streamingByThread: {},
    noticesByThread: opts.notices ? { [THREAD]: opts.notices } : {},
  });
  useAgentStore.setState({ roster: ROSTER, statusById: {} });
}

beforeEach(() => seed());
afterEach(cleanup);

describe('right status-bar — 审计 & Session tabs switch content', () => {
  it('审计事件 (default) shows an honest empty state when there are no notices', () => {
    render(<AgentStatus />);
    expect(screen.getByText('暂无审计记录。')).toBeInTheDocument();
    expect(screen.queryAllByTestId('sb-audit-row')).toHaveLength(0);
  });

  it('审计事件 lists real notices (newest first) with the right tag + text', () => {
    seed({ notices: [errorNotice(), systemNotice()] });
    render(<AgentStatus />);
    const rows = screen.getAllByTestId('sb-audit-row');
    expect(rows).toHaveLength(2);
    // newest first: the system notice (later timestamp) leads.
    expect(within(rows[0]).getByText('system_info')).toBeInTheDocument();
    expect(within(rows[0]).getByText(/未启用/)).toBeInTheDocument();
    expect(within(rows[1]).getByText('agent_error')).toBeInTheDocument();
  });

  it('[edge] clicking Session switches to session rows derived from the thread (the inert-tab bug)', async () => {
    seed({
      messages: [
        makeUserMessage({ id: 'm1' }),
        makeAgentReply({ id: 'm2', sessionId: 'sess-3f2a9c11' }),
        makeAgentReply({ id: 'm3', sessionId: 'sess-3f2a9c11' }),
        makeAgentReply({ id: 'm4', sessionId: 'sess-9c1b0400' }),
      ],
    });
    render(<AgentStatus />);
    // Before the click we are on 审计事件 — no session rows yet.
    expect(screen.queryAllByTestId('sb-session-row')).toHaveLength(0);
    await userEvent.click(screen.getByTestId('sb-audit-tab-Session'));
    const rows = screen.getAllByTestId('sb-session-row');
    expect(rows).toHaveLength(2); // two distinct sessionIds
    expect(within(rows[0]).getByText('sess-3f2a9c11')).toBeInTheDocument();
    expect(within(rows[0]).getByText('2 条')).toBeInTheDocument(); // count is real
    expect(within(rows[1]).getByText('1 条')).toBeInTheDocument();
  });

  it('[edge] Session tab is honestly empty when no message carries a sessionId', async () => {
    seed({ messages: [makeUserMessage(), makeAgentReply()] });
    render(<AgentStatus />);
    await userEvent.click(screen.getByTestId('sb-audit-tab-Session'));
    expect(screen.getByText('暂无 session 记录。')).toBeInTheDocument();
  });

  it('[edge] 搜索 tab renders a working input that filters notices by text', async () => {
    seed({ notices: [errorNotice(), systemNotice()] });
    render(<AgentStatus />);
    await userEvent.click(screen.getByTestId('sb-audit-tab-搜索'));
    const input = screen.getByTestId('sb-audit-search');
    expect(input).toBeInTheDocument();
    await userEvent.type(input, '429');
    const rows = screen.getAllByTestId('sb-audit-row');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText(/429/)).toBeInTheDocument();
  });

  it('[edge] 搜索 by the tag name (agent_error) also matches', async () => {
    seed({ notices: [errorNotice(), systemNotice()] });
    render(<AgentStatus />);
    await userEvent.click(screen.getByTestId('sb-audit-tab-搜索'));
    await userEvent.type(screen.getByTestId('sb-audit-search'), 'agent_error');
    expect(screen.getAllByTestId('sb-audit-row')).toHaveLength(1);
  });

  it('[adversarial] a non-matching query shows a clear no-match message, not stale rows', async () => {
    seed({ notices: [errorNotice()] });
    render(<AgentStatus />);
    await userEvent.click(screen.getByTestId('sb-audit-tab-搜索'));
    await userEvent.type(screen.getByTestId('sb-audit-search'), 'zzzzz不存在');
    expect(screen.queryAllByTestId('sb-audit-row')).toHaveLength(0);
    expect(screen.getByText(/没有匹配/)).toBeInTheDocument();
  });

  it('[adversarial] 搜索 with zero notices shows the honest empty hint (no phantom rows)', async () => {
    render(<AgentStatus />); // seeded with no notices
    await userEvent.click(screen.getByTestId('sb-audit-tab-搜索'));
    expect(screen.getByTestId('sb-audit-search')).toBeInTheDocument();
    expect(screen.getByText('暂无可搜索的记录。')).toBeInTheDocument();
  });

  it('[adversarial] an error notice carries the red `err` tag class; a notice does not', () => {
    seed({ notices: [errorNotice(), systemNotice()] });
    render(<AgentStatus />);
    expect(screen.getByText('agent_error')).toHaveClass('err');
    expect(screen.getByText('system_info')).not.toHaveClass('err');
  });

  it('the active tab carries aria-selected and switching updates it', async () => {
    render(<AgentStatus />);
    expect(screen.getByTestId('sb-audit-tab-审计事件')).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByTestId('sb-audit-tab-Session'));
    expect(screen.getByTestId('sb-audit-tab-Session')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('sb-audit-tab-审计事件')).toHaveAttribute('aria-selected', 'false');
  });
});
