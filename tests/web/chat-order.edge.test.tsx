// @vitest-environment jsdom
//
// Regression: the transcript must render in ONE chronological stream (by
// timestamp), NOT as three sequential blocks (all persisted → all streaming →
// all notices). The block layout made a live reply / a mirrored 飞书 message show
// out of time order on the web while 飞书 (which appends in arrival order) looked
// fine — the symptom the user reported ("网页端消息顺序很奇怪，飞书端正常").

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { StoredMessage } from '@choco/shared';
import { ChatContainer } from '../../packages/web/src/components/ChatContainer.js';
import {
  useChatStore,
  type StreamingMessage,
  type TranscriptNotice,
} from '../../packages/web/src/stores/chat-store.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import { ROSTER, CLAUDE, GEMINI } from './fixtures.js';

const THREAD = 'thread_order';

function userMsg(id: string, content: string, ts: number): StoredMessage {
  return { id, threadId: THREAD, userId: 'user', agentId: null, content, mentions: [], origin: 'user', timestamp: ts };
}
function agentReply(id: string, content: string, ts: number): StoredMessage {
  return { id, threadId: THREAD, userId: 'user', agentId: CLAUDE, content, mentions: [], origin: 'stream', timestamp: ts };
}
function streamMsg(agentId: typeof GEMINI, text: string, startedAt: number): StreamingMessage {
  return { key: `${agentId as string}:inv-s`, agentId, text, thinking: '', toolBlocks: [], startedAt };
}
function notice(id: string, text: string, ts: number): TranscriptNotice {
  return { id, agentId: CLAUDE, kind: 'notice', text, timestamp: ts };
}

beforeEach(() => {
  useAgentStore.setState({ roster: ROSTER, statusById: {} });
});
afterEach(() => cleanup());

describe('ChatContainer — chronological merge of persisted + streaming + notices', () => {
  it('[regression] renders entries in timestamp order, not persisted→streaming→notice block order', () => {
    // Persisted are seeded OUT of the desired interleaving on purpose: a live
    // stream (ts=200) belongs BETWEEN the two persisted (100, 300), and a notice
    // (400) last. Pre-fix block order would render 100,300 (persisted) then 200
    // (streaming) then 400 → 100,300,200,400 (wrong).
    useChatStore.setState({
      threads: [],
      activeThreadId: THREAD,
      messagesByThread: { [THREAD]: [userMsg('m-a', '问题A 100', 100), agentReply('m-c', '回复C 300', 300)] },
      streamingByThread: { [THREAD]: [streamMsg(GEMINI, '流式B 200', 200)] },
      noticesByThread: { [THREAD]: [notice('n-d', '通知D 400', 400)] },
    });

    const { container } = render(<ChatContainer />);

    // All transcript entries in DOM order (any of the three rendered kinds).
    const nodes = container.querySelectorAll(
      '[data-testid="user-message"],[data-testid="agent-message"],[data-testid="transcript-notice"]',
    );
    const order = Array.from(nodes).map((n) => {
      const text = n.textContent ?? '';
      return text.includes('100') ? 'A' : text.includes('200') ? 'B' : text.includes('300') ? 'C' : 'D';
    });

    // Chronological by timestamp — the live stream (B) sits between the persisted A and C.
    expect(order).toEqual(['A', 'B', 'C', 'D']);
  });
});
