// SqliteTaskStore — the persistent task-line store. Hermetic: each test gets a
// fresh in-memory db and an injected clock for deterministic timestamps.
//
// 对齐 Clowder reference/.../stores/ports/TaskStore.ts (the in-memory TaskStore's
// create/get/update/listByThread/delete/deleteByThread contract), persisted to
// SQLite instead of an in-memory Map.

import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { createAgentId } from '@choco/shared';
import { SqliteTaskStore } from '@choco/api/stores/sqlite-task-store';

function makeStore(start = 1_700_000_000_000): { store: SqliteTaskStore; tick: () => void } {
  let clock = start;
  const store = new SqliteTaskStore(new Database(':memory:'), { now: () => clock });
  return { store, tick: () => (clock += 1000) };
}

describe('SqliteTaskStore', () => {
  it('create() stamps a todo task with createdAt === updatedAt and an owner', async () => {
    const { store } = makeStore();
    const owner = createAgentId('claude-opus');
    const task = await store.create({
      threadId: 'thread_1',
      title: '对齐 workspace 任务 tab',
      why: '占位要变可操作',
      createdBy: 'user',
      ownerCatId: owner,
    });
    expect(task.status).toBe('todo');
    expect(task.threadId).toBe('thread_1');
    expect(task.ownerCatId).toBe(owner);
    expect(task.createdBy).toBe('user');
    expect(task.createdAt).toBe(task.updatedAt);
    expect(await store.get(task.id)).toEqual(task);
  });

  it('update() changes only the given fields and bumps updatedAt', async () => {
    const { store, tick } = makeStore();
    const task = await store.create({ threadId: 't', title: '原标题', why: '原因', createdBy: 'user' });
    tick();
    const updated = await store.update(task.id, { status: 'doing' });
    expect(updated).not.toBeNull();
    expect(updated?.status).toBe('doing');
    expect(updated?.title).toBe('原标题'); // untouched
    expect(updated?.updatedAt).toBeGreaterThan(task.updatedAt);
    expect(updated?.createdAt).toBe(task.createdAt); // immutable
  });

  it('update() on a missing task returns null', async () => {
    const { store } = makeStore();
    expect(await store.update('nope', { status: 'done' })).toBeNull();
  });

  it('listByThread() returns only that thread, oldest-first', async () => {
    const { store, tick } = makeStore();
    const a = await store.create({ threadId: 'A', title: '第一个', why: '', createdBy: 'user' });
    tick();
    const b = await store.create({ threadId: 'A', title: '第二个', why: '', createdBy: 'user' });
    await store.create({ threadId: 'B', title: '别的线程', why: '', createdBy: 'user' });

    const listA = await store.listByThread('A');
    expect(listA.map((t) => t.id)).toEqual([a.id, b.id]);
    expect((await store.listByThread('B')).map((t) => t.title)).toEqual(['别的线程']);
  });

  it('delete() removes one task; deleteByThread() removes all in a thread', async () => {
    const { store } = makeStore();
    const a = await store.create({ threadId: 'T', title: 'a', why: '', createdBy: 'user' });
    await store.create({ threadId: 'T', title: 'b', why: '', createdBy: 'user' });

    expect(await store.delete(a.id)).toBe(true);
    expect(await store.delete(a.id)).toBe(false); // already gone
    expect((await store.listByThread('T')).length).toBe(1);

    expect(await store.deleteByThread('T')).toBe(1);
    expect((await store.listByThread('T')).length).toBe(0);
  });
});
