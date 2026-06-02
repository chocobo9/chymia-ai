import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createAgentId, type AgentId, type StoredMessage } from '@choco/shared';
import { SqliteMessageStore } from '@choco/api/stores/sqlite-message-store';

/**
 * M5 QA edge + adversarial suite (independent of the dev's happy-path file).
 *
 * Authored by the M5 QA subagent (CLAUDE.md §0.5.3: gating edge/adversarial tests
 * MUST be written by an agent that did not write the product code). This file is the
 * machine gate for getByThread / getByThreadBefore pagination boundaries, the
 * concurrency-burst requirement (PROJECT_SPEC §M5: "并发 append 100 条无 lock error"),
 * JSON round-trip fidelity for CJK + emoji + nested extra, the branded-AgentId
 * round-trip, the documented limit clamp, getById/updateExtra misses, and origin defaults.
 *
 * Each test constructs a fresh `new Database(':memory:')` and runs the migration via the
 * store constructor, so every case is hermetic with no shared state.
 *
 * Real content only (CLAUDE.md §2.2): real branded agent ids, real @mention text, real
 * Chinese + English message bodies drawn from this project's domain (architecture review,
 * SOP gates, evidence recall) — no "hello"/"test123"/"foo" placeholders.
 */

const CLAUDE: AgentId = createAgentId('claude-opus');
const CODEX: AgentId = createAgentId('codex-gpt');
const GEMINI: AgentId = createAgentId('gemini-pro');

const THREAD = 'thread-arch-review-001';
const OTHER_THREAD = 'thread-evidence-store-002';
const USER = 'user-makima';

/** Documented clamp target: SqliteMessageStore DEFAULT_THREAD_LIMIT (50). */
const DEFAULT_THREAD_LIMIT = 50;

function freshStore(): { db: Database.Database; store: SqliteMessageStore } {
  const db = new Database(':memory:');
  const store = new SqliteMessageStore(db);
  return { db, store };
}

