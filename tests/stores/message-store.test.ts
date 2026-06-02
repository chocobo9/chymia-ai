import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createAgentId, type StoredMessage } from '@choco/shared';
import { SqliteMessageStore } from '@choco/api/stores/sqlite-message-store';

/**
 * M5 dev happy-path suite (unit). QA owns edge + adversarial coverage.
 * Each test gets a fresh in-memory database for hermetic isolation.
 */

const CLAUDE = createAgentId('claude-opus');
const CODEX = createAgentId('codex-gpt');
const THREAD = 'thread-arch-review';
const USER = 'user-makima';

function makeUserMessage(
  overrides: Partial<Omit<StoredMessage, 'id'>> = {},
): Omit<StoredMessage, 'id'> {
  return {
    threadId: THREAD,
    userId: USER,
    agentId: null,
    content: '@claude @codex 帮我评审一下数据库选型，SQLite 够用吗？',
    mentions: [CLAUDE, CODEX],
    origin: 'user',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('SqliteMessageStore (unit, happy path)', () => {
  let db: Database.Database;
  let store: SqliteMessageStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SqliteMessageStore(db);
  });

  it('append then getByThread returns the appended message', async () => {
    const input = makeUserMessage();

    const appended = await store.append(input);
    const fromThread = await store.getByThread(THREAD);

    expect(appended.id).toMatch(/^msg_/);
    expect(fromThread).toHaveLength(1);
    expect(fromThread[0]?.content).toBe('@claude @codex 帮我评审一下数据库选型，SQLite 够用吗？');
    expect(fromThread[0]?.mentions).toEqual([CLAUDE, CODEX]);
    expect(fromThread[0]?.agentId).toBeNull();
    expect(fromThread[0]?.origin).toBe('user');
  });

  it('append preserves an agent reply with agentId and stream origin', async () => {
    const reply = await store.append({
      threadId: THREAD,
      userId: 'claude-opus',
      agentId: CLAUDE,
      content: 'SQLite 配合 WAL 模式足以支撑当前并发，FTS5 也能覆盖中文检索需求。',
      mentions: [],
      origin: 'stream',
      timestamp: Date.now(),
      extra: { sessionId: 'sess-abc-123', inputTokens: 420 },
    });

    const fetched = await store.getById(reply.id);

    expect(fetched).not.toBeNull();
    expect(fetched?.agentId).toBe(CLAUDE);
    expect(fetched?.origin).toBe('stream');
    expect(fetched?.extra).toEqual({ sessionId: 'sess-abc-123', inputTokens: 420 });
  });

  it('getById returns the exact matching message', async () => {
    const first = await store.append(makeUserMessage({ content: '第一条消息：项目启动' }));
    const second = await store.append(
      makeUserMessage({
        content: '第二条消息：@claude 写一个 TODO API',
        timestamp: first.timestamp + 1,
      }),
    );

    const byId = await store.getById(second.id);

    expect(byId?.id).toBe(second.id);
    expect(byId?.content).toBe('第二条消息：@claude 写一个 TODO API');
    expect(byId?.id).not.toBe(first.id);
  });

  it('getByThread returns messages in chronological order and respects limit', async () => {
    const base = Date.now();
    for (let i = 0; i < 5; i += 1) {
      await store.append(makeUserMessage({ content: `进度更新 #${i}`, timestamp: base + i }));
    }

    const all = await store.getByThread(THREAD);
    const lastTwo = await store.getByThread(THREAD, 2);

    expect(all).toHaveLength(5);
    expect(all.map((m) => m.content)).toEqual([
      '进度更新 #0',
      '进度更新 #1',
      '进度更新 #2',
      '进度更新 #3',
      '进度更新 #4',
    ]);
    // limit takes the newest 2, returned chronologically
    expect(lastTwo.map((m) => m.content)).toEqual(['进度更新 #3', '进度更新 #4']);
  });

  it('getByThreadBefore paginates older messages relative to a cursor', async () => {
    const base = Date.now();
    const appended: StoredMessage[] = [];
    for (let i = 0; i < 6; i += 1) {
      appended.push(
        await store.append(makeUserMessage({ content: `历史消息 ${i}`, timestamp: base + i })),
      );
    }

    // cursor at index 4 -> older are indices 0..3; newest 2 of those are 2,3
    const cursor = appended[4];
    expect(cursor).toBeDefined();
    const olderPage = await store.getByThreadBefore(THREAD, cursor!.id, 2);

    expect(olderPage.map((m) => m.content)).toEqual(['历史消息 2', '历史消息 3']);
  });

  it('updateExtra updates the extra bag for an existing message', async () => {
    const msg = await store.append(
      makeUserMessage({
        content: '@codex review the migration script',
        extra: { reviewed: false },
      }),
    );

    await store.updateExtra(msg.id, { reviewed: true, reviewer: 'codex-gpt', score: 9 });
    const fetched = await store.getById(msg.id);

    expect(fetched?.extra).toEqual({ reviewed: true, reviewer: 'codex-gpt', score: 9 });
  });
});
