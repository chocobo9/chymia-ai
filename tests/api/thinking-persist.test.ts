// tests/api/thinking-persist.test.ts — dev happy-path for Bug 3b.
//
// The message-handler now accumulates an agent's `thinking` frames and persists
// the concatenated reasoning under `StoredMessage.extra.thinking`, so a completed
// reply can re-show its Think block (the web client reads extra.thinking →
// AgentMessage's thinking). Without this, thinking frames were dropped on
// accumulate() and the persisted reply carried no reasoning.
//
// Driven end-to-end through the SAME pipeline the product uses: a FakeAgentService
// scripts a real turn (session_init → thinking → text → tool_use → done) and we
// POST /messages, then assert the persisted reply's extra carries the reasoning
// (and still carries its toolEvents — the existing persistence is intact).

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentMessage, StoredMessage } from '@clowder/shared';
import { buildApp, type BuiltApp } from '@clowder/api/app-factory';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { CLAUDE } from './helpers.js';

/** Build an inject-only app (no listener) over an in-memory db + fakes. */
function injectApp(scripts: Record<string, readonly (readonly AgentMessage[])[]>): BuiltApp {
  const db = new Database(':memory:');
  const fakes: Record<string, FakeAgentService> = {};
  for (const [id, agentScripts] of Object.entries(scripts)) {
    fakes[id] = new FakeAgentService(agentScripts);
  }
  return buildApp({ db, agentServices: fakes });
}

const REASONING_A = '先确认数据模型：Todo { id, title, done, createdAt }。';
const REASONING_B = '再划分端点：集合用 /todos，单项用 /todos/:id。';
const REPLY_TEXT = '已实现 TODO API 的 CRUD 端点，并补充了 zod 校验。';

/** A real turn: session_init → two thinking deltas → text → tool_use → done. */
function thinkingTurn(): AgentMessage[] {
  const ts = 1_700_000_000_000;
  return [
    { type: 'session_init', agentId: CLAUDE, content: 'sess-claude-thinking', timestamp: ts },
    { type: 'thinking', agentId: CLAUDE, content: REASONING_A, invocationId: 'inv_think_1', timestamp: ts + 1 },
    { type: 'thinking', agentId: CLAUDE, content: REASONING_B, invocationId: 'inv_think_1', timestamp: ts + 2 },
    { type: 'text', agentId: CLAUDE, content: REPLY_TEXT, invocationId: 'inv_think_1', timestamp: ts + 3 },
    {
      type: 'tool_use',
      agentId: CLAUDE,
      toolName: 'write_file',
      toolInput: { path: 'src/todo.ts' },
      toolUseId: 'tu_1',
      invocationId: 'inv_think_1',
      timestamp: ts + 4,
    },
    { type: 'done', agentId: CLAUDE, isFinal: true, invocationId: 'inv_think_1', timestamp: ts + 5 },
  ];
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe('thinking persistence (Bug 3b, happy path)', () => {
  it('persists concatenated thinking under extra.thinking on the reply', async () => {
    const app = injectApp({ 'claude-opus': [thinkingTurn()] });
    cleanups.push(app.close);

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/threads/thread-thinking/messages',
      payload: { content: '@claude 写一个带 CRUD 的 TODO API' },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ userMessage: StoredMessage; replies: StoredMessage[] }>();
    expect(body.replies).toHaveLength(1);
    const reply = body.replies[0];
    expect(reply?.agentId).toBe(CLAUDE);
    // The two thinking deltas are concatenated, in order, under extra.thinking.
    expect(reply?.extra?.['thinking']).toBe(`${REASONING_A}${REASONING_B}`);
    // The existing tool-event persistence is intact (NOT clobbered).
    expect(Array.isArray(reply?.extra?.['toolEvents'])).toBe(true);
  });

  it('the persisted history row also carries extra.thinking', async () => {
    const app = injectApp({ 'claude-opus': [thinkingTurn()] });
    cleanups.push(app.close);

    await app.api.inject({
      method: 'POST',
      url: '/api/threads/thread-thinking-2/messages',
      payload: { content: '@claude 写一个带 CRUD 的 TODO API' },
    });

    const history = await app.stores.messageStore.getByThread('thread-thinking-2');
    const replyMsg = history.find((m) => m.origin === 'stream');
    expect(replyMsg?.content).toBe(REPLY_TEXT);
    expect(replyMsg?.extra?.['thinking']).toBe(`${REASONING_A}${REASONING_B}`);
  });

  it('omits extra entirely when the turn produced no thinking and no tools', async () => {
    const ts = 1_700_000_000_000;
    const plainTurn: AgentMessage[] = [
      { type: 'session_init', agentId: CLAUDE, content: 'sess-plain', timestamp: ts },
      { type: 'text', agentId: CLAUDE, content: REPLY_TEXT, invocationId: 'inv_plain', timestamp: ts + 1 },
      { type: 'done', agentId: CLAUDE, isFinal: true, invocationId: 'inv_plain', timestamp: ts + 2 },
    ];
    const app = injectApp({ 'claude-opus': [plainTurn] });
    cleanups.push(app.close);

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/threads/thread-plain/messages',
      payload: { content: '@claude 简单回个话' },
    });
    const body = res.json<{ replies: StoredMessage[] }>();
    expect(body.replies[0]?.extra).toBeUndefined();
  });
});