function makeMessage(
  overrides: Partial<Omit<StoredMessage, 'id'>> = {},
): Omit<StoredMessage, 'id'> {
  return {
    threadId: THREAD,
    userId: USER,
    agentId: null,
    content: '@claude 帮我把 evidence store 的 FTS5 schema 设计出来。',
    mentions: [CLAUDE],
    origin: 'user',
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Realistic, distinct conversation bodies (mixed zh/en) so a 100-message burst
 * carries genuine content rather than an index repeated 100 times.
 */
const BURST_BODIES: readonly string[] = [
  '@claude 我们先确定 messages 表的主键策略，UUID 还是时间排序 id？',
  'I lean towards a time-sortable id so getByThread tail scans stay cheap.',
  '@codex 那分页游标怎么处理时间戳相同的情况？',
  'Use a (timestamp, id) composite cursor — id breaks ties deterministically.',
  '同意，WAL 模式下 better-sqlite3 是同步写，不会有 SQLITE_BUSY。',
  '@gemini 评估一下 100 条并发 append 的吞吐，够不够撑住一次 burst？',
  'better-sqlite3 单连接顺序执行，100 条插入是毫秒级的，没问题。',
  '把 mentions 存成 JSON 数组，读回来用 createAgentId 重新打标。',
  'extra 字段放 tracing 元数据：sessionId、inputTokens、retryCount。',
  '@claude 注意 content 里可能有 emoji 🚀 和 CJK，序列化要无损。',
];

function burstBody(index: number): string {
  const base = BURST_BODIES[index % BURST_BODIES.length] ?? BURST_BODIES[0]!;
  return `[#${index}] ${base}`;
}

describe('SqliteMessageStore — adversarial: 100-message concurrency burst (PROJECT_SPEC §M5)', () => {
  let store: SqliteMessageStore;

  beforeEach(() => {
    ({ store } = freshStore());
  });

  it('appends 100 messages to one thread with no lock error and retrieves all in order', async () => {
    const base = Date.now();
    const BURST_SIZE = 100;

    // Fire all appends "concurrently": better-sqlite3 is synchronous, so this proves the
    // WAL + single-writer setup serializes correctly without "database is locked"/SQLITE_BUSY.
    const writes: Promise<StoredMessage>[] = [];
    for (let i = 0; i < BURST_SIZE; i += 1) {
      writes.push(
        store.append(makeMessage({ content: burstBody(i), timestamp: base + i })),
      );
    }

    let appended: StoredMessage[] = [];
    let caught: unknown = null;
    try {
      appended = await Promise.all(writes);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeNull();
    expect(appended).toHaveLength(BURST_SIZE);

    // All 100 must be retrievable (override the default 50-row cap with an explicit limit).
    const all = await store.getByThread(THREAD, BURST_SIZE);
    expect(all).toHaveLength(BURST_SIZE);

    // Chronological order, and every distinct body present (no drops/dupes).
    const expectedOrder = Array.from({ length: BURST_SIZE }, (_, i) => burstBody(i));
    expect(all.map((m) => m.content)).toEqual(expectedOrder);

    const ids = new Set(all.map((m) => m.id));
    expect(ids.size).toBe(BURST_SIZE);
  });

  it('does not surface a "database is locked"/SQLITE_BUSY error string under burst', async () => {
    const base = Date.now();
    let errorMessage = '';
    try {
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          store.append(makeMessage({ content: burstBody(i), timestamp: base + i })),
        ),
      );
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }
    expect(errorMessage).not.toMatch(/database is locked|SQLITE_BUSY/i);
    expect(errorMessage).toBe('');
  });
});

describe('SqliteMessageStore — edge: getByThread limit clamp (documented behavior)', () => {
  let store: SqliteMessageStore;

  beforeEach(async () => {
    ({ store } = freshStore());
    const base = Date.now();
    // Seed 60 rows so a clamp-to-50 is observable (60 > default 50).
    for (let i = 0; i < 60; i += 1) {
      await store.append(makeMessage({ content: burstBody(i), timestamp: base + i }));
    }
  });

  it('clamps limit = 0 to the default page size (returns newest 50)', async () => {
    const rows = await store.getByThread(THREAD, 0);
    expect(rows).toHaveLength(DEFAULT_THREAD_LIMIT);
    // Newest-50 window, returned chronologically: rows #10..#59.
    expect(rows[0]?.content).toBe(burstBody(10));
    expect(rows[rows.length - 1]?.content).toBe(burstBody(59));
  });

  it('clamps a negative limit to the default page size', async () => {
    const rows = await store.getByThread(THREAD, -5);
    expect(rows).toHaveLength(DEFAULT_THREAD_LIMIT);
  });

  it('clamps NaN limit to the default page size', async () => {
    const rows = await store.getByThread(THREAD, Number.NaN);
    expect(rows).toHaveLength(DEFAULT_THREAD_LIMIT);
  });

  it('clamps Infinity limit to the default page size (non-finite collapses to default)', async () => {
    const rows = await store.getByThread(THREAD, Number.POSITIVE_INFINITY);
    expect(rows).toHaveLength(DEFAULT_THREAD_LIMIT);
  });

  it('floors a fractional limit to an integer', async () => {
    const rows = await store.getByThread(THREAD, 3.9);
    expect(rows).toHaveLength(3);
    // Floor(3.9) => 3 newest rows, chronologically #57, #58, #59.
    expect(rows.map((m) => m.content)).toEqual([burstBody(57), burstBody(58), burstBody(59)]);
  });

  it('returns all rows when limit exceeds the available count', async () => {
    const rows = await store.getByThread(THREAD, 1000);
    expect(rows).toHaveLength(60);
    expect(rows[0]?.content).toBe(burstBody(0));
  });

  it('returns [] for a thread with no messages', async () => {
    const rows = await store.getByThread('thread-does-not-exist', 10);
    expect(rows).toEqual([]);
  });
});

describe('SqliteMessageStore — edge/adversarial: getByThreadBefore pagination boundaries', () => {
  let store: SqliteMessageStore;

  beforeEach(() => {
    ({ store } = freshStore());
  });

  it('returns [] when beforeId is the very first message (nothing older exists)', async () => {
    const base = Date.now();
    const first = await store.append(makeMessage({ content: burstBody(0), timestamp: base }));
    await store.append(makeMessage({ content: burstBody(1), timestamp: base + 1 }));
    await store.append(makeMessage({ content: burstBody(2), timestamp: base + 2 }));

    const older = await store.getByThreadBefore(THREAD, first.id, 10);
    expect(older).toEqual([]);
  });

  it('returns [] for an unknown beforeId (cursor lookup miss)', async () => {
    const base = Date.now();
    await store.append(makeMessage({ content: burstBody(0), timestamp: base }));
    await store.append(makeMessage({ content: burstBody(1), timestamp: base + 1 }));

    const older = await store.getByThreadBefore(THREAD, 'msg_000000000000000_deadbeef', 10);
    expect(older).toEqual([]);
  });

  it('clamps a non-positive limit to the default page size in getByThreadBefore', async () => {
    const base = Date.now();
    const appended: StoredMessage[] = [];
    // 60 rows so that "before the newest" with a clamped 50 returns exactly 50.
    for (let i = 0; i < 60; i += 1) {
      appended.push(await store.append(makeMessage({ content: burstBody(i), timestamp: base + i })));
    }
    const newest = appended[59]!;
    const older = await store.getByThreadBefore(THREAD, newest.id, 0);
    // 59 rows are strictly older than the newest; clamp(0)=>50 caps it at 50.
    expect(older).toHaveLength(DEFAULT_THREAD_LIMIT);
    // The window is the newest 50 of the 59 older rows => #9..#58, chronologically.
    expect(older[0]?.content).toBe(burstBody(9));
    expect(older[older.length - 1]?.content).toBe(burstBody(58));
  });

  it('deterministic tie-break: full pagination over rows sharing ONE identical timestamp has no dupes or gaps', async () => {
    // Adversarial: 30 messages in the same thread all stamped with the IDENTICAL timestamp.
    // Ordering must fall back to the id cursor; paging backwards must cover every row exactly once.
    const SAME_TS = 1_700_000_000_000;
    const ROWS = 30;
    const appended: StoredMessage[] = [];
    for (let i = 0; i < ROWS; i += 1) {
      appended.push(
        await store.append(makeMessage({ content: burstBody(i), timestamp: SAME_TS })),
      );
    }

    // Canonical full-thread order under the identical-timestamp tie-break.
    const full = await store.getByThread(THREAD, ROWS);
    expect(full).toHaveLength(ROWS);
    const fullIds = full.map((m) => m.id);
    // No duplicate ids in the canonical ordering.
    expect(new Set(fullIds).size).toBe(ROWS);

    // Page backwards from the last row in 7-row pages; collect everything older than it.
    const lastId = full[full.length - 1]!.id;
    const PAGE = 7;
    const collected: string[] = [];
    let cursorId = lastId;
    // Guard against an infinite loop if pagination ever stalls.
    for (let guard = 0; guard < ROWS + 5; guard += 1) {
      const page = await store.getByThreadBefore(THREAD, cursorId, PAGE);
      if (page.length === 0) break;
      // Each page is itself ascending; prepend so collected stays globally ascending.
      collected.unshift(...page.map((m) => m.id));
      cursorId = page[0]!.id;
    }

    // Everything strictly older than the last row = the first ROWS-1 rows of the canonical order.
    const expectedOlder = fullIds.slice(0, ROWS - 1);
    expect(collected).toEqual(expectedOlder);
    // No dupes across pages, no gaps: union equals the expected set exactly.
    expect(new Set(collected).size).toBe(expectedOlder.length);
  });

  it('does not leak rows from other threads when paginating before a cursor', async () => {
    const base = Date.now();
    const a1 = await store.append(makeMessage({ content: burstBody(0), timestamp: base }));
    await store.append(makeMessage({ content: burstBody(1), timestamp: base + 1 }));
    const cursor = await store.append(makeMessage({ content: burstBody(2), timestamp: base + 2 }));
    // Other-thread rows with overlapping timestamps that MUST NOT appear.
    await store.append(
      makeMessage({ threadId: OTHER_THREAD, content: '别的线程的消息，不该出现', timestamp: base }),
    );
    await store.append(
      makeMessage({ threadId: OTHER_THREAD, content: '另一个 thread 的历史', timestamp: base + 1 }),
    );

    const older = await store.getByThreadBefore(THREAD, cursor.id, 50);
    expect(older.map((m) => m.threadId).every((t) => t === THREAD)).toBe(true);
    expect(older.map((m) => m.content)).toEqual([burstBody(0), burstBody(1)]);
    expect(older.map((m) => m.id)).toContain(a1.id);
  });
});

describe('SqliteMessageStore — edge: getById / updateExtra misses (documented no-op)', () => {
  let store: SqliteMessageStore;
  let db: Database.Database;

  beforeEach(() => {
    ({ db, store } = freshStore());
  });

  it('getById returns null for an unknown id', async () => {
    const result = await store.getById('msg_000000000000000_nonexist');
    expect(result).toBeNull();
  });

  it('updateExtra on a non-existent id does not throw and creates no row', async () => {
    await store.append(makeMessage({ content: burstBody(0) }));
    const before = db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number };

    await expect(
      store.updateExtra('msg_000000000000000_ghostid', { reviewed: true, blocker: 'none' }),
    ).resolves.toBeUndefined();

    const after = db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number };
    expect(after.c).toBe(before.c);
    // The ghost id is still absent.
    expect(await store.getById('msg_000000000000000_ghostid')).toBeNull();
  });

  it('updateExtra REPLACES the extra bag (does not merge with the prior value)', async () => {
    const msg = await store.append(
      makeMessage({
        content: '@codex 复核 SOP impl 阶段的产出',
        extra: { reviewed: false, reviewer: 'codex-gpt', sopStage: 'impl', notes: '初稿' },
      }),
    );

    // Write a smaller bag; if updateExtra merged, the old keys would survive.
    await store.updateExtra(msg.id, { reviewed: true, score: 9 });
    const fetched = await store.getById(msg.id);

    expect(fetched?.extra).toEqual({ reviewed: true, score: 9 });
    expect(fetched?.extra).not.toHaveProperty('reviewer');
    expect(fetched?.extra).not.toHaveProperty('sopStage');
    expect(fetched?.extra).not.toHaveProperty('notes');
  });
});

