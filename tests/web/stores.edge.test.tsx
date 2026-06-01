// @vitest-environment jsdom
//
// M9 QA — edge + adversarial coverage for the chat-store and agent-store
// reducers. Focus: deep immutability (prior state reference + nested
// collections never mutated), idempotency, parallel-agent streaming isolation,
// hostile/out-of-order folds, clearStreaming scoping, unknown-agent status.
//
// dev≠QA: authored by the M9 QA instance; no product code modified.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../../packages/web/src/stores/chat-store.js';
import {
  useAgentStore,
  selectAgentStatus,
} from '../../packages/web/src/stores/agent-store.js';
import type { AgentMessage } from '@clowder/shared';
import { createAgentId } from '@clowder/shared';
import {
  CLAUDE,
  CODEX,
  GEMINI,
  ROSTER,
  makeThread,
  makeUserMessage,
  makeAgentReply,
  textFrame,
  doneFrame,
  workingStatus,
  idleStatus,
} from './fixtures.js';

function resetChat(): void {
  useChatStore.setState({
    threads: [],
    messagesByThread: {},
    streamingByThread: {},
    activeThreadId: null,
  });
}

function resetAgents(): void {
  useAgentStore.setState({ roster: [], statusById: {} });
}

describe('chat-store immutability (CRITICAL, adversarial)', () => {
  beforeEach(resetChat);

  it('addMessage does not mutate the prior messagesByThread map or its arrays', () => {
    const user = makeUserMessage();
    useChatStore.getState().setMessages('thread_todo_api', [user]);
    const beforeMap = useChatStore.getState().messagesByThread;
    const beforeArr = beforeMap['thread_todo_api'];
    const beforeArrSnapshot = [...beforeArr];

    useChatStore.getState().addMessage(makeAgentReply());

    // Prior map reference + prior array reference must be unchanged.
    const afterMap = useChatStore.getState().messagesByThread;
    expect(afterMap).not.toBe(beforeMap);
    expect(afterMap['thread_todo_api']).not.toBe(beforeArr);
    // The captured prior array object itself was not mutated in place.
    expect(beforeArr).toEqual(beforeArrSnapshot);
    expect(beforeArr).toHaveLength(1);
  });

  it('addMessage on a duplicate id returns a no-op patch that keeps the SAME map reference', () => {
    const reply = makeAgentReply();
    useChatStore.getState().addMessage(reply);
    const beforeMap = useChatStore.getState().messagesByThread;
    const beforeArr = beforeMap['thread_todo_api'];

    useChatStore.getState().addMessage(reply); // duplicate id

    const afterMap = useChatStore.getState().messagesByThread;
    // No-op merge ({}) must leave the existing map + array identities intact.
    expect(afterMap).toBe(beforeMap);
    expect(afterMap['thread_todo_api']).toBe(beforeArr);
    expect(afterMap['thread_todo_api']).toHaveLength(1);
  });

  it('reconcileReplies with only-already-present replies does not duplicate and preserves arrays', () => {
    const reply = makeAgentReply();
    useChatStore.getState().addMessage(reply);
    const beforeArr = useChatStore.getState().messagesByThread['thread_todo_api'];

    useChatStore.getState().reconcileReplies([reply, reply]); // both duplicates

    const afterArr = useChatStore.getState().messagesByThread['thread_todo_api'];
    expect(afterArr).toHaveLength(1);
    expect(beforeArr).toHaveLength(1); // prior snapshot untouched
  });

  it('reconcileReplies spreads replies across multiple threads without cross-contamination', () => {
    useChatStore.getState().reconcileReplies([
      makeAgentReply({ id: 'r_a', threadId: 'thread_alpha', content: 'Alpha 线程的回复。' }),
      makeAgentReply({ id: 'r_b', threadId: 'thread_beta', agentId: CODEX, content: 'Beta 线程的回复。' }),
    ]);
    const byThread = useChatStore.getState().messagesByThread;
    expect(byThread['thread_alpha']).toHaveLength(1);
    expect(byThread['thread_beta']).toHaveLength(1);
    expect(byThread['thread_alpha'][0].content).toBe('Alpha 线程的回复。');
    expect(byThread['thread_beta'][0].agentId).toBe(CODEX);
  });

  it('upsertThread editing an existing thread leaves the prior array element object intact', () => {
    const original = makeThread();
    useChatStore.getState().setThreads([original]);
    const beforeArr = useChatStore.getState().threads;

    useChatStore.getState().upsertThread(makeThread({ title: '改名后的会话' }));

    const afterArr = useChatStore.getState().threads;
    expect(afterArr).not.toBe(beforeArr);
    // The original Thread object reference (captured) was not mutated.
    expect(original.title).toBe('TODO API 设计与实现');
    expect(afterArr[0].title).toBe('改名后的会话');
  });
});

