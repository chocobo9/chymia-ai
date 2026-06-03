// @vitest-environment jsdom
//
// F078 (MVP) — the 全体 composer broadcasts. Selecting 全体 (no locked agent) and
// sending a bare message prepends the broadcast token @all so the turn fans out to
// ALL agents instead of falling to a single default. An explicit @mention or an
// already-typed broadcast token sends verbatim; a specific lock still targets that
// agent. Gates the composer send-shape only (routing is gated server-side).
//
// Distribution: happy ≤50%, edge ≥30%, adversarial ≥20%.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatInput } from '../../packages/web/src/components/ChatInput.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import { ROSTER } from './fixtures.js';

beforeEach(() => useAgentStore.setState({ roster: ROSTER, statusById: {} }));
afterEach(cleanup);

async function sendText(text: string): Promise<void> {
  await userEvent.type(screen.getByTestId('chat-input-textarea'), text);
  await userEvent.click(screen.getByTestId('chat-send-button'));
}

describe('ChatInput — 全体 broadcasts with @all (F078)', () => {
  it('[happy] 全体 + a bare message prepends @all so the turn broadcasts', async () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} onLockChange={vi.fn()} />); // no lockedAgentId → 全体
    await sendText('你们三个都做个自我介绍');
    expect(onSend).toHaveBeenCalledWith('@all 你们三个都做个自我介绍');
  });

  it('[edge] 全体 + an explicit @mention sends verbatim (no @all prepended)', async () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} onLockChange={vi.fn()} />);
    await sendText('@gemini 你先来');
    expect(onSend).toHaveBeenCalledWith('@gemini 你先来');
  });

  it('[edge] 全体 + an already-typed @全体 is not double-prepended', async () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} onLockChange={vi.fn()} />);
    await sendText('@全体 自我介绍');
    expect(onSend).toHaveBeenCalledWith('@全体 自我介绍'); // sent as-is, no extra @all
  });

  it('[adversarial] a specific agent lock still targets that agent — never broadcasts', async () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} onLockChange={vi.fn()} lockedAgentId="claude-opus" />);
    await sendText('继续重构 router');
    expect(onSend).toHaveBeenCalledWith('@claude 继续重构 router');
    expect(onSend).not.toHaveBeenCalledWith(expect.stringContaining('@all'));
  });
});