describe('SqliteMessageStore — edge/adversarial: JSON round-trip fidelity', () => {
  let store: SqliteMessageStore;

  beforeEach(() => {
    ({ store } = freshStore());
  });

  it('round-trips unicode, emoji, and nested objects/arrays in extra', async () => {
    const extra: Record<string, unknown> = {
      review: {
        verdict: '通过',
        blockers: [],
        warnings: ['命名不一致：threadId vs thread_id 🚧'],
        nested: { depth: 2, tags: ['架构', 'evidence', 'recall'], emoji: '🚀🐱' },
      },
      tracing: { invocationId: 'inv_001', retries: 0, latencyMs: 1234.5 },
      unicodeSamples: 'CJK 中文 / かな / 한글 / emoji 🎉🔥, surrogate pair 𝕏',
    };
    const msg = await store.append(
      makeMessage({ content: '评审结论已写入 extra 🚀', extra }),
    );

    const fetched = await store.getById(msg.id);
    expect(fetched?.extra).toEqual(extra);
    expect(fetched?.content).toBe('评审结论已写入 extra 🚀');
  });

  it('preserves CJK + emoji in content and CJK-derived mention ids', async () => {
    const zhClaude = createAgentId('布偶猫');
    const zhCodex = createAgentId('俄罗斯蓝猫');
    const msg = await store.append(
      makeMessage({
        content: '@布偶猫 @俄罗斯蓝猫 一起来评审这版方案吧 🐱✨，重点看并发安全。',
        mentions: [zhClaude, zhCodex],
      }),
    );

    const fetched = await store.getById(msg.id);
    expect(fetched?.content).toBe('@布偶猫 @俄罗斯蓝猫 一起来评审这版方案吧 🐱✨，重点看并发安全。');
    expect(fetched?.mentions).toEqual([zhClaude, zhCodex]);
  });

  it('round-trips an empty mentions array as []', async () => {
    const msg = await store.append(
      makeMessage({
        agentId: CLAUDE,
        userId: 'claude-opus',
        content: 'SQLite + WAL 足以支撑当前并发，无需切 Postgres。',
        mentions: [],
        origin: 'stream',
      }),
    );

    const fetched = await store.getById(msg.id);
    expect(fetched?.mentions).toEqual([]);
    expect(Array.isArray(fetched?.mentions)).toBe(true);
  });

  it('round-trips agentId null (user message) vs a real branded AgentId (agent reply)', async () => {
    const userMsg = await store.append(
      makeMessage({ agentId: null, content: '@gemini 帮忙跑一遍回归测试。', mentions: [GEMINI] }),
    );
    const agentMsg = await store.append(
      makeMessage({
        agentId: GEMINI,
        userId: 'gemini-pro',
        content: '回归测试全绿：tests/stores/ 0 failed。',
        mentions: [],
        origin: 'stream',
        timestamp: userMsg.timestamp + 1,
      }),
    );

    const fetchedUser = await store.getById(userMsg.id);
    const fetchedAgent = await store.getById(agentMsg.id);

    expect(fetchedUser?.agentId).toBeNull();

    // The branded id must come back equal to a freshly branded value (not lost / not raw-dropped).
    expect(fetchedAgent?.agentId).toBe(GEMINI);
    expect(fetchedAgent?.agentId).toBe(createAgentId('gemini-pro'));
    // And it must still satisfy the branded-id consumers (mentions are AgentId[]).
    const echoMentions: AgentId[] =
      fetchedAgent?.agentId !== null && fetchedAgent?.agentId !== undefined
        ? [fetchedAgent.agentId]
        : [];
    expect(echoMentions).toEqual([GEMINI]);
  });
});