describe('chat-store streaming fold (edge + adversarial)', () => {
  beforeEach(resetChat);

  it('keeps two parallel agents in separate buffers under interleaved deltas (no cross-contamination)', () => {
    const t = 'thread_ideate';
    // Interleave Claude / Codex frames; distinct invocationId per agent.
    useChatStore.getState().applyAgentEvent(t, { type: 'text', agentId: CLAUDE, content: '方案A：', invocationId: 'inv_c', timestamp: 1 });
    useChatStore.getState().applyAgentEvent(t, { type: 'text', agentId: CODEX, content: '脚本：', invocationId: 'inv_x', timestamp: 2 });
    useChatStore.getState().applyAgentEvent(t, { type: 'text', agentId: CLAUDE, content: '用 Repository 模式。', invocationId: 'inv_c', timestamp: 3 });
    useChatStore.getState().applyAgentEvent(t, { type: 'text', agentId: CODEX, content: 'pnpm run seed。', invocationId: 'inv_x', timestamp: 4 });

    const streams = useChatStore.getState().streamingByThread[t];
    expect(streams).toHaveLength(2);
    const byKey = Object.fromEntries(streams.map((s) => [s.key, s.text]));
    expect(byKey['claude-opus:inv_c']).toBe('方案A：用 Repository 模式。');
    expect(byKey['codex-gpt:inv_x']).toBe('脚本：pnpm run seed。');
  });

  it('same agent, two distinct invocationIds → two separate streaming buffers', () => {
    const t = 'thread_todo_api';
    useChatStore.getState().applyAgentEvent(t, { type: 'text', agentId: CLAUDE, content: '第一次调用。', invocationId: 'inv_1', timestamp: 1 });
    useChatStore.getState().applyAgentEvent(t, { type: 'text', agentId: CLAUDE, content: '第二次调用。', invocationId: 'inv_2', timestamp: 2 });
    const streams = useChatStore.getState().streamingByThread[t];
    expect(streams).toHaveLength(2);
    expect(streams.map((s) => s.key).sort()).toEqual(['claude-opus:inv_1', 'claude-opus:inv_2']);
  });

  it('AgentMessage with no invocationId folds into the shared "default" key bucket', () => {
    const t = 'thread_todo_api';
    const noInv: AgentMessage = { type: 'text', agentId: CLAUDE, content: '无 invocationId 的帧。', timestamp: 1 };
    const noInv2: AgentMessage = { type: 'text', agentId: CLAUDE, content: '继续。', timestamp: 2 };
    useChatStore.getState().applyAgentEvent(t, noInv);
    useChatStore.getState().applyAgentEvent(t, noInv2);
    const streams = useChatStore.getState().streamingByThread[t];
    expect(streams).toHaveLength(1);
    expect(streams[0].key).toBe('claude-opus:default');
    expect(streams[0].text).toBe('无 invocationId 的帧。继续。');
  });

  it('a text frame with undefined content is folded as empty (no NaN/undefined contamination)', () => {
    const t = 'thread_todo_api';
    const missingContent: AgentMessage = { type: 'text', agentId: CLAUDE, invocationId: 'inv_1', timestamp: 1 };
    useChatStore.getState().applyAgentEvent(t, missingContent);
    useChatStore.getState().applyAgentEvent(t, textFrame(CLAUDE, '真实内容。', 2));
    const stream = useChatStore.getState().streamingByThread[t][0];
    expect(stream.text).toBe('真实内容。');
    expect(stream.text).not.toContain('undefined');
  });

  it('non-streaming frame types (done/error/system_info) never create a buffer', () => {
    const t = 'thread_todo_api';
    useChatStore.getState().applyAgentEvent(t, doneFrame(CLAUDE, 1));
    useChatStore.getState().applyAgentEvent(t, { type: 'error', agentId: CLAUDE, content: 'CLI 崩溃', invocationId: 'inv_1', timestamp: 2 });
    useChatStore.getState().applyAgentEvent(t, { type: 'system_info', agentId: CLAUDE, content: 'invocation created', timestamp: 3 });
    expect(useChatStore.getState().streamingByThread[t]).toBeUndefined();
  });

  it('a delta arriving AFTER done re-creates a fresh buffer (clear then fold), not stale text', () => {
    const t = 'thread_todo_api';
    useChatStore.getState().applyAgentEvent(t, textFrame(CLAUDE, '第一轮输出。', 1));
    useChatStore.getState().clearStreaming(t); // simulate done handler
    expect(useChatStore.getState().streamingByThread[t]).toBeUndefined();

    // Late delta after done → must start from empty, not resurrect prior text.
    useChatStore.getState().applyAgentEvent(t, textFrame(CLAUDE, '迟到的增量。', 5));
    const streams = useChatStore.getState().streamingByThread[t];
    expect(streams).toHaveLength(1);
    expect(streams[0].text).toBe('迟到的增量。');
    expect(streams[0].text).not.toContain('第一轮输出。');
  });

  it('clearStreaming only clears the target thread, leaving other threads streaming', () => {
    useChatStore.getState().applyAgentEvent('thread_a', textFrame(CLAUDE, 'A 流。', 1));
    useChatStore.getState().applyAgentEvent('thread_b', textFrame(CODEX, 'B 流。', 1));

    useChatStore.getState().clearStreaming('thread_a');

    expect(useChatStore.getState().streamingByThread['thread_a']).toBeUndefined();
    expect(useChatStore.getState().streamingByThread['thread_b']).toHaveLength(1);
  });

  it('clearStreaming on a thread with no buffer is a no-op keeping the SAME map reference', () => {
    useChatStore.getState().applyAgentEvent('thread_b', textFrame(CODEX, 'B 流。', 1));
    const beforeMap = useChatStore.getState().streamingByThread;
    useChatStore.getState().clearStreaming('thread_never_streamed');
    expect(useChatStore.getState().streamingByThread).toBe(beforeMap);
  });

  it('tool_use frame with missing toolName falls back to a default label (no undefined render input)', () => {
    const t = 'thread_todo_api';
    const noName: AgentMessage = { type: 'tool_use', agentId: CLAUDE, toolInput: { cmd: 'ls' }, toolUseId: 'tu1', invocationId: 'inv_1', timestamp: 1 };
    useChatStore.getState().applyAgentEvent(t, noName);
    const block = useChatStore.getState().streamingByThread[t][0].toolBlocks[0];
    expect(block.toolName).toBe('tool');
    expect(block.toolInput).toEqual({ cmd: 'ls' });
  });

  it('removeThread on a thread that is NOT active leaves activeThreadId untouched', () => {
    useChatStore.getState().setThreads([makeThread(), makeThread({ id: 'thread_other' })]);
    useChatStore.getState().setActiveThread('thread_todo_api');
    useChatStore.getState().applyAgentEvent('thread_other', textFrame(CLAUDE, '其他线程流。', 1));

    useChatStore.getState().removeThread('thread_other');

    const state = useChatStore.getState();
    expect(state.activeThreadId).toBe('thread_todo_api'); // unchanged
    expect(state.streamingByThread['thread_other']).toBeUndefined();
    expect(state.threads.map((t) => t.id)).toEqual(['thread_todo_api']);
  });
});

