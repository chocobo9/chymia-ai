// @vitest-environment jsdom
//
// Right status-bar — the 审计 & Session panel, to the original Choco design (2026-06-03):
// a collapsible card, three tabs (审计事件 / Session / 搜索), audit rows shown as a
// [type-tag] pill + relative time, a 运行日志 · 查看日志 foot — wired to REAL data.
// 封存/恢复 act inline on Session rows. No main-bar buttons, no overlays.
//
// Distribution: happy ≤50%, edge ≥30%, adversarial ≥20%.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuditEvent, SessionEvent } from '@choco/shared';
import { AgentStatus } from '../../packages/web/src/components/AgentStatus.js';
import { ApiClient, type SessionChainEntry } from '../../packages/web/src/lib/api.js';
import { useChatStore } from '../../packages/web/src/stores/chat-store.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import { ROSTER, CLAUDE } from './fixtures.js';

const THREAD = 'thread_todo_api';

const CHAIN: readonly SessionChainEntry[] = [
  { sessionId: 'sess-3f2a9c11', threadId: THREAD, agentId: CLAUDE, sequenceNo: 1, status: 'sealed', createdAt: 1_700_000_100_000, sealedAt: 1_700_000_200_000, digest: null },
  { sessionId: 'sess-9c1b0400', threadId: THREAD, agentId: CLAUDE, sequenceNo: 2, status: 'active', createdAt: 1_700_000_300_000, digest: null },
];
// Real audit-event shape (matches what the engine emits + GET /api/audit/thread/:id
// returns in tests/api/audit-routes.test.ts): typed lifecycle events, newest-first,
// each with a `data` payload the row expands to.
const AUDIT: readonly AuditEvent[] = [
  { id: 'a3', type: 'session_seal', threadId: THREAD, timestamp: 1_700_000_200_000, data: { sessionId: 'sess-9c1b0400', agentId: CLAUDE, sequenceNo: 1 } },
  { id: 'a2', type: 'responded', threadId: THREAD, timestamp: 1_700_000_120_000, data: { agentId: CLAUDE, invocationId: 'inv-1', durationMs: 1234, textChars: 128, toolCalls: 2 } },
  { id: 'a1', type: 'invoked', threadId: THREAD, timestamp: 1_700_000_110_000, data: { agentId: CLAUDE, invocationId: 'inv-1', mode: 'serial' } },
];
// Real merged-transcript shape (matches what GET /api/sessions/:id/transcript returns
// in tests/api/session-routes.test.ts): a `message` event carrying the agent's reply
// text + a `tool_event` carrying the tool name/duration.
const TRANSCRIPT: readonly SessionEvent[] = [
  { kind: 'message', id: 'msg-1', agentId: CLAUDE, timestamp: 1_700_000_110_000, content: '我先写两数之和的哈希解法，再加可视化。' },
  { kind: 'tool_event', id: 'te-1', agentId: CLAUDE, timestamp: 1_700_000_120_000, toolName: 'Write', durationMs: 42, toolInput: '{"file_path":"two-sum-viz.html"}' },
];

function fakeClient(
  over: { sessions?: readonly SessionChainEntry[]; audit?: readonly AuditEvent[]; transcript?: readonly SessionEvent[] } = {},
): ApiClient {
  const client = new ApiClient({ baseUrl: 'http://test', fetchFn: () => Promise.reject(new Error('no net')) });
  vi.spyOn(client, 'getSessions').mockResolvedValue(over.sessions ?? CHAIN);
  vi.spyOn(client, 'getAudit').mockResolvedValue(over.audit ?? AUDIT);
  vi.spyOn(client, 'getSessionTranscript').mockResolvedValue(over.transcript ?? TRANSCRIPT);
  vi.spyOn(client, 'sealSession').mockResolvedValue({ status: 'sealed' });
  vi.spyOn(client, 'reopenSession').mockResolvedValue({ status: 'active' });
  return client;
}

function seed(activeThreadId: string | null = THREAD): void {
  useChatStore.setState({ threads: [], activeThreadId, messagesByThread: {}, streamingByThread: {}, noticesByThread: {} });
  useAgentStore.setState({ roster: ROSTER, statusById: {} });
}

