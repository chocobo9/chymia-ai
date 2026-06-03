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
import type { AuditEntry } from '@choco/shared';
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
const AUDIT: readonly AuditEntry[] = [
  { type: 'reply', agentId: CLAUDE, timestamp: 1_700_000_110_000, textChars: 128, toolCount: 2 },
  { type: 'tool', agentId: CLAUDE, timestamp: 1_700_000_120_000, toolName: 'Write', durationMs: 42 },
  { type: 'session_seal', agentId: CLAUDE, timestamp: 1_700_000_200_000, sequenceNo: 1 },
];

function fakeClient(over: { sessions?: readonly SessionChainEntry[]; audit?: readonly AuditEntry[] } = {}): ApiClient {
  const client = new ApiClient({ baseUrl: 'http://test', fetchFn: () => Promise.reject(new Error('no net')) });
  vi.spyOn(client, 'getSessions').mockResolvedValue(over.sessions ?? CHAIN);
  vi.spyOn(client, 'getAudit').mockResolvedValue(over.audit ?? AUDIT);
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
    expect(within(events[0]).getByText('replied')).toBeInTheDocument(); // reply → type pill
    expect(within(events[1]).getByText('tool · Write')).toBeInTheDocument();
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

  it('[edge] the 搜索 tab filters the audit rows live (by type)', async () => {
    render(<AgentStatus client={fakeClient()} />);
    await screen.findAllByTestId('sb-audit-event');
    await userEvent.click(screen.getByTestId('sb-audit-tab-搜索'));
    await userEvent.type(screen.getByTestId('sb-audit-search'), 'tool');
    const events = screen.getAllByTestId('sb-audit-event');
    expect(events).toHaveLength(1);
    expect(within(events[0]).getByText('tool · Write')).toBeInTheDocument();
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

  it('[adversarial] with NO client the panel is inert (no crash); the live readout still renders', async () => {
    render(<AgentStatus />);
    expect(screen.getByTestId('agent-status')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('该会话还没有可审计的活动。')).toBeInTheDocument());
  });
});
