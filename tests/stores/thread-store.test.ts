import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createAgentId } from '@clowder/shared';
import { SqliteThreadStore } from '@clowder/api/stores/sqlite-thread-store';
import { SqliteMessageStore } from '@clowder/api/stores/sqlite-message-store';
import { SqliteToolEventLog } from '@clowder/api/stores/sqlite-tool-event-log';

/**
 * M5-amend dev happy-path suite (unit). QA owns edge + adversarial coverage.
 * Fresh in-memory database per test for hermetic isolation. A monotonic fake
 * clock makes created/lastActive ordering deterministic for the list assertions.
 */

const CLAUDE = createAgentId('claude-opus');
const CODEX = createAgentId('codex-gpt');

/** Monotonic clock: each call returns a strictly increasing epoch-ms value. */
function makeClock(start = 1_700_000_000_000): () => number {
  let t = start;
  return () => {
    t += 1000;
    return t;
  };
}

describe('SqliteThreadStore (unit, happy path)', () => {
  let db: Database.Database;
  let store: SqliteThreadStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SqliteThreadStore(db, { now: makeClock() });
  });

  it('create then get returns the same thread', async () => {
    const created = await store.create({ title: '数据库选型评审', thinkingMode: 'debug' });

    const fetched = await store.get(created.id);

    expect(created.id).toMatch(/^thread_/);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.title).toBe('数据库选型评审');
    expect(fetched?.thinkingMode).toBe('debug');
    expect(fetched?.participants).toEqual([]);
  });

  it('list applies limit and offset, newest-active first', async () => {
    // Created oldest→newest; each create advances the clock so lastActiveAt rises.
    const first = await store.create({ title: '第一个会话' });
    const second = await store.create({ title: '第二个会话' });
    const third = await store.create({ title: '第三个会话' });

    const all = await store.list();
    expect(all.map((t) => t.id)).toEqual([third.id, second.id, first.id]);

    // limit takes the newest N
    const page1 = await store.list({ limit: 2 });
    expect(page1.map((t) => t.id)).toEqual([third.id, second.id]);

    // offset skips the newest, then returns the rest
    const page2 = await store.list({ limit: 2, offset: 2 });
    expect(page2.map((t) => t.id)).toEqual([first.id]);

    // bare offset (no limit) still skips and returns the tail
    const tail = await store.list({ offset: 1 });
    expect(tail.map((t) => t.id)).toEqual([second.id, first.id]);
  });

  it('updateLastActive bumps the timestamp and re-orders the list', async () => {
    const first = await store.create({ title: '会话 A' });
    const second = await store.create({ title: '会话 B' });

    // Initially B is newest-active.
    expect((await store.list()).map((t) => t.id)).toEqual([second.id, first.id]);

    // Touch A → it becomes the most-recently-active.
    await store.updateLastActive(first.id);

    const reordered = await store.list();
    expect(reordered.map((t) => t.id)).toEqual([first.id, second.id]);
    const fetchedFirst = await store.get(first.id);
    expect(fetchedFirst!.lastActiveAt).toBeGreaterThan(fetchedFirst!.createdAt);
  });

  it('updateSopStage updates the stage', async () => {
    const thread = await store.create({ title: '需求分析会话' });

    await store.updateSopStage(thread.id, 'requirements-gathering');

    const fetched = await store.get(thread.id);
    expect(fetched?.sopStageId).toBe('requirements-gathering');
  });

  it('delete cascades the thread, its messages, and its tool events', async () => {
    const messageStore = new SqliteMessageStore(db);
    const toolEventLog = new SqliteToolEventLog(db);
    const thread = await store.create({ title: '会话待删除' });
    const other = await store.create({ title: '保留的会话' });

    // Seed messages + tool events for BOTH threads to prove the sweep is scoped.
    await messageStore.append({
      threadId: thread.id,
      userId: 'user-makima',
      agentId: null,
      content: '@claude 帮我重构一下路由层',
      mentions: [CLAUDE],
      origin: 'user',
      timestamp: 1_700_000_100_000,
    });
    await toolEventLog.append({
      invocationId: 'inv-del-1',
      threadId: thread.id,
      agentId: CLAUDE,
      toolName: 'read_file',
      toolInput: JSON.stringify({ path: 'src/router.ts' }),
      timestamp: 1_700_000_100_100,
    });
    await messageStore.append({
      threadId: other.id,
      userId: 'user-makima',
      agentId: null,
      content: '@codex 这条要保留',
      mentions: [CODEX],
      origin: 'user',
      timestamp: 1_700_000_100_200,
    });
    await toolEventLog.append({
      invocationId: 'inv-keep-1',
      threadId: other.id,
      agentId: CODEX,
      toolName: 'evidence_search',
      timestamp: 1_700_000_100_300,
    });

    const existed = await store.delete(thread.id);

    expect(existed).toBe(true);
    expect(await store.get(thread.id)).toBeNull();
    expect(await messageStore.getByThread(thread.id)).toHaveLength(0);
    expect(await toolEventLog.readByThread(thread.id)).toHaveLength(0);

    // The other thread's rows are untouched.
    expect(await store.get(other.id)).not.toBeNull();
    expect(await messageStore.getByThread(other.id)).toHaveLength(1);
    expect(await toolEventLog.readByThread(other.id)).toHaveLength(1);
  });

  it('ensureThread auto-creates once then returns the same thread', async () => {
    const threadId = 'thread-from-wechat-room-42';

    const created = await store.ensureThread(threadId, '微信群：架构讨论');
    const again = await store.ensureThread(threadId, '忽略的新标题');

    expect(created.id).toBe(threadId);
    expect(created.title).toBe('微信群：架构讨论');
    // Second call is a no-op create — returns the SAME persisted thread, not a new one.
    expect(again.id).toBe(threadId);
    expect(again.title).toBe('微信群：架构讨论');
    expect(again.createdAt).toBe(created.createdAt);
    expect((await store.list()).filter((t) => t.id === threadId)).toHaveLength(1);
  });
});
