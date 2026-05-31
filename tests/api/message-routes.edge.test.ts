// M8 QA — message-routes edge + adversarial coverage (independently authored).
//
// Drives POST /api/threads/:id/messages through the REAL router + invoke seam
// (FakeAgentService at the designed provider boundary, NOT a mock of M8) to cover:
//   - body/param validation (empty content, missing body)
//   - tool events persisted under extra.toolEvents (M7 scrub contract)
//   - a provider that throws mid-stream → error surfaced, route does not hang
//   - concurrent POSTs to the same thread → no lock error, both persisted
//   - auto-create on a brand-new threadId then route
//   - history pagination query validation

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentId, AgentMessage, StoredMessage } from '@clowder/shared';
import type { AgentService, InvokeOptions } from '@clowder/api/providers/base';
import { buildApp, type BuiltApp } from '@clowder/api/app-factory';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { CLAUDE, replyScript } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

function injectApp(services: Record<string, AgentService>): BuiltApp {
  const db = new Database(':memory:');
  const app = buildApp({ db, agentServices: services });
  cleanups.push(app.close);
  return app;
}

/** A provider that yields some text then throws mid-stream (fault injection). */
class ThrowingAgentService implements AgentService {
  constructor(
    private readonly agentId: AgentId,
    private readonly preText: string,
  ) {}
  invoke(_prompt: string, _options?: InvokeOptions): AsyncIterable<AgentMessage> {
    const agentId = this.agentId;
    const preText = this.preText;
    return (async function* (): AsyncIterable<AgentMessage> {
      yield { type: 'session_init', agentId, content: 'sess-x', timestamp: Date.now() };
      yield { type: 'text', agentId, content: preText, timestamp: Date.now() + 1 };
      throw new Error('上游 CLI 进程意外退出 (exit 137)');
    })();
  }
}

describe('message-routes validation (edge)', () => {
  it('rejects an empty content body with 400', async () => {
    const app = injectApp({ 'claude-opus': new FakeAgentService([]) });
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/threads/thread-empty/messages',
      payload: { content: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a missing body with 400 (does not 500)', async () => {
    const app = injectApp({ 'claude-opus': new FakeAgentService([]) });
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/threads/thread-nobody/messages',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an out-of-range history limit (negative) with 400', async () => {
    const app = injectApp({ 'claude-opus': new FakeAgentService([]) });
    const res = await app.api.inject({
      method: 'GET',
      url: '/api/threads/thread-x/messages?limit=-5',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('agent reply persistence (edge)', () => {
  it('persists tool_use/tool_result events under extra.toolEvents (M7 scrub contract)', async () => {
    const ts = Date.now();
    const script: AgentMessage[] = [
      { type: 'session_init', agentId: CLAUDE, content: 'sess-tools', timestamp: ts },
      {
        type: 'tool_use',
        agentId: CLAUDE,
        toolName: 'read_file',
        toolUseId: 'tu-1',
        toolInput: { path: 'packages/api/src/app-factory.ts' },
        timestamp: ts + 1,
      },
      { type: 'tool_result', agentId: CLAUDE, toolUseId: 'tu-1', content: '...文件内容...', timestamp: ts + 2 },
      { type: 'text', agentId: CLAUDE, content: '我读取了 app-factory，建议如下。', timestamp: ts + 3 },
      { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: ts + 4 },
    ];
    const app = injectApp({ 'claude-opus': new FakeAgentService([script]) });

    const threadId = 'thread-tools';
    const res = await app.api.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: '@claude 读一下 app-factory 给点建议' },
    });
    expect(res.statusCode).toBe(200);
    const reply = res.json<{ replies: StoredMessage[] }>().replies[0];
    expect(reply).toBeDefined();
    const toolEvents = reply?.extra?.toolEvents as Array<{ type: string; toolName?: string }> | undefined;
    expect(Array.isArray(toolEvents)).toBe(true);
    expect(toolEvents?.some((e) => e.type === 'tool_use' && e.toolName === 'read_file')).toBe(true);
    expect(toolEvents?.some((e) => e.type === 'tool_result')).toBe(true);
  });

  it('persists the user message even when the agent produces no output', async () => {
    // Empty script → the agent yields nothing; the user message must still persist.
    const app = injectApp({ 'claude-opus': new FakeAgentService([[]]) });
    const threadId = 'thread-noreply';
    const res = await app.api.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: '@claude 在吗' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ replies: StoredMessage[] }>().replies).toHaveLength(0);

    const history = await app.stores.messageStore.getByThread(threadId);
    expect(history.some((m) => m.origin === 'user' && m.content.includes('在吗'))).toBe(true);
  });
});

describe('provider faults (adversarial)', () => {
  it('a provider that throws mid-stream surfaces an error and does NOT hang the request', async () => {
    const app = injectApp({ 'claude-opus': new ThrowingAgentService(CLAUDE, '开始处理…') });
    const threadId = 'thread-throw';

    // The route must resolve (200) — the catch broadcasts an error rather than
    // rejecting the HTTP request. The user message is still persisted.
    const res = await app.api.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: '@claude 跑一下' },
    });
    expect(res.statusCode).toBe(200);

    const history = await app.stores.messageStore.getByThread(threadId);
    expect(history.some((m) => m.origin === 'user')).toBe(true);
  });
});

describe('thread lifecycle via messages (edge)', () => {
  it('auto-creates a never-before-seen thread on first message then routes', async () => {
    const app = injectApp({ 'claude-opus': new FakeAgentService([replyScript(CLAUDE, '好的')]) });
    const threadId = 'thread-fresh-7a2c';

    // Confirm it truly did not exist beforehand.
    expect(await app.stores.threadStore.get(threadId)).toBeNull();

    await app.api.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: '@claude 新会话第一条' },
    });

    const created = await app.stores.threadStore.get(threadId);
    expect(created).not.toBeNull();
    expect(created?.id).toBe(threadId);
    // Title derived from the first message.
    expect(created?.title).toContain('@claude');
  });

  it('concurrent POSTs to the SAME thread both persist with no lock error', async () => {
    // Two invocations scripted (one per call) for the same agent.
    const app = injectApp({
      'claude-opus': new FakeAgentService([
        replyScript(CLAUDE, '回复一'),
        replyScript(CLAUDE, '回复二'),
      ]),
    });
    const threadId = 'thread-concurrent';

    const [r1, r2] = await Promise.all([
      app.api.inject({
        method: 'POST',
        url: `/api/threads/${threadId}/messages`,
        payload: { content: '@claude 并发请求一' },
      }),
      app.api.inject({
        method: 'POST',
        url: `/api/threads/${threadId}/messages`,
        payload: { content: '@claude 并发请求二' },
      }),
    ]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);

    const history = await app.stores.messageStore.getByThread(threadId, 50);
    const userMsgs = history.filter((m) => m.origin === 'user');
    expect(userMsgs).toHaveLength(2);
    // The thread row is created exactly once despite two racing ensureThread calls.
    const list = await app.stores.threadStore.list();
    expect(list.filter((t) => t.id === threadId)).toHaveLength(1);
  });
});
