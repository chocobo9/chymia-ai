// M5-amend QA — SqliteThreadStore edge + adversarial coverage (independently authored).
//
// Authored by the M5-amend QA subagent (CLAUDE.md §0.5.3: gating edge/adversarial
// tests MUST be written by an agent that did NOT write the product code). This
// file is the machine gate for the AMENDED A7 surface: list() pagination
// boundaries, the cascade delete() transaction (scoped sweep + isolation +
// unknown-thread + atomicity), and ensureThread() idempotency / non-clobber.
//
// Each test constructs a fresh `new Database(':memory:')`; the store ctor runs the
// idempotent migrations, so every case is hermetic. Real domain content only
// (CLAUDE.md §2.2): real branded agent ids, real tool names, real @mention text —
// no "hello"/"foo"/"test123" placeholders.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createAgentId, type AgentId } from '@clowder/shared';
import { SqliteThreadStore } from '@clowder/api/stores/sqlite-thread-store';
import { SqliteMessageStore } from '@clowder/api/stores/sqlite-message-store';
import { SqliteToolEventLog } from '@clowder/api/stores/sqlite-tool-event-log';

const CLAUDE: AgentId = createAgentId('claude-opus');
const CODEX: AgentId = createAgentId('codex-gpt');

/** Monotonic clock: each call returns a strictly increasing epoch-ms value. */
function makeClock(start = 1_700_000_000_000): () => number {
  let t = start;
  return () => {
    t += 1000;
    return t;
  };
}

/** Fixed clock: every call returns the SAME timestamp (forces lastActiveAt ties). */
function fixedClock(at = 1_700_000_000_000): () => number {
  return () => at;
}

describe('SqliteThreadStore.list pagination (edge)', () => {
  let db: Database.Database;
  let store: SqliteThreadStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SqliteThreadStore(db, { now: makeClock() });
  });

  it('returns ALL threads, newest-active first, when called with no args', async () => {
    const a = await store.create({ title: '需求澄清会话' });
    const b = await store.create({ title: '架构评审会话' });
    const c = await store.create({ title: '上线复盘会话' });

    const all = await store.list();

    expect(all).toHaveLength(3);
    expect(all.map((t) => t.id)).toEqual([c.id, b.id, a.id]);
  });

  it('treats limit 0 as unbounded (clamps non-positive to no-limit), returning ALL rows', async () => {
    // limit <= 0 collapses to NO_LIMIT (-1) per the documented normalizeLimit clamp,
    // so a degenerate limit never silently empties the sidebar.
    await store.create({ title: '会话甲' });
    await store.create({ title: '会话乙' });

    const page = await store.list({ limit: 0 });

    expect(page).toHaveLength(2);
  });

  it('treats a negative limit as unbounded (clamp), returning ALL rows', async () => {
    await store.create({ title: '会话甲' });
    await store.create({ title: '会话乙' });
    await store.create({ title: '会话丙' });

    const page = await store.list({ limit: -5 });

    expect(page).toHaveLength(3);
  });

  it('clamps a negative offset to 0 (returns the full newest-first list)', async () => {
    const a = await store.create({ title: '会话甲' });
    const b = await store.create({ title: '会话乙' });

    const page = await store.list({ offset: -3 });

    expect(page.map((t) => t.id)).toEqual([b.id, a.id]);
  });

  it('returns an empty page when offset is beyond the row count', async () => {
    await store.create({ title: '会话甲' });
    await store.create({ title: '会话乙' });

    const page = await store.list({ limit: 10, offset: 5 });

    expect(page).toEqual([]);
  });

  it('returns every row when limit exceeds the total count', async () => {
    const a = await store.create({ title: '会话甲' });
    const b = await store.create({ title: '会话乙' });

    const page = await store.list({ limit: 100 });

    expect(page.map((t) => t.id)).toEqual([b.id, a.id]);
  });

  it('paginates non-overlapping windows that together reconstruct the full ordering', async () => {
    const created = [];
    for (let i = 0; i < 5; i += 1) {
      created.push(await store.create({ title: `会话-${i}` }));
    }
    // Newest-active first: reverse of creation order.
    const expectedOrder = [...created].reverse().map((t) => t.id);

    const page1 = await store.list({ limit: 2, offset: 0 });
    const page2 = await store.list({ limit: 2, offset: 2 });
    const page3 = await store.list({ limit: 2, offset: 4 });

    expect([...page1, ...page2, ...page3].map((t) => t.id)).toEqual(expectedOrder);
    expect(page3).toHaveLength(1); // last window holds the single remaining row
  });

  it('orders deterministically (id DESC tiebreak) when lastActiveAt ties', async () => {
    // Fixed clock → every thread shares createdAt === lastActiveAt; the ORDER BY
    // secondary key (id DESC) must make the result stable, not arbitrary.
    const tied = new SqliteThreadStore(new Database(':memory:'), { now: fixedClock() });
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push((await tied.create({ id: `thread-tie-${i}`, title: `并列会话-${i}` })).id);
    }
    const expected = [...ids].sort((x, y) => (x < y ? 1 : x > y ? -1 : 0)); // id DESC

    const first = await tied.list();
    const second = await tied.list();

    expect(first.map((t) => t.id)).toEqual(expected);
    expect(second.map((t) => t.id)).toEqual(expected); // stable across repeated calls
  });
});

