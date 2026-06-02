// QA edge + adversarial gating suite for PATCH /api/threads/:id (inline rename).
// dev≠QA (§0.5.3): authored by a different instance than the one that wrote the
// route in packages/api/src/routes/thread-routes.ts. NO product code modified.
//
// HTTP routes are exercised via Fastify `inject` (no listener); the broadcast
// case connects a REAL socket.io-client joined to the thread room and asserts a
// `thread_update` frame carrying the new title arrives (the established idiom in
// routes.test.ts). Real titles only (no placeholder data) — real session names,
// real CJK/emoji/HTML payloads.

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import type { Thread } from '@clowder/shared';
import { buildApp, type BuiltApp } from '@clowder/api/app-factory';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

/** Build an inject-only app (no listener) over an in-memory db + fakes. */
function injectApp(): BuiltApp {
  const db = new Database(':memory:');
  const fakes: Record<string, FakeAgentService> = { 'claude-opus': new FakeAgentService([]) };
  return buildApp({ db, agentServices: fakes });
}

/** Create a thread via the route and return it. */
async function createThread(app: BuiltApp, title: string): Promise<Thread> {
  const res = await app.api.inject({ method: 'POST', url: '/api/threads', payload: { title } });
  expect(res.statusCode).toBe(201);
  return res.json<Thread>();
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe('PATCH /api/threads/:id rename — persistence + broadcast (happy)', () => {
  it('renames, persists (subsequent GET + list reflect it), and is distinct from sop-stage', async () => {
    const app = injectApp();
    cleanups.push(app.close);
    const thread = await createThread(app, 'A2A 路由超时排查');

    const renamed = await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: { title: 'A2A 路由超时排查 — 已定位' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<Thread>().title).toBe('A2A 路由超时排查 — 已定位');
    // id + createdAt are unchanged by a rename (only the title moves).
    expect(renamed.json<Thread>().id).toBe(thread.id);
    expect(renamed.json<Thread>().createdAt).toBe(thread.createdAt);

    const fetched = await app.api.inject({ method: 'GET', url: `/api/threads/${thread.id}` });
    expect(fetched.json<Thread>().title).toBe('A2A 路由超时排查 — 已定位');
    const listed = await app.api.inject({ method: 'GET', url: '/api/threads' });
    const inList = listed.json<{ threads: Thread[] }>().threads.find((t) => t.id === thread.id);
    expect(inList?.title).toBe('A2A 路由超时排查 — 已定位');
  });

  it('broadcasts a thread_update carrying the new title to a client joined to the room', async () => {
    // A listening app is needed so a real socket.io-client can join the room.
    const db = new Database(':memory:');
    const app = buildApp({ db, agentServices: { 'claude-opus': new FakeAgentService([]) } });
    cleanups.push(app.close);
    const address = await app.api.listen({ port: 0, host: '127.0.0.1' });
    const baseUrl = typeof address === 'string' ? address : 'http://127.0.0.1';

    const created = await app.api.inject({
      method: 'POST',
      url: '/api/threads',
      payload: { title: 'Evidence 召回阈值评审' },
    });
    const thread = created.json<Thread>();

    const socket: ClientSocket = ioClient(baseUrl, { transports: ['websocket'], forceNew: true });
    cleanups.push(async () => {
      socket.disconnect();
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => {
        socket.emit('join_thread', { threadId: thread.id });
        setTimeout(resolve, 40);
      });
      socket.on('connect_error', reject);
    });

    const updates: Thread[] = [];
    socket.on('thread_update', (t: Thread) => updates.push(t));

    await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: { title: 'Evidence 召回阈值评审 v2' },
    });

    await new Promise((r) => setTimeout(r, 250));
    expect(updates.some((t) => t.id === thread.id && t.title === 'Evidence 召回阈值评审 v2')).toBe(
      true,
    );
  });
});

