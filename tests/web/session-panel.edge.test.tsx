// @vitest-environment jsdom
//
// SessionPanel — the OPERABLE session-chain surface. Gates that it renders a
// thread's chain from the injected client, shows each session's digest summary,
// lazily loads a transcript on expand, and that the 封存 (seal) action calls the
// client AND refetches the chain. Fake client (no real backend); real-shaped
// SessionChainEntry / SessionEvent data.

import '@testing-library/jest-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionEvent } from '@choco/shared';
import { SessionPanel } from '../../packages/web/src/components/overlays/SessionPanel.js';
import type { ApiClient, SessionChainEntry } from '../../packages/web/src/lib/api.js';
import { ROSTER, CLAUDE } from './fixtures.js';

afterEach(cleanup);

const CHAIN: readonly SessionChainEntry[] = [
  {
    sessionId: 's1',
    threadId: 't',
    agentId: CLAUDE,
    sequenceNo: 1,
    status: 'sealed',
    createdAt: 1_700_000_100_000,
    sealedAt: 1_700_000_200_000,
    digest: {
      messageCount: 3,
      toolCounts: { Write: 2, Read: 1 },
      filesTouched: ['two-sum-viz.html'],
      errorCount: 0,
      durationMs: 5000,
      firstAt: 1_700_000_100_000,
      lastAt: 1_700_000_200_000,
    },
  },
  {
    sessionId: 's2',
    threadId: 't',
    agentId: CLAUDE,
    sequenceNo: 2,
    status: 'active',
    createdAt: 1_700_000_300_000,
    digest: { messageCount: 0, toolCounts: {}, filesTouched: [], errorCount: 0, durationMs: 0, firstAt: 0, lastAt: 0 },
  },
];

const TRANSCRIPT: readonly SessionEvent[] = [
  { kind: 'message', id: 'm1', agentId: CLAUDE, timestamp: 1_700_000_110_000, content: '写好了 two-sum-viz.html' },
  { kind: 'tool_event', id: 'te1', agentId: CLAUDE, timestamp: 1_700_000_120_000, toolName: 'Write', durationMs: 42 },
];

interface FakeClientParts {
  getSessions?: ReturnType<typeof vi.fn>;
  getSessionTranscript?: ReturnType<typeof vi.fn>;
  sealSession?: ReturnType<typeof vi.fn>;
  reopenSession?: ReturnType<typeof vi.fn>;
}
function fakeClient(parts: FakeClientParts = {}): ApiClient {
  return {
    getSessions: parts.getSessions ?? vi.fn().mockResolvedValue(CHAIN),
    getSessionTranscript: parts.getSessionTranscript ?? vi.fn().mockResolvedValue(TRANSCRIPT),
    sealSession: parts.sealSession ?? vi.fn().mockResolvedValue({ status: 'sealed' }),
    reopenSession: parts.reopenSession ?? vi.fn().mockResolvedValue({ status: 'active' }),
  } as unknown as ApiClient;
}

describe('SessionPanel — chain rendering', () => {
  it('renders the chain with seq, status badges, digest chips, and a 封存 button on the LIVE one only', async () => {
    render(<SessionPanel onClose={vi.fn()} client={fakeClient()} threadId="t" roster={ROSTER} />);
    const cards = await screen.findAllByTestId('session-card');
    expect(cards).toHaveLength(2);
    // #1 sealed, #2 active.
    expect(cards[0]).toHaveAttribute('data-status', 'sealed');
    expect(cards[1]).toHaveAttribute('data-status', 'active');
    // digest summary on the sealed one (3 messages / 3 tool calls / 1 file).
    expect(within(cards[0]).getByText('3 条消息')).toBeInTheDocument();
    expect(within(cards[0]).getByText('3 次工具')).toBeInTheDocument();
    expect(within(cards[0]).getByText('1 个文件')).toBeInTheDocument();
    // Only the active session is sealable.
    expect(within(cards[1]).getByTestId('session-seal')).toBeInTheDocument();
    expect(within(cards[0]).queryByTestId('session-seal')).not.toBeInTheDocument();
  });

  it('an empty chain shows an honest empty note (no fabricated rows)', async () => {
    render(
      <SessionPanel
        onClose={vi.fn()}
        client={fakeClient({ getSessions: vi.fn().mockResolvedValue([]) })}
        threadId="t"
        roster={ROSTER}
      />,
    );
    expect(await screen.findByText(/还没有 session/)).toBeInTheDocument();
    expect(screen.queryByTestId('session-card')).not.toBeInTheDocument();
  });
});