describe('SqliteThreadStore.delete cascade (edge + adversarial)', () => {
  let db: Database.Database;
  let store: SqliteThreadStore;
  let messageStore: SqliteMessageStore;
  let toolEventLog: SqliteToolEventLog;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SqliteThreadStore(db, { now: makeClock() });
    messageStore = new SqliteMessageStore(db);
    toolEventLog = new SqliteToolEventLog(db);
  });

  async function seedThread(id: string, n: number, m: number): Promise<void> {
    await store.create({ id, title: `批量会话 ${id}` });
    for (let i = 0; i < n; i += 1) {
      await messageStore.append({
        threadId: id,
        userId: 'user-makima',
        agentId: null,
        content: `@claude 第 ${i} 条：评审 routing 层的 ping-pong 检测`,
        mentions: [CLAUDE],
        origin: 'user',
        timestamp: 1_700_000_500_000 + i,
      });
    }
    for (let j = 0; j < m; j += 1) {
      await toolEventLog.append({
        invocationId: `inv-${id}-${j}`,
        threadId: id,
        agentId: CLAUDE,
        toolName: j % 2 === 0 ? 'read_file' : 'evidence_search',
        timestamp: 1_700_000_600_000 + j,
      });
    }
  }

  it('clears all three tables for a thread with many messages and tool events', async () => {
    await seedThread('thread-cascade-target', 7, 5);

    const existed = await store.delete('thread-cascade-target');

    expect(existed).toBe(true);
    expect(await store.get('thread-cascade-target')).toBeNull();
    expect(await messageStore.getByThread('thread-cascade-target')).toHaveLength(0);
    expect(await toolEventLog.readByThread('thread-cascade-target')).toHaveLength(0);
  });

  it('leaves OTHER threads rows completely untouched (scoped sweep isolation)', async () => {
    await seedThread('thread-doomed', 4, 3);
    await seedThread('thread-survivor', 6, 4);

    await store.delete('thread-doomed');

    // Survivor keeps every row across all three tables.
    expect(await store.get('thread-survivor')).not.toBeNull();
    expect(await messageStore.getByThread('thread-survivor')).toHaveLength(6);
    expect(await toolEventLog.readByThread('thread-survivor')).toHaveLength(4);
  });

  it('returns false for an unknown thread and removes nothing (no throw, no collateral)', async () => {
    await seedThread('thread-present', 3, 2);

    const existed = await store.delete('thread-never-existed');

    expect(existed).toBe(false);
    // The present thread is fully intact — the no-op delete touched nothing.
    expect(await store.get('thread-present')).not.toBeNull();
    expect(await messageStore.getByThread('thread-present')).toHaveLength(3);
    expect(await toolEventLog.readByThread('thread-present')).toHaveLength(2);
  });

  it('is atomic: no partial state — after delete the thread row and its children vanish together', async () => {
    await seedThread('thread-atomic', 5, 5);

    await store.delete('thread-atomic');

    // Adversarial: probe the raw tables directly — a half-applied cascade would
    // leave orphan messages/tool_events whose thread row is gone (or vice versa).
    const threadRows = db
      .prepare('SELECT COUNT(*) AS c FROM threads WHERE id = ?')
      .get('thread-atomic') as { c: number };
    const msgRows = db
      .prepare('SELECT COUNT(*) AS c FROM messages WHERE thread_id = ?')
      .get('thread-atomic') as { c: number };
    const teRows = db
      .prepare('SELECT COUNT(*) AS c FROM tool_events WHERE thread_id = ?')
      .get('thread-atomic') as { c: number };

    expect(threadRows.c).toBe(0);
    expect(msgRows.c).toBe(0);
    expect(teRows.c).toBe(0);
  });

  it('a second delete of the same thread returns false (already cascaded, idempotent)', async () => {
    await seedThread('thread-twice', 2, 2);

    expect(await store.delete('thread-twice')).toBe(true);
    expect(await store.delete('thread-twice')).toBe(false);
  });
});

describe('SqliteThreadStore.ensureThread idempotency (edge + adversarial)', () => {
  let db: Database.Database;
  let store: SqliteThreadStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SqliteThreadStore(db, { now: makeClock() });
  });

  it('does not clobber an existing thread title/createdAt on re-ensure', async () => {
    const threadId = 'thread-wechat-room-架构组';
    const first = await store.ensureThread(threadId, '微信群：架构组每日同步');

    const second = await store.ensureThread(threadId, '不该覆盖的新标题');

    expect(second.title).toBe('微信群：架构组每日同步');
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.lastActiveAt).toBe(first.lastActiveAt);
  });

  it('does not clobber a thread created with rich fields (participants/sopStage survive)', async () => {
    const threadId = 'thread-sop-driven';
    await store.create({ id: threadId, title: '需求评审（SOP 驱动）' });
    await store.addParticipants(threadId, [CLAUDE, CODEX]);
    await store.updateSopStage(threadId, 'design-review');

    const ensured = await store.ensureThread(threadId, '忽略');

    expect(ensured.title).toBe('需求评审（SOP 驱动）');
    expect(ensured.participants).toEqual([CLAUDE, CODEX]);
    expect(ensured.sopStageId).toBe('design-review');
  });

  it('rapid repeated ensureThread of the same id (quick succession) yields exactly ONE row', async () => {
    // Spec surface: "two ensureThread of the same id in quick succession → one row."
    // Sequential awaited calls (the realistic auto-create-on-message cadence: each
    // inbound message awaits its own ensureThread before the next is handled).
    const threadId = 'thread-burst-ensure';

    for (let i = 0; i < 8; i += 1) {
      await store.ensureThread(threadId, '自动创建（连续消息）');
    }

    const rows = (await store.list()).filter((t) => t.id === threadId);
    expect(rows).toHaveLength(1);
  });
});