describe('agent-store status (edge + adversarial)', () => {
  beforeEach(resetAgents);

  it('applyAgentStatus for an UNROSTERED agent stores the status but selectAgentStatus reads it back', () => {
    useAgentStore.getState().setRoster(ROSTER);
    const ghost = createAgentId('ghost-agent');
    useAgentStore.getState().applyAgentStatus({ id: ghost, status: 'working', lastActiveAt: 99 });
    // It does not pollute rostered agents' statuses.
    expect(selectAgentStatus(useAgentStore.getState(), CLAUDE)).toBe('idle');
    expect(selectAgentStatus(useAgentStore.getState(), ghost)).toBe('working');
  });

  it('selectAgentStatus defaults to offline for an agent never seen', () => {
    useAgentStore.getState().setRoster(ROSTER);
    expect(selectAgentStatus(useAgentStore.getState(), 'never-seen')).toBe('offline');
  });

  it('applyAgentStatus does not mutate the prior statusById map reference', () => {
    useAgentStore.getState().setRoster(ROSTER);
    const before = useAgentStore.getState().statusById;
    useAgentStore.getState().applyAgentStatus(workingStatus(GEMINI, 'thread_todo_api'));
    const after = useAgentStore.getState().statusById;
    expect(after).not.toBe(before);
    expect(before['gemini-pro']).toBe('idle'); // prior snapshot unchanged
    expect(after['gemini-pro']).toBe('working');
  });

  it('setRoster preserves an already-received live status and does not reset it to idle baseline', () => {
    useAgentStore.getState().applyAgentStatus(workingStatus(CODEX, 'thread_todo_api'));
    useAgentStore.getState().setRoster(ROSTER); // roster says idle for codex
    expect(selectAgentStatus(useAgentStore.getState(), CODEX)).toBe('working');
    // But agents with no prior live status seed from roster baseline.
    expect(selectAgentStatus(useAgentStore.getState(), CLAUDE)).toBe('idle');
  });

  it('rapid status churn (working→thinking→error→idle) lands on the last value', () => {
    useAgentStore.getState().setRoster(ROSTER);
    useAgentStore.getState().applyAgentStatus(workingStatus(CLAUDE, 'thread_todo_api'));
    useAgentStore.getState().applyAgentStatus({ id: CLAUDE, status: 'thinking', lastActiveAt: 2 });
    useAgentStore.getState().applyAgentStatus({ id: CLAUDE, status: 'error', lastActiveAt: 3 });
    useAgentStore.getState().applyAgentStatus(idleStatus(CLAUDE, 'thread_todo_api'));
    expect(selectAgentStatus(useAgentStore.getState(), CLAUDE)).toBe('idle');
  });
});
