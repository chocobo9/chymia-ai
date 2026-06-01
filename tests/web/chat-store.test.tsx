// @vitest-environment jsdom
//
// M9 chat-store happy-path unit tests: immutable thread/message reducers,
// streaming-delta append from agent_event frames, setActive. QA owns edge +
// adversarial coverage.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../../packages/web/src/stores/chat-store.js';
import {
  CLAUDE,
  CODEX,
  makeThread,
  makeUserMessage,
  makeAgentReply,
  textFrame,
  thinkingFrame,
  toolUseFrame,
} from './fixtures.js';

function resetStore(): void {
  useChatStore.setState({
    threads: [],
    messagesByThread: {},
    streamingByThread: {},
    activeThreadId: null,
  });
}

describe('chat-store reducers (unit, happy path)', () => {
  beforeEach(resetStore);

  it('setThreads then upsertThread does not mutate the prior array', () => {
    // Arrange
    const thread = makeThread();
    useChatStore.getState().setThreads([thread]);
    const before = useChatStore.getState().threads;

    // Act
    const updated = makeThread({ title: 'TODO API — 已完成' });
    useChatStore.getState().upsertThread(updated);

    // Assert
    const after = useChatStore.getState().threads;
    expect(after).not.toBe(before);
    expect(before[0].title).toBe('TODO API 设计与实现');
    expect(after[0].title).toBe('TODO API — 已完成');
    expect(after).toHaveLength(1);
  });

  it('upsertThread prepends a brand-new thread', () => {
    useChatStore.getState().setThreads([makeThread()]);
    const fresh = makeThread({ id: 'thread_evidence_review', title: 'Evidence 召回评审' });
    useChatStore.getState().upsertThread(fresh);

    const threads = useChatStore.getState().threads;
    expect(threads).toHaveLength(2);
    expect(threads[0].id).toBe('thread_evidence_review');
  });

  it('setActiveThread updates the active id immutably', () => {
    useChatStore.getState().setActiveThread('thread_todo_api');
    expect(useChatStore.getState().activeThreadId).toBe('thread_todo_api');
  });

  it('addMessage appends without mutating the prior message array', () => {
    const user = makeUserMessage();
    useChatStore.getState().setMessages('thread_todo_api', [user]);
    const before = useChatStore.getState().messagesByThread['thread_todo_api'];

    useChatStore.getState().addMessage(makeAgentReply());
    const after = useChatStore.getState().messagesByThread['thread_todo_api'];

    expect(after).not.toBe(before);
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(2);
    expect(after[1].agentId).toBe(CLAUDE);
  });

  it('addMessage is idempotent on duplicate id', () => {
    const reply = makeAgentReply();
    useChatStore.getState().addMessage(reply);
    useChatStore.getState().addMessage(reply);
    expect(useChatStore.getState().messagesByThread['thread_todo_api']).toHaveLength(1);
  });

  it('reconcileReplies merges POST result replies, skipping ones already present', () => {
    const reply = makeAgentReply();
    useChatStore.getState().addMessage(reply);
    useChatStore
      .getState()
      .reconcileReplies([
        reply,
        makeAgentReply({ id: 'msg_agent_2', agentId: CODEX, content: 'Codex: 我补了集成测试。' }),
      ]);
    const msgs = useChatStore.getState().messagesByThread['thread_todo_api'];
    expect(msgs).toHaveLength(2);
    expect(msgs[1].agentId).toBe(CODEX);
  });

  it('addOptimisticUserMessage inserts a user bubble immediately and returns its temp id', () => {
    const threadId = 'thread_todo_api';
    const tempId = useChatStore
      .getState()
      .addOptimisticUserMessage(threadId, '@claude 写一个带 CRUD 的 TODO API', 1_700_000_000_000);

    expect(tempId.startsWith('optimistic-')).toBe(true);
    const msgs = useChatStore.getState().messagesByThread[threadId];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe(tempId);
    expect(msgs[0].agentId).toBeNull();
    expect(msgs[0].origin).toBe('user');
    expect(msgs[0].content).toBe('@claude 写一个带 CRUD 的 TODO API');
  });

  it('replaceOptimisticMessage swaps the temp message for the persisted one without duplicating', () => {
    const threadId = 'thread_todo_api';
    const tempId = useChatStore
      .getState()
      .addOptimisticUserMessage(threadId, '@claude 写一个带 CRUD 的 TODO API', 1_700_000_000_000);
    const real = makeUserMessage();

    useChatStore.getState().replaceOptimisticMessage(threadId, tempId, real);

    const msgs = useChatStore.getState().messagesByThread[threadId];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe('msg_user_1');
    expect(msgs.some((m) => m.id === tempId)).toBe(false);
  });

  it('removeMessage drops a failed optimistic message (error path)', () => {
    const threadId = 'thread_todo_api';
    const tempId = useChatStore
      .getState()
      .addOptimisticUserMessage(threadId, '@claude 写代码', 1_700_000_000_000);

    useChatStore.getState().removeMessage(threadId, tempId);

    expect(useChatStore.getState().messagesByThread[threadId]).toHaveLength(0);
  });

  it('applyAgentEvent folds text deltas into one growing streaming message', () => {
    const threadId = 'thread_todo_api';
    useChatStore.getState().applyAgentEvent(threadId, textFrame(CLAUDE, '我先', 1));
    useChatStore.getState().applyAgentEvent(threadId, textFrame(CLAUDE, '设计数据模型，', 2));
    useChatStore.getState().applyAgentEvent(threadId, textFrame(CLAUDE, '再写路由。', 3));

    const streams = useChatStore.getState().streamingByThread[threadId];
    expect(streams).toHaveLength(1);
    expect(streams[0].text).toBe('我先设计数据模型，再写路由。');
    expect(streams[0].agentId).toBe(CLAUDE);
  });

  it('applyAgentEvent accumulates thinking and tool_use blocks', () => {
    const threadId = 'thread_todo_api';
    useChatStore.getState().applyAgentEvent(threadId, thinkingFrame(CLAUDE, '需要 CRUD 五个端点。', 1));
    useChatStore
      .getState()
      .applyAgentEvent(threadId, toolUseFrame(CLAUDE, 'write_file', { path: 'src/todo.ts' }, 2));
    useChatStore.getState().applyAgentEvent(threadId, textFrame(CLAUDE, '完成。', 3));

    const stream = useChatStore.getState().streamingByThread[threadId][0];
    expect(stream.thinking).toBe('需要 CRUD 五个端点。');
    expect(stream.toolBlocks).toHaveLength(1);
    expect(stream.toolBlocks[0].toolName).toBe('write_file');
    expect(stream.toolBlocks[0].toolInput).toEqual({ path: 'src/todo.ts' });
    expect(stream.text).toBe('完成。');
  });

  it('keeps parallel agents in separate streaming buffers', () => {
    const threadId = 'thread_ideate';
    useChatStore.getState().applyAgentEvent(threadId, {
      type: 'text',
      agentId: CLAUDE,
      content: 'Claude 的方案。',
      invocationId: 'inv_claude',
      timestamp: 1,
    });
    useChatStore.getState().applyAgentEvent(threadId, {
      type: 'text',
      agentId: CODEX,
      content: 'Codex 的方案。',
      invocationId: 'inv_codex',
      timestamp: 2,
    });

    const streams = useChatStore.getState().streamingByThread[threadId];
    expect(streams).toHaveLength(2);
    expect(streams.map((s) => s.text)).toContain('Claude 的方案。');
    expect(streams.map((s) => s.text)).toContain('Codex 的方案。');
  });

  it('clearStreaming removes the live buffer for a thread on done', () => {
    const threadId = 'thread_todo_api';
    useChatStore.getState().applyAgentEvent(threadId, textFrame(CLAUDE, '流式中…', 1));
    expect(useChatStore.getState().streamingByThread[threadId]).toHaveLength(1);

    useChatStore.getState().clearStreaming(threadId);
    expect(useChatStore.getState().streamingByThread[threadId]).toBeUndefined();
  });

  it('removeThread drops the thread, its messages, and clears active', () => {
    const thread = makeThread();
    useChatStore.getState().setThreads([thread]);
    useChatStore.getState().setMessages(thread.id, [makeUserMessage()]);
    useChatStore.getState().setActiveThread(thread.id);

    useChatStore.getState().removeThread(thread.id);
    const state = useChatStore.getState();
    expect(state.threads).toHaveLength(0);
    expect(state.messagesByThread[thread.id]).toBeUndefined();
    expect(state.activeThreadId).toBeNull();
  });
});