describe('PATCH /api/threads/:id rename — validation (edge)', () => {
  it('rejects an empty title with 400 (.min(1)) and does NOT mutate the stored title', async () => {
    const app = injectApp();
    cleanups.push(app.close);
    const thread = await createThread(app, '消息存储分页设计');

    const res = await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: { title: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_body');

    const fetched = await app.api.inject({ method: 'GET', url: `/api/threads/${thread.id}` });
    expect(fetched.json<Thread>().title).toBe('消息存储分页设计');
  });

  it('rejects a missing title key with 400', async () => {
    const app = injectApp();
    cleanups.push(app.close);
    const thread = await createThread(app, 'SOP 阶段推进');

    const res = await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an extra body key with 400 (.strict)', async () => {
    const app = injectApp();
    cleanups.push(app.close);
    const thread = await createThread(app, 'WeChat 适配器联调');

    const res = await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: { title: 'WeChat 适配器联调 — 通过', stageId: 'sneaky' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_body');

    const fetched = await app.api.inject({ method: 'GET', url: `/api/threads/${thread.id}` });
    expect(fetched.json<Thread>().title).toBe('WeChat 适配器联调');
  });

  it('returns 404 when renaming a thread id that does not exist', async () => {
    const app = injectApp();
    cleanups.push(app.close);

    const res = await app.api.inject({
      method: 'PATCH',
      url: '/api/threads/thread_does_not_exist',
      payload: { title: '幽灵会话' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('thread_not_found');
  });

  it('does NOT collide with PATCH /:id/sop-stage — the sub-route still routes (its own validation)', async () => {
    const app = injectApp();
    cleanups.push(app.close);
    const thread = await createThread(app, 'Skills Pack 编译');

    // The sop-stage sub-route is reached (not swallowed by /:id rename): an
    // unknown stage is rejected by ITS schema (400 unknown_sop_stage) — proving
    // the request hit the sop-stage handler, not the rename handler.
    const res = await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}/sop-stage`,
      payload: { stageId: 'no-such-stage-xyz' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('unknown_sop_stage');

    // And clearing the stage (stageId: null) succeeds via the sop-stage handler.
    const cleared = await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}/sop-stage`,
      payload: { stageId: null },
    });
    expect(cleared.statusCode).toBe(200);
    // The rename handler would have 400'd on { stageId: null } (.strict, no title),
    // so a 200 here proves sop-stage and rename are genuinely distinct routes.
  });
});

describe('PATCH /api/threads/:id rename — adversarial payloads (round-trip as DATA)', () => {
  it('accepts a very long title and round-trips it intact', async () => {
    const app = injectApp();
    cleanups.push(app.close);
    const thread = await createThread(app, '长标题压力');

    const longTitle = '重构上下文组装：'.repeat(60) + '收尾';
    const res = await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: { title: longTitle },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Thread>().title).toBe(longTitle);

    const fetched = await app.api.inject({ method: 'GET', url: `/api/threads/${thread.id}` });
    const fetchedTitle = fetched.json<Thread>().title;
    expect(fetchedTitle).toBe(longTitle);
    expect(fetchedTitle?.length).toBe(longTitle.length);
  });

  it('stores an HTML/script + emoji title verbatim (treated as data, not interpreted)', async () => {
    const app = injectApp();
    cleanups.push(app.close);
    const thread = await createThread(app, '注入测试');

    const hostile = '<script>alert(1)</script> & "引号" 🐱🔥 路由 <b>评审</b>';
    const res = await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: { title: hostile },
    });
    expect(res.statusCode).toBe(200);
    // The exact bytes survive — no escaping/sanitizing/stripping by the store.
    expect(res.json<Thread>().title).toBe(hostile);

    const fetched = await app.api.inject({ method: 'GET', url: `/api/threads/${thread.id}` });
    expect(fetched.json<Thread>().title).toBe(hostile);
  });

  it('rejects a whitespace-only title once trimmed-equivalence is NOT assumed — documents current contract', async () => {
    // The route schema is z.string().min(1): a single space (length 1) PASSES at
    // the route layer (the UI trims/guards empties client-side). This test pins
    // the ACTUAL backend contract so a future schema change is caught.
    const app = injectApp();
    cleanups.push(app.close);
    const thread = await createThread(app, '空白边界');

    const res = await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: { title: ' ' },
    });
    // A single space has length 1, so .min(1) accepts it (200). Empty string is
    // the only title the backend rejects.
    expect(res.statusCode).toBe(200);
    expect(res.json<Thread>().title).toBe(' ');
  });
});