describe('SessionPanel — operable actions', () => {
  it('expanding a session lazily loads + shows its transcript', async () => {
    const getSessionTranscript = vi.fn().mockResolvedValue(TRANSCRIPT);
    render(
      <SessionPanel onClose={vi.fn()} client={fakeClient({ getSessionTranscript })} threadId="t" roster={ROSTER} />,
    );
    const cards = await screen.findAllByTestId('session-card');
    // Transcript not fetched until the user expands.
    expect(getSessionTranscript).not.toHaveBeenCalled();
    await userEvent.click(within(cards[0]).getByTestId('session-expand'));
    expect(getSessionTranscript).toHaveBeenCalledWith('s1');
    const transcript = await within(cards[0]).findByTestId('session-transcript');
    expect(within(transcript).getByText('写好了 two-sum-viz.html')).toBeInTheDocument();
    expect(within(transcript).getByText(/Write/)).toBeInTheDocument();
  });

  it('a SEALED session shows 恢复 (not 封存); clicking it reopens + refetches', async () => {
    const getSessions = vi.fn().mockResolvedValue(CHAIN);
    const reopenSession = vi.fn().mockResolvedValue({ status: 'active' });
    render(
      <SessionPanel onClose={vi.fn()} client={fakeClient({ getSessions, reopenSession })} threadId="t" roster={ROSTER} />,
    );
    const cards = await screen.findAllByTestId('session-card');
    // #1 is sealed → 恢复, not 封存. #2 is active → 封存, not 恢复.
    expect(within(cards[0]).getByTestId('session-reopen')).toBeInTheDocument();
    expect(within(cards[0]).queryByTestId('session-seal')).not.toBeInTheDocument();
    expect(within(cards[1]).queryByTestId('session-reopen')).not.toBeInTheDocument();

    await userEvent.click(within(cards[0]).getByTestId('session-reopen'));
    expect(reopenSession).toHaveBeenCalledWith('s1');
    expect(getSessions).toHaveBeenCalledTimes(2); // refetch after reopen
  });

  it('封存 calls sealSession for that session AND refetches the chain', async () => {
    const getSessions = vi.fn().mockResolvedValue(CHAIN);
    const sealSession = vi.fn().mockResolvedValue({ status: 'sealed' });
    render(
      <SessionPanel onClose={vi.fn()} client={fakeClient({ getSessions, sealSession })} threadId="t" roster={ROSTER} />,
    );
    const cards = await screen.findAllByTestId('session-card');
    expect(getSessions).toHaveBeenCalledTimes(1); // initial load
    await userEvent.click(within(cards[1]).getByTestId('session-seal'));
    expect(sealSession).toHaveBeenCalledWith('s2');
    // Re-reads the chain so the just-sealed session flips in the UI.
    expect(getSessions).toHaveBeenCalledTimes(2);
  });

  it('[adversarial] a FAILED 封存 surfaces an inline error — never a silent no-op', async () => {
    // Reproduces the symptom of the empty-JSON-body bug: the POST rejects and the
    // click must NOT look like nothing happened. The error has to be visible.
    const sealSession = vi
      .fn()
      .mockRejectedValue(new Error("Body cannot be empty when content-type is set to 'application/json'"));
    render(
      <SessionPanel onClose={vi.fn()} client={fakeClient({ sealSession })} threadId="t" roster={ROSTER} />,
    );
    const cards = await screen.findAllByTestId('session-card');
    await userEvent.click(within(cards[1]).getByTestId('session-seal'));
    const banner = await screen.findByTestId('session-action-error');
    expect(banner).toHaveTextContent(/操作失败/);
    expect(banner).toHaveTextContent(/Body cannot be empty/);
  });
});