beforeEach(() => seed());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('审计 & Session panel — original Choco design, real data', () => {
  it('[happy] three tabs + 审计事件 rows as [type-tag] + relative time', async () => {
    render(<AgentStatus client={fakeClient()} />);
    expect(screen.getByTestId('sb-audit-tab-审计事件')).toHaveClass('on');
    expect(screen.getByTestId('sb-audit-tab-Session')).toBeInTheDocument();
    expect(screen.getByTestId('sb-audit-tab-搜索')).toBeInTheDocument();
    const events = await screen.findAllByTestId('sb-audit-event');
    expect(events).toHaveLength(3);
    // Newest-first: session_seal, responded, invoked — the type IS the pill.
    expect(within(events[0]).getByText('session_seal')).toBeInTheDocument();
    expect(within(events[1]).getByText('responded')).toBeInTheDocument();
    expect(within(events[2]).getByText('invoked')).toBeInTheDocument();
    expect(within(events[0]).getByText(/ago$/)).toBeInTheDocument(); // relative time
  });

  it('[happy] the Session tab lists the session chain (real, from getSessions)', async () => {
    render(<AgentStatus client={fakeClient()} />);
    await screen.findAllByTestId('sb-audit-event');
    await userEvent.click(screen.getByTestId('sb-audit-tab-Session'));
    const rows = await screen.findAllByTestId('sb-session-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[1]).getByText(/进行中/)).toBeInTheDocument();
  });

  it('[edge] 封存 an active session calls sealSession inline + refetches', async () => {
    const client = fakeClient();
    render(<AgentStatus client={client} />);
    await screen.findAllByTestId('sb-audit-event');
    await userEvent.click(screen.getByTestId('sb-audit-tab-Session'));
    const rows = await screen.findAllByTestId('sb-session-row');
    const active = rows.find((r) => r.getAttribute('data-status') === 'active');
    await userEvent.click(within(active as HTMLElement).getByTestId('sb-session-seal'));
    expect(client.sealSession).toHaveBeenCalledWith('sess-9c1b0400');
    await waitFor(() => expect(vi.mocked(client.getSessions).mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('[edge] 恢复 a sealed session calls reopenSession inline', async () => {
    const client = fakeClient();
    render(<AgentStatus client={client} />);
    await screen.findAllByTestId('sb-audit-event');
    await userEvent.click(screen.getByTestId('sb-audit-tab-Session'));
    const rows = await screen.findAllByTestId('sb-session-row');
    const sealed = rows.find((r) => r.getAttribute('data-status') === 'sealed');
    await userEvent.click(within(sealed as HTMLElement).getByTestId('sb-session-reopen'));
    expect(client.reopenSession).toHaveBeenCalledWith('sess-3f2a9c11');
  });

  it('[edge] the 搜索 tab filters the audit rows live (by event type)', async () => {
    render(<AgentStatus client={fakeClient()} />);
    await screen.findAllByTestId('sb-audit-event');
    await userEvent.click(screen.getByTestId('sb-audit-tab-搜索'));
    await userEvent.type(screen.getByTestId('sb-audit-search'), 'invoked');
    const events = screen.getAllByTestId('sb-audit-event');
    expect(events).toHaveLength(1);
    expect(within(events[0]).getByText('invoked')).toBeInTheDocument();
  });

  it('[edge] the panel is collapsible — toggling hides the tab body', async () => {
    render(<AgentStatus client={fakeClient()} />);
    await screen.findAllByTestId('sb-audit-event');
    await userEvent.click(screen.getByTestId('sb-explorer-toggle'));
    expect(screen.queryByTestId('sb-explorer-body')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sb-audit-tab-审计事件')).not.toBeInTheDocument();
  });

  it('[adversarial] has the 运行日志·查看日志 foot, and NO main-bar/overlay doors', async () => {
    render(<AgentStatus client={fakeClient()} />);
    await screen.findAllByTestId('sb-audit-event');
    expect(screen.getByText('运行日志')).toBeInTheDocument();
    expect(screen.getByTestId('sb-view-logs')).toBeInTheDocument();
    expect(screen.queryByTestId('sb-open-audit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sb-open-sessions')).not.toBeInTheDocument();
  });

  it('[happy] clicking an 审计事件 row expands its data payload (具体发生了什么)', async () => {
    render(<AgentStatus client={fakeClient()} />);
    const rows = await screen.findAllByTestId('sb-audit-event');
    expect(screen.queryByTestId('sb-audit-detail')).not.toBeInTheDocument(); // collapsed by default
    await userEvent.click(within(rows[1]).getByTestId('sb-audit-event-toggle')); // the 'responded' row
    const detail = await screen.findByTestId('sb-audit-detail');
    // The event's data is shown verbatim (durationMs / textChars / toolCalls / invocationId).
    expect(within(detail).getByText(/toolCalls/)).toBeInTheDocument();
    expect(within(detail).getByText(/inv-1/)).toBeInTheDocument();
  });

  it('[edge] a row expands on click and collapses on a second click', async () => {
    render(<AgentStatus client={fakeClient()} />);
    await screen.findAllByTestId('sb-audit-event');
    const toggle = (): HTMLElement =>
      within(screen.getAllByTestId('sb-audit-event')[1]).getByTestId('sb-audit-event-toggle');
    await userEvent.click(toggle());
    expect(await screen.findByTestId('sb-audit-detail')).toBeInTheDocument();
    await userEvent.click(toggle());
    expect(screen.queryByTestId('sb-audit-detail')).not.toBeInTheDocument();
  });

  it('[adversarial] with NO client the panel is inert (no crash); the live readout still renders', async () => {
    render(<AgentStatus />);
    expect(screen.getByTestId('agent-status')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('该会话还没有可审计的活动。')).toBeInTheDocument());
  });
});

// Clicking a session must OPEN its transcript (具体发送了什么) — the row was display-only
// before. Mirrors Clowder's audit/SessionEventsViewer: click a session → its real
// messages + tool calls render (fetched via ApiClient.getSessionTranscript).
describe('Session transcript viewer — click a session row to see what was actually sent', () => {
  async function openFirstSession(client: ApiClient): Promise<void> {
    render(<AgentStatus client={client} />);
    await screen.findAllByTestId('sb-audit-event');
    await userEvent.click(screen.getByTestId('sb-audit-tab-Session'));
    const rows = await screen.findAllByTestId('sb-session-open');
    await userEvent.click(rows[0]);
  }

  it('[happy] opens the clicked session and renders its real message content + tool call', async () => {
    const client = fakeClient();
    await openFirstSession(client);

    await waitFor(() => expect(client.getSessionTranscript).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('session-transcript')).toBeInTheDocument();
    const events = await screen.findAllByTestId('session-event');
    expect(events).toHaveLength(2); // one message + one tool_event
    // The ACTUAL reply text the user couldn't see before is now shown.
    expect(screen.getByText(/哈希解法/)).toBeInTheDocument();
    // The tool call that ran is shown too.
    expect(screen.getByText(/Write/)).toBeInTheDocument();
  });

  it('[edge] 返回 closes the viewer and restores the session list', async () => {
    const client = fakeClient();
    await openFirstSession(client);
    await screen.findByTestId('session-transcript');

    await userEvent.click(screen.getByTestId('session-viewer-close'));

    expect(screen.queryByTestId('session-transcript')).not.toBeInTheDocument();
    expect((await screen.findAllByTestId('sb-session-row')).length).toBeGreaterThan(0);
  });

  it('[edge] a session with an empty transcript shows the honest empty state', async () => {
    const client = fakeClient({ transcript: [] });
    await openFirstSession(client);
    expect(await screen.findByText('这个 session 还没有记录。')).toBeInTheDocument();
  });

  it('[adversarial] a failing getSessionTranscript surfaces 加载失败, never crashes the panel', async () => {
    const client = fakeClient();
    vi.mocked(client.getSessionTranscript).mockRejectedValue(new Error('net down'));
    await openFirstSession(client);
    expect(await screen.findByText('会话记录加载失败。')).toBeInTheDocument();
  });
});
