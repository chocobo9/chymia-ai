// M8 dev happy-path suite. QA owns edge + adversarial coverage.
//
// HTTP routes are exercised via Fastify `inject` (no listener); the socket
// broadcast + room-isolation cases use a real socket.io-client against a
// listening buildApp. Real inputs only (real @mention format, real agent ids).

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentMessage, Thread, StoredMessage } from '@clowder/shared';
import { buildApp, type BuiltApp } from '@clowder/api/app-factory';
import {
  startTestApp,
  connectClient,
  collectAgentEvents,
  replyScript,
  CLAUDE,
} from './helpers.js';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

/** Build an inject-only app (no listener) over an in-memory db + fakes. */
function injectApp(scripts: Record<string, readonly (readonly AgentMessage[])[]>): BuiltApp {
  const db = new Database(':memory:');
  const fakes: Record<string, FakeAgentService> = {};
  for (const [id, agentScripts] of Object.entries(scripts)) {
    fakes[id] = new FakeAgentService(agentScripts);
  }
  return buildApp({ db, agentServices: fakes });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe('thread routes (happy path)', () => {
  it('creates, lists, fetches, and deletes a thread', async () => {
    const app = injectApp({ 'claude-opus': [] });
    cleanups.push(app.close);

    const created = await app.api.inject({
      method: 'POST',
      url: '/api/threads',
      payload: { title: '数据库选型评审' },
    });
    expect(created.statusCode).toBe(201);
    const thread = created.json<Thread>();
    expect(thread.id).toBeTruthy();
    expect(thread.title).toBe('数据库选型评审');

    const listed = await app.api.inject({ method: 'GET', url: '/api/threads' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ threads: Thread[] }>().threads).toHaveLength(1);

    const fetched = await app.api.inject({ method: 'GET', url: `/api/threads/${thread.id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json<Thread>().id).toBe(thread.id);

    const deleted = await app.api.inject({ method: 'DELETE', url: `/api/threads/${thread.id}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json<{ deleted: boolean }>().deleted).toBe(true);
  });

  it('PATCH /api/threads/:id renames the thread (persisted, distinct from sop-stage)', async () => {
    const app = injectApp({ 'claude-opus': [] });
    cleanups.push(app.close);

    const created = await app.api.inject({
      method: 'POST',
      url: '/api/threads',
      payload: { title: 'A2A 路由 bug' },
    });
    const thread = created.json<Thread>();

    const renamed = await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: { title: 'A2A 路由 bug 复盘' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<Thread>().title).toBe('A2A 路由 bug 复盘');

    // Persisted: a subsequent GET reflects the new title.
    const fetched = await app.api.inject({ method: 'GET', url: `/api/threads/${thread.id}` });
    expect(fetched.json<Thread>().title).toBe('A2A 路由 bug 复盘');
  });
});

describe('agent routes (happy path)', () => {
  it('GET /api/agents returns the roster with status', async () => {
    const app = injectApp({ 'claude-opus': [] });
    cleanups.push(app.close);

    const res = await app.api.inject({ method: 'GET', url: '/api/agents' });
    expect(res.statusCode).toBe(200);
    const { agents } = res.json<{ agents: Array<{ id: string; status: string; mentionPatterns: string[] }> }>();
    expect(agents.length).toBeGreaterThanOrEqual(3);
    const claude = agents.find((a) => a.id === 'claude-opus');
    expect(claude).toBeDefined();
    expect(claude?.status).toBe('idle');
    expect(claude?.mentionPatterns).toContain('@claude');
  });

  it('GET /api/agents/:id/status returns the agent status', async () => {
    const app = injectApp({ 'claude-opus': [] });
    cleanups.push(app.close);

    const res = await app.api.inject({ method: 'GET', url: '/api/agents/codex-gpt/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ id: string; status: string }>()).toEqual({ id: 'codex-gpt', status: 'idle' });
  });
});

describe('message routes (happy path)', () => {
  it('POST a message persists the user message and the agent reply', async () => {
    const app = injectApp({ 'claude-opus': [replyScript(CLAUDE, '建议用 SQLite + sqlite-vec。')] });
    cleanups.push(app.close);

    const threadId = 'thread-msg-1';
    const res = await app.api.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: '@claude SQLite 够用吗？', userId: 'user-makima' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ userMessage: StoredMessage; replies: StoredMessage[] }>();
    expect(body.userMessage.agentId).toBeNull();
    expect(body.userMessage.mentions).toContain('claude-opus');
    expect(body.replies).toHaveLength(1);
    expect(body.replies[0]?.agentId).toBe('claude-opus');
    expect(body.replies[0]?.content).toContain('SQLite');

    // History reflects both the user message and the persisted reply.
    const history = await app.api.inject({ method: 'GET', url: `/api/threads/${threadId}/messages` });
    expect(history.statusCode).toBe(200);
    expect(history.json<{ messages: StoredMessage[] }>().messages).toHaveLength(2);
  });

  it('auto-creates the thread on first message (ensureThread)', async () => {
    const app = injectApp({ 'claude-opus': [replyScript(CLAUDE, 'ok')] });
    cleanups.push(app.close);

    const threadId = 'thread-autocreate';
    await app.api.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: '@claude 开始吧' },
    });

    const fetched = await app.api.inject({ method: 'GET', url: `/api/threads/${threadId}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json<Thread>().id).toBe(threadId);
  });
});

describe('evidence routes (happy path)', () => {
  it('upserts then finds an evidence item by search', async () => {
    const app = injectApp({ 'claude-opus': [] });
    cleanups.push(app.close);

    const upsert = await app.api.inject({
      method: 'POST',
      url: '/api/evidence',
      payload: {
        anchor: 'decision:2026-05-30-db-framework',
        kind: 'decision',
        status: 'active',
        title: 'API 框架选型：Fastify',
        summary: '决定用 Fastify + Socket.io 作为 API 层。',
        keywords: ['Fastify', 'Socket.io', 'API'],
      },
    });
    expect(upsert.statusCode).toBe(201);

    const search = await app.api.inject({
      method: 'GET',
      url: `/api/evidence/search?q=${encodeURIComponent('Fastify')}`,
    });
    expect(search.statusCode).toBe(200);
    const result = search.json<{ items: Array<{ anchor: string }> }>();
    expect(result.items.some((i) => i.anchor === 'decision:2026-05-30-db-framework')).toBe(true);
  });
});

describe('inject-seam smoke (happy path)', () => {
  it('buildApp({ agentServices: { "claude-opus": fake } }) routes through the fake provider', async () => {
    const fake = new FakeAgentService([replyScript(CLAUDE, '来自 fake provider 的回复')]);
    const db = new Database(':memory:');
    const app = buildApp({ db, agentServices: { 'claude-opus': fake } });
    cleanups.push(app.close);

    await app.api.inject({
      method: 'POST',
      url: '/api/threads/thread-seam/messages',
      payload: { content: '@claude 你好' },
    });

    // The fake recorded exactly one invocation, proving the seam reached it.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.prompt).toContain('你好');
  });
});

describe('socket broadcast (happy path)', () => {
  it('a client joined to the thread receives an agent_event over Socket.io', async () => {
    const testApp = await startTestApp({
      'claude-opus': [replyScript(CLAUDE, '收到，开始分析。')],
    });
    cleanups.push(testApp.close);

    const threadId = 'thread-broadcast';
    const client = await connectClient(testApp.baseUrl, threadId);
    cleanups.push(async () => {
      client.disconnect();
    });

    const received = collectAgentEvents(client);
    await fetch(`${testApp.baseUrl}/api/threads/${threadId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '@claude 分析一下' }),
    });

    const events = await received;
    expect(events.some((e) => e.type === 'text' && e.content?.includes('分析'))).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('room isolation: a client in thread A does NOT receive thread B events', async () => {
    const testApp = await startTestApp({
      'claude-opus': [replyScript(CLAUDE, 'thread-B reply')],
    });
    cleanups.push(testApp.close);

    const clientA = await connectClient(testApp.baseUrl, 'thread-A');
    cleanups.push(async () => {
      clientA.disconnect();
    });

    const receivedByA: AgentMessage[] = [];
    clientA.on('agent_event', (msg: AgentMessage) => receivedByA.push(msg));

    // Drive a message in thread B; clientA is only in thread A.
    await fetch(`${testApp.baseUrl}/api/threads/thread-B/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '@claude B 线程消息' }),
    });

    await new Promise((r) => setTimeout(r, 300));
    expect(receivedByA).toHaveLength(0);
  });
});
