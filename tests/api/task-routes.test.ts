// task-routes — /api/tasks CRUD + socket broadcast, the operable 任务线 backend.
//
// 对齐 Clowder reference/.../routes/tasks.ts (POST/GET/PATCH/DELETE) — choco port
// persists to SQLite (SqliteTaskStore) instead of Clowder's in-memory Map, and
// drops the #320 pr_tracking machinery (YAGNI — that's the community/automation
// feature, not the work-task lines this tab shows).
//
// SYMPTOM this nails: 任务 tab was an honest placeholder with NO backend —
// POST /api/tasks 404'd. RED (pre-impl): 404 / route不存在. GREEN: full CRUD +
// the create/update broadcast a task_created/task_updated into the thread room
// so live web clients sync without a reload.

import Database from 'better-sqlite3';
import { describe, it, expect, afterEach } from 'vitest';
import type { TaskItem } from '@choco/shared';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { startTestApp, connectClient, type TestApp } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function makeApp(): BuiltApp {
  const db = new Database(':memory:');
  const app = buildApp({ db });
  cleanups.push(app.close);
  return app;
}

const THREAD = 'thread_tasks_1';

async function post(
  app: BuiltApp,
  body: Record<string, unknown>,
): Promise<{ status: number; task: TaskItem }> {
  const res = await app.api.inject({ method: 'POST', url: '/api/tasks', payload: body });
  return { status: res.statusCode, task: res.statusCode < 300 ? res.json<TaskItem>() : ({} as TaskItem) };
}

async function list(app: BuiltApp, threadId: string): Promise<TaskItem[]> {
  const res = await app.api.inject({ method: 'GET', url: `/api/tasks?threadId=${threadId}` });
  return res.json<{ tasks: TaskItem[] }>().tasks;
}

describe('/api/tasks — task-line CRUD (happy)', () => {
  it('POST creates a todo task echoing title/why/thread/createdBy', async () => {
    const app = makeApp();
    const { status, task } = await post(app, {
      threadId: THREAD,
      title: '把审计子视图对齐到 Clowder',
      why: '当前是占位，用户要可操作的真后端',
      createdBy: 'user',
    });
    expect(status).toBe(201);
    expect(task).toMatchObject({
      threadId: THREAD,
      title: '把审计子视图对齐到 Clowder',
      why: '当前是占位，用户要可操作的真后端',
      createdBy: 'user',
      status: 'todo',
    });
    expect(typeof task.id).toBe('string');
    expect(typeof task.createdAt).toBe('number');
  });

  it('GET ?threadId lists the thread tasks (and isolates other threads)', async () => {
    const app = makeApp();
    await post(app, { threadId: THREAD, title: '任务A', why: '', createdBy: 'user' });
    await post(app, { threadId: 'other_thread', title: '别的线程的任务', why: '', createdBy: 'user' });

    const here = await list(app, THREAD);
    expect(here.map((t) => t.title)).toEqual(['任务A']);
  });

  it('PATCH :id moves status todo→doing and bumps updatedAt', async () => {
    const app = makeApp();
    const { task } = await post(app, { threadId: THREAD, title: '修 gemini 串台', why: '', createdBy: 'user' });

    const res = await app.api.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { status: 'doing' },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json<TaskItem>();
    expect(updated.status).toBe('doing');
    expect(updated.updatedAt).toBeGreaterThanOrEqual(task.updatedAt);
  });

  it('DELETE :id removes the task (204) so the list shrinks', async () => {
    const app = makeApp();
    const { task } = await post(app, { threadId: THREAD, title: '临时任务', why: '', createdBy: 'user' });
    expect((await list(app, THREAD)).length).toBe(1);

    const res = await app.api.inject({ method: 'DELETE', url: `/api/tasks/${task.id}` });
    expect(res.statusCode).toBe(204);
    expect((await list(app, THREAD)).length).toBe(0);
  });
});

describe('/api/tasks — edge / adversarial', () => {
  it('[edge] GET without threadId is a 400, not a silent empty list', async () => {
    const app = makeApp();
    const res = await app.api.inject({ method: 'GET', url: '/api/tasks' });
    expect(res.statusCode).toBe(400);
  });

  it('[edge] PATCH a missing task is a 404', async () => {
    const app = makeApp();
    const res = await app.api.inject({
      method: 'PATCH',
      url: '/api/tasks/task_does_not_exist',
      payload: { status: 'done' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('[edge] POST with an empty title is rejected 400 (validation at the boundary)', async () => {
    const app = makeApp();
    const { status } = await post(app, { threadId: THREAD, title: '', why: '', createdBy: 'user' });
    expect(status).toBe(400);
  });

  it('[adversarial] deleting a thread cascades its task lines away', async () => {
    const app = makeApp();
    await app.stores.threadStore.ensureThread(THREAD, '带任务的线程');
    await post(app, { threadId: THREAD, title: '会被级联删的任务', why: '', createdBy: 'user' });
    expect((await list(app, THREAD)).length).toBe(1);

    await app.api.inject({ method: 'DELETE', url: `/api/threads/${THREAD}` });
    expect((await list(app, THREAD)).length).toBe(0);
  });
});

describe('/api/tasks — real-time socket sync', () => {
  it('creating a task broadcasts task_created into the thread room', async () => {
    const test: TestApp = await startTestApp({});
    cleanups.push(test.close);
    const client = await connectClient(test.baseUrl, THREAD);
    cleanups.push(async () => {
      client.disconnect();
    });

    const received = new Promise<TaskItem>((resolve) => {
      client.on('task_created', (t: TaskItem) => resolve(t));
    });

    await post(test.app, { threadId: THREAD, title: '广播给网页端的任务', why: '', createdBy: 'user' });

    const broadcast = await received;
    expect(broadcast.title).toBe('广播给网页端的任务');
    expect(broadcast.threadId).toBe(THREAD);
  });
});