describe('SqliteMessageStore — edge: origin defaulting', () => {
  let store: SqliteMessageStore;

  beforeEach(() => {
    ({ store } = freshStore());
  });

  it("persists 'user' when origin is omitted on append", async () => {
    const noOrigin: Omit<StoredMessage, 'id'> = {
      threadId: THREAD,
      userId: USER,
      agentId: null,
      content: '@claude 没带 origin 字段的消息，应当默认成 user。',
      mentions: [CLAUDE],
      timestamp: Date.now(),
    };

    const appended = await store.append(noOrigin);
    expect(appended.origin).toBe('user');

    const fetched = await store.getById(appended.id);
    expect(fetched?.origin).toBe('user');
  });

  it("persists each explicit origin verbatim ('stream' / 'callback' / 'system')", async () => {
    const base = Date.now();
    const streamMsg = await store.append(
      makeMessage({
        agentId: CLAUDE,
        userId: 'claude-opus',
        content: '流式输出：正在生成迁移脚本……',
        mentions: [],
        origin: 'stream',
        timestamp: base,
      }),
    );
    const callbackMsg = await store.append(
      makeMessage({
        agentId: CODEX,
        userId: 'codex-gpt',
        content: 'MCP 回调写入的 A2A 消息 @gemini 接力。',
        mentions: [GEMINI],
        origin: 'callback',
        timestamp: base + 1,
      }),
    );
    const systemMsg = await store.append(
      makeMessage({
        content: '[System] invocation inv_042 已创建。',
        mentions: [],
        origin: 'system',
        timestamp: base + 2,
      }),
    );

    expect((await store.getById(streamMsg.id))?.origin).toBe('stream');
    expect((await store.getById(callbackMsg.id))?.origin).toBe('callback');
    expect((await store.getById(systemMsg.id))?.origin).toBe('system');
  });
});
