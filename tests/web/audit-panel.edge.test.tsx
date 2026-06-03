// @vitest-environment jsdom
//
// AuditPanel — the per-thread audit timeline (browse + filter). Gates that it
// renders the merged entries from the injected client, and that the agent + type
// filters actually narrow the visible rows. Fake client; real-shaped AuditEntry data.

import '@testing-library/jest-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuditEntry } from '@choco/shared';
import { AuditPanel } from '../../packages/web/src/components/overlays/AuditPanel.js';
import type { ApiClient } from '../../packages/web/src/lib/api.js';
import { ROSTER, CLAUDE, CODEX } from './fixtures.js';

afterEach(cleanup);

const ENTRIES: readonly AuditEntry[] = [
  { type: 'session_start', agentId: CLAUDE, timestamp: 1_700_000_010_000, sessionId: 's1', sequenceNo: 1 },
  { type: 'tool', agentId: CLAUDE, timestamp: 1_700_000_020_000, toolName: 'Write', durationMs: 42, invocationId: 'inv1' },
  { type: 'reply', agentId: CLAUDE, timestamp: 1_700_000_030_000, textChars: 120, toolCount: 2 },
  { type: 'reply', agentId: CODEX, timestamp: 1_700_000_040_000, textChars: 8, isError: true },
  { type: 'tool', agentId: CODEX, timestamp: 1_700_000_050_000, toolName: 'Read', durationMs: 5, invocationId: 'inv2' },
];

function fakeClient(getAudit = vi.fn().mockResolvedValue(ENTRIES)): ApiClient {
  return { getAudit } as unknown as ApiClient;
}

function rows(): HTMLElement[] {
  return screen.queryAllByTestId('audit-row');
}

describe('AuditPanel — timeline + filters', () => {
  it('renders every entry with its agent + a type-specific description', async () => {
    render(<AuditPanel onClose={vi.fn()} client={fakeClient()} threadId="t" roster={ROSTER} />);
    await screen.findAllByTestId('audit-row');
    expect(rows()).toHaveLength(5);
    // type-specific descriptions surface.
    expect(screen.getByText(/🔧 Write · 42ms/)).toBeInTheDocument();
    expect(screen.getByText(/回复 · 120 字 · 2 次工具/)).toBeInTheDocument();
    expect(screen.getByText(/开启 session #1/)).toBeInTheDocument();
    expect(screen.getByText(/通知 \/ 错误回复/)).toBeInTheDocument();
  });

  it('the agent filter narrows the timeline to one agent', async () => {
    render(<AuditPanel onClose={vi.fn()} client={fakeClient()} threadId="t" roster={ROSTER} />);
    await screen.findAllByTestId('audit-row');
    await userEvent.click(screen.getByTestId('audit-agent-codex-gpt'));
    const visible = rows();
    expect(visible).toHaveLength(2); // codex: 1 reply + 1 tool
    expect(visible.every((r) => r.getAttribute('data-agent') === 'codex-gpt')).toBe(true);
  });

  it('the type filter narrows the timeline to one entry kind', async () => {
    render(<AuditPanel onClose={vi.fn()} client={fakeClient()} threadId="t" roster={ROSTER} />);
    await screen.findAllByTestId('audit-row');
    await userEvent.click(screen.getByTestId('audit-type-tool'));
    const visible = rows();
    expect(visible).toHaveLength(2); // two tool calls
    expect(visible.every((r) => r.getAttribute('data-type') === 'tool')).toBe(true);
  });

  it('(edge) an empty timeline shows an honest note, no rows', async () => {
    render(
      <AuditPanel onClose={vi.fn()} client={fakeClient(vi.fn().mockResolvedValue([]))} threadId="t" roster={ROSTER} />,
    );
    expect(await screen.findByText(/还没有可审计的活动/)).toBeInTheDocument();
    expect(rows()).toHaveLength(0);
  });
});
