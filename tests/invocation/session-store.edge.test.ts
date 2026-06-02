// tests/invocation/session-store.edge.test.ts
// QA edge coverage for the SessionStore archive (补充 E). Independently authored
// (≠ the dev who wrote session-store.ts). Real :memory: SQLite via injected
// better-sqlite3; real SqliteMessageStore + SqliteToolEventLog as transcript
// readers; real agent ids / tool names (read_file, evidence_search, write_file,
// run_tests, edit_file) / real CLI session ids. No mocking of the unit-under-test.
//
// Attack surface (补充 E E3.1–E3.4): sequence integrity, the ≤1-active invariant,
// status='sealed' (kept, never deleted), cross-thread / cross-agent isolation,
// transcript merge + isolation, digest computation (active vs sealed, errors,
// duration, files), and migration idempotency over the guarded ALTER.

import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createAgentId } from '@choco/shared';
import type { AgentId } from '@choco/shared';
import { SessionStore, computeDigest } from '@choco/api/invocation/session-store';
import { SqliteMessageStore } from '@choco/api/stores/sqlite-message-store';
import { SqliteToolEventLog } from '@choco/api/stores/sqlite-tool-event-log';

const CLAUDE: AgentId = createAgentId('claude-opus');
const CODEX: AgentId = createAgentId('codex');
const GEMINI: AgentId = createAgentId('gemini-pro');

interface Harness {
  readonly db: Database.Database;
  readonly messageStore: SqliteMessageStore;
  readonly toolEventLog: SqliteToolEventLog;
  readonly store: SessionStore;
}

/** Build a SessionStore over a fresh in-memory db wired to real transcript readers. */
function harness(now: () => number = () => 1_700_000_000_000): Harness {
  const db = new Database(':memory:');
  const messageStore = new SqliteMessageStore(db);
  const toolEventLog = new SqliteToolEventLog(db);
  const store = new SessionStore(db, {
    messageReader: messageStore,
    toolEventReader: toolEventLog,
    now,
  });
  return { db, messageStore, toolEventLog, store };
}

/** Count rows whose status='active' for a (agent, thread) — the invariant probe. */
function countActive(db: Database.Database, agentId: AgentId, threadId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sessions WHERE agent_id = ? AND thread_id = ? AND status = 'active'`,
    )
    .get(agentId as string, threadId) as { n: number };
  return row.n;
}

describe('SessionStore — startSession sequence + invariant (edge)', () => {
  test('first session for a (agent, thread) is sequence_no 1 and active with nothing sealed', () => {
    const { db, store } = harness();
    const rec = store.startSession(CLAUDE, 'thread-bootstrap', 'sess-boot-0001');
    expect(rec.sequenceNo).toBe(1);
    expect(rec.status).toBe('active');
    expect(rec.sealedAt).toBeUndefined();
    expect(rec.digest).toBeUndefined();
    // Nothing was sealed because there was no prior active row.
    expect(store.listByThread('thread-bootstrap')).toHaveLength(1);
    db.close();
  });

  test('never leaves two active rows for one (agent, thread) across repeated starts', () => {
    const { db, store } = harness();
    const threadId = 'thread-invariant';
    store.startSession(CLAUDE, threadId, 'sess-inv-1');
    expect(countActive(db, CLAUDE, threadId)).toBe(1);
    store.startSession(CLAUDE, threadId, 'sess-inv-2');
    expect(countActive(db, CLAUDE, threadId)).toBe(1);
    store.startSession(CLAUDE, threadId, 'sess-inv-3');
    expect(countActive(db, CLAUDE, threadId)).toBe(1);
    // The single active row is the most recent one.
    expect(store.getActiveSessionId(CLAUDE, threadId)).toBe('sess-inv-3');
    db.close();
  });

  test('starting a session in thread A does NOT seal thread B active (cross-thread isolation)', () => {
    const { db, store } = harness();
    store.startSession(CLAUDE, 'thread-A', 'sess-A-1');
    store.startSession(CLAUDE, 'thread-B', 'sess-B-1');
    // Opening a 2nd session in A must not touch B's active session.
    store.startSession(CLAUDE, 'thread-A', 'sess-A-2');
    expect(store.getActiveSessionId(CLAUDE, 'thread-B')).toBe('sess-B-1');
    expect(store.getSession('sess-B-1')?.status).toBe('active');
    expect(store.getSession('sess-A-1')?.status).toBe('sealed');
    db.close();
  });

  test('cross-agent isolation: claude and codex keep independent active sessions + sequences', () => {
    const { db, store } = harness();
    const threadId = 'thread-shared';
    store.startSession(CLAUDE, threadId, 'sess-c-1');
    store.startSession(CODEX, threadId, 'sess-x-1');
    store.startSession(CLAUDE, threadId, 'sess-c-2'); // seals claude's, codex untouched
    expect(store.getActiveSessionId(CLAUDE, threadId)).toBe('sess-c-2');
    expect(store.getActiveSessionId(CODEX, threadId)).toBe('sess-x-1');
    // Sequences are per (agent, thread): claude 1→2, codex 1.
    expect(store.getSession('sess-c-2')?.sequenceNo).toBe(2);
    expect(store.getSession('sess-x-1')?.sequenceNo).toBe(1);
    db.close();
  });

  test('idempotent re-announce of the SAME session_id does not crash, double-insert, or double-increment', () => {
    const { db, store } = harness();
    const threadId = 'thread-reannounce';
    const first = store.startSession(CLAUDE, threadId, 'sess-dup-01');
    expect(first.sequenceNo).toBe(1);
    // CLI legitimately re-emits session_init with the SAME id (resumed convo).
    const again = store.startSession(CLAUDE, threadId, 'sess-dup-01');
    // Returns the existing record (no PK crash), same seq, no new row.
    expect(again.sessionId).toBe('sess-dup-01');
    expect(again.sequenceNo).toBe(1);
    expect(store.listByThread(threadId)).toHaveLength(1);
    // It is NOT double-sealed: re-announce of the same id leaves it active.
    expect(store.getActiveSessionId(CLAUDE, threadId)).toBe('sess-dup-01');
    db.close();
  });
});

describe('SessionStore — sealActiveSession semantics (edge)', () => {
  test('seal KEEPS the row (status=sealed, sealedAt set) — it is not a delete', () => {
    const { db, store } = harness(() => 1_700_000_500_000);
    const threadId = 'thread-keep';
    store.startSession(CLAUDE, threadId, 'sess-keep-1');
    store.sealActiveSession(CLAUDE, threadId);
    const rec = store.getSession('sess-keep-1');
    expect(rec).not.toBeNull();
    expect(rec?.status).toBe('sealed');
    expect(rec?.sealedAt).toBe(1_700_000_500_000);
    expect(store.getActiveSessionId(CLAUDE, threadId)).toBeUndefined();
    // The chain still lists the sealed session.
    expect(store.listByThread(threadId).map((s) => s.sessionId)).toEqual(['sess-keep-1']);
    db.close();
  });

  test('sealActiveSession is a no-op when there is no active session', () => {
    const { db, store } = harness();
    // No throw, and listByThread stays empty.
    expect(() => store.sealActiveSession(CODEX, 'thread-none')).not.toThrow();
    expect(store.listByThread('thread-none')).toEqual([]);
    db.close();
  });

  test('sealActiveSession only seals the targeted (agent, thread), leaving others active', () => {
    const { db, store } = harness();
    store.startSession(CLAUDE, 'thread-1', 'sess-1');
    store.startSession(CODEX, 'thread-1', 'sess-2');
    store.startSession(CLAUDE, 'thread-2', 'sess-3');
    store.sealActiveSession(CLAUDE, 'thread-1');
    expect(store.getSession('sess-1')?.status).toBe('sealed');
    expect(store.getSession('sess-2')?.status).toBe('active'); // codex thread-1 untouched
    expect(store.getSession('sess-3')?.status).toBe('active'); // claude thread-2 untouched
    db.close();
  });

  test('sealing an empty session (zero events) produces an empty digest with no crash', () => {
    const { db, store } = harness();
    const threadId = 'thread-empty-seal';
    store.startSession(CLAUDE, threadId, 'sess-empty-01');
    expect(() => store.sealActiveSession(CLAUDE, threadId)).not.toThrow();
    const rec = store.getSession('sess-empty-01');
    expect(rec?.status).toBe('sealed');
    expect(rec?.digest).toBeDefined();
    expect(rec?.digest?.messageCount).toBe(0);
    expect(rec?.digest?.toolCounts).toEqual({});
    expect(rec?.digest?.filesTouched).toEqual([]);
    expect(rec?.digest?.errorCount).toBe(0);
    expect(rec?.digest?.durationMs).toBe(0);
    expect(rec?.digest?.firstAt).toBe(0);
    expect(rec?.digest?.lastAt).toBe(0);
    db.close();
  });
});

describe('SessionStore — listByThread / getSession (edge)', () => {
  test('listByThread returns [] for an unknown thread', () => {
    const { db, store } = harness();
    expect(store.listByThread('thread-never-seen')).toEqual([]);
    db.close();
  });

  test('listByThread lists sealed + active sessions together in ascending sequence order', () => {
    const { db, store } = harness();
    const threadId = 'thread-mixed';
    store.startSession(CLAUDE, threadId, 'sess-a'); // → sealed (seq 1)
    store.startSession(CLAUDE, threadId, 'sess-b'); // → sealed (seq 2)
    store.startSession(CLAUDE, threadId, 'sess-c'); // → active (seq 3)
    const chain = store.listByThread(threadId);
    expect(chain.map((s) => s.sessionId)).toEqual(['sess-a', 'sess-b', 'sess-c']);
    expect(chain.map((s) => s.sequenceNo)).toEqual([1, 2, 3]);
    expect(chain.map((s) => s.status)).toEqual(['sealed', 'sealed', 'active']);
    db.close();
  });

  test('getSession returns null for an unknown id but a record for a known one', () => {
    const { db, store } = harness();
    store.startSession(GEMINI, 'thread-g', 'sess-gem-1');
    expect(store.getSession('sess-gem-1')?.agentId).toBe(GEMINI);
    expect(store.getSession('no-such-session')).toBeNull();
    db.close();
  });
});

describe('SessionStore — getTranscript merge + isolation (edge)', () => {
  test('transcript of a session excludes events tagged to a DIFFERENT session', async () => {
    const { db, messageStore, toolEventLog, store } = harness();
    const threadId = 'thread-iso';
    store.startSession(CLAUDE, threadId, 'sess-iso-1');
    // Event in session 1.
    await messageStore.append({
      threadId,
      userId: 'user',
      agentId: CLAUDE,
      content: 'Patched the auth middleware.',
      mentions: [],
      origin: 'stream',
      timestamp: 100,
      sessionId: 'sess-iso-1',
    });
    // A second session on the same thread with its own event.
    store.startSession(CLAUDE, threadId, 'sess-iso-2');
    await messageStore.append({
      threadId,
      userId: 'user',
      agentId: CLAUDE,
      content: 'Now wiring the rate limiter.',
      mentions: [],
      origin: 'stream',
      timestamp: 200,
      sessionId: 'sess-iso-2',
    });
    await toolEventLog.append({
      invocationId: 'inv-2',
      threadId,
      agentId: CLAUDE,
      toolName: 'edit_file',
      toolInput: JSON.stringify({ file_path: 'src/middleware/rate-limit.ts' }),
      timestamp: 210,
      sessionId: 'sess-iso-2',
    });

    const tx1 = await store.getTranscript('sess-iso-1');
    const tx2 = await store.getTranscript('sess-iso-2');
    expect(tx1.map((e) => e.id)).toHaveLength(1);
    expect(tx1[0]?.content).toBe('Patched the auth middleware.');
    // Session 2 sees its own message + tool event only.
    expect(tx2).toHaveLength(2);
    expect(tx2.map((e) => e.kind)).toEqual(['message', 'tool_event']);
    db.close();
  });

  test('transcript of a tool-only session returns just the tool events', async () => {
    const { db, toolEventLog, store } = harness();
    const threadId = 'thread-toolonly';
    store.startSession(CODEX, threadId, 'sess-tool-only');
    await toolEventLog.append({
      invocationId: 'inv-1',
      threadId,
      agentId: CODEX,
      toolName: 'evidence_search',
      toolInput: JSON.stringify({ query: 'rate limiter design' }),
      timestamp: 300,
      sessionId: 'sess-tool-only',
    });
    const tx = await store.getTranscript('sess-tool-only');
    expect(tx).toHaveLength(1);
    expect(tx[0]?.kind).toBe('tool_event');
    expect(tx[0]?.toolName).toBe('evidence_search');
    db.close();
  });

  test('transcript of a session with no tagged events is empty', async () => {
    const { db, store } = harness();
    store.startSession(CLAUDE, 'thread-silent', 'sess-silent');
    const tx = await store.getTranscript('sess-silent');
    expect(tx).toEqual([]);
    db.close();
  });

  test('transcript excludes user messages (null agentId never carries a session tag)', async () => {
    const { db, messageStore, store } = harness();
    const threadId = 'thread-usermsg';
    store.startSession(CLAUDE, threadId, 'sess-user-mix');
    // A user message: agentId null, no session tag (the persist path leaves it null).
    await messageStore.append({
      threadId,
      userId: 'user-makima',
      agentId: null,
      content: '@claude please add pagination',
      mentions: [CLAUDE],
      origin: 'user',
      timestamp: 50,
    });
    // The agent reply IS tagged.
    await messageStore.append({
      threadId,
      userId: 'user',
      agentId: CLAUDE,
      content: 'Added cursor pagination to GET /todos.',
      mentions: [],
      origin: 'stream',
      timestamp: 120,
      sessionId: 'sess-user-mix',
    });
    const tx = await store.getTranscript('sess-user-mix');
    // Only the agent reply is in the transcript.
    expect(tx).toHaveLength(1);
    expect(tx[0]?.content).toBe('Added cursor pagination to GET /todos.');
    db.close();
  });

  test('same-timestamp events order deterministically: message before tool_event, then id', async () => {
    const { db, messageStore, toolEventLog, store } = harness();
    const threadId = 'thread-tie';
    store.startSession(CLAUDE, threadId, 'sess-tie-1');
    // All at the same timestamp — ordering must be deterministic (message<tool).
    await messageStore.append({
      threadId,
      userId: 'user',
      agentId: CLAUDE,
      content: 'Running the suite.',
      mentions: [],
      origin: 'stream',
      timestamp: 500,
      sessionId: 'sess-tie-1',
    });
    await toolEventLog.append({
      invocationId: 'inv-1',
      threadId,
      agentId: CLAUDE,
      toolName: 'run_tests',
      timestamp: 500,
      sessionId: 'sess-tie-1',
    });
    const tx = await store.getTranscript('sess-tie-1');
    expect(tx.map((e) => e.kind)).toEqual(['message', 'tool_event']);
    db.close();
  });
});

describe('SessionStore — getDigest computation (edge)', () => {
  test('active session digest is computed fresh and reflects later appended events', async () => {
    const { db, messageStore, toolEventLog, store } = harness();
    const threadId = 'thread-fresh';
    store.startSession(CLAUDE, threadId, 'sess-fresh-1');
    await messageStore.append({
      threadId,
      userId: 'user',
      agentId: CLAUDE,
      content: 'First chunk.',
      mentions: [],
      origin: 'stream',
      timestamp: 1000,
      sessionId: 'sess-fresh-1',
    });
    const d1 = await store.getDigest('sess-fresh-1');
    expect(d1?.messageCount).toBe(1);
    // Append more while still active — fresh compute must pick it up.
    await toolEventLog.append({
      invocationId: 'inv-1',
      threadId,
      agentId: CLAUDE,
      toolName: 'write_file',
      toolInput: JSON.stringify({ path: 'src/index.ts' }),
      timestamp: 1500,
      sessionId: 'sess-fresh-1',
    });
    const d2 = await store.getDigest('sess-fresh-1');
    expect(d2?.messageCount).toBe(1);
    expect(d2?.toolCounts['write_file']).toBe(1);
    expect(d2?.filesTouched).toContain('src/index.ts');
    expect(d2?.durationMs).toBe(500); // 1500 - 1000
    db.close();
  });

  test('getDigest returns null for an unknown session id', async () => {
    const { db, store } = harness();
    expect(await store.getDigest('sess-ghost')).toBeNull();
    db.close();
  });

  test('an error-flagged agent message bumps errorCount in the digest', async () => {
    const { db, messageStore, store } = harness();
    const threadId = 'thread-err';
    store.startSession(CODEX, threadId, 'sess-err-1');
    await messageStore.append({
      threadId,
      userId: 'user',
      agentId: CODEX,
      content: 'CLI exited with code 1 while compiling.',
      mentions: [],
      origin: 'stream',
      timestamp: 700,
      sessionId: 'sess-err-1',
      extra: { isError: true },
    });
    await messageStore.append({
      threadId,
      userId: 'user',
      agentId: CODEX,
      content: 'Recovered and finished the build.',
      mentions: [],
      origin: 'stream',
      timestamp: 800,
      sessionId: 'sess-err-1',
    });
    const d = await store.getDigest('sess-err-1');
    expect(d?.messageCount).toBe(2);
    expect(d?.errorCount).toBe(1);
    db.close();
  });

  test('toolCounts aggregates repeated tool names; filesTouched de-dupes paths', async () => {
    const { db, toolEventLog, store } = harness();
    const threadId = 'thread-counts';
    store.startSession(CLAUDE, threadId, 'sess-counts-1');
    // read_file twice on the SAME path, write_file once on another.
    await toolEventLog.append({
      invocationId: 'inv-1',
      threadId,
      agentId: CLAUDE,
      toolName: 'read_file',
      toolInput: JSON.stringify({ path: 'src/app.ts' }),
      timestamp: 10,
      sessionId: 'sess-counts-1',
    });
    await toolEventLog.append({
      invocationId: 'inv-1',
      threadId,
      agentId: CLAUDE,
      toolName: 'read_file',
      toolInput: JSON.stringify({ path: 'src/app.ts' }),
      timestamp: 20,
      sessionId: 'sess-counts-1',
    });
    await toolEventLog.append({
      invocationId: 'inv-1',
      threadId,
      agentId: CLAUDE,
      toolName: 'write_file',
      toolInput: JSON.stringify({ path: 'src/router.ts' }),
      timestamp: 30,
      sessionId: 'sess-counts-1',
    });
    const d = await store.getDigest('sess-counts-1');
    expect(d?.toolCounts['read_file']).toBe(2);
    expect(d?.toolCounts['write_file']).toBe(1);
    expect([...(d?.filesTouched ?? [])].sort()).toEqual(['src/app.ts', 'src/router.ts']);
    expect(d?.durationMs).toBe(20); // 30 - 10
    db.close();
  });

  test('sealed digest is the STORED snapshot and does not change when later events are appended', async () => {
    const { db, messageStore, toolEventLog, store } = harness(() => 1_700_000_900_000);
    const threadId = 'thread-snapshot';
    store.startSession(CLAUDE, threadId, 'sess-snap-1');
    await messageStore.append({
      threadId,
      userId: 'user',
      agentId: CLAUDE,
      content: 'Done.',
      mentions: [],
      origin: 'stream',
      timestamp: 400,
      sessionId: 'sess-snap-1',
    });
    store.sealActiveSession(CLAUDE, threadId); // snapshot: messageCount 1
    // Append an extra event AFTER sealing (simulating a stray late write).
    await toolEventLog.append({
      invocationId: 'inv-late',
      threadId,
      agentId: CLAUDE,
      toolName: 'read_file',
      toolInput: JSON.stringify({ path: 'src/late.ts' }),
      timestamp: 450,
      sessionId: 'sess-snap-1',
    });
    // getDigest returns the stored snapshot (no tool counted), NOT a recompute.
    const d = await store.getDigest('sess-snap-1');
    expect(d?.messageCount).toBe(1);
    expect(d?.toolCounts['read_file']).toBeUndefined();
    db.close();
  });
});

describe('SessionStore — migration idempotency (edge)', () => {
  test('re-running the session migration over an existing db does not throw or duplicate the table', () => {
    const db = new Database(':memory:');
    const messageStore = new SqliteMessageStore(db);
    const toolEventLog = new SqliteToolEventLog(db);
    // Three stores over the SAME db each run createSessionsTable in their ctor.
    const a = new SessionStore(db, { messageReader: messageStore, toolEventReader: toolEventLog });
    a.startSession(CLAUDE, 'thread-mig', 'sess-mig-1');
    const b = new SessionStore(db, { messageReader: messageStore, toolEventReader: toolEventLog });
    const c = new SessionStore(db, { messageReader: messageStore, toolEventReader: toolEventLog });
    // State survives and is visible through every store handle.
    expect(b.getActiveSessionId(CLAUDE, 'thread-mig')).toBe('sess-mig-1');
    expect(c.listByThread('thread-mig')).toHaveLength(1);
    // Exactly one `sessions` table exists (no duplicate from re-running CREATE).
    const tables = db
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='sessions'`)
      .get() as { n: number };
    expect(tables.n).toBe(1);
    db.close();
  });

  test('re-running the messages + tool_events guarded ALTER does not duplicate session_id columns', () => {
    const db = new Database(':memory:');
    // Construct each store twice → migration runs twice over the same tables.
    new SqliteMessageStore(db);
    new SqliteMessageStore(db);
    new SqliteToolEventLog(db);
    new SqliteToolEventLog(db);
    const msgCols = (db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[]).filter(
      (c) => c.name === 'session_id',
    );
    const toolCols = (
      db.prepare(`PRAGMA table_info(tool_events)`).all() as { name: string }[]
    ).filter((c) => c.name === 'session_id');
    expect(msgCols).toHaveLength(1);
    expect(toolCols).toHaveLength(1);
    db.close();
  });
});

describe('computeDigest — pure function (edge)', () => {
  test('empty transcript yields the zeroed digest', () => {
    const d = computeDigest([]);
    expect(d).toEqual({
      messageCount: 0,
      toolCounts: {},
      filesTouched: [],
      errorCount: 0,
      durationMs: 0,
      firstAt: 0,
      lastAt: 0,
    });
  });

  test('out-of-order timestamps still produce correct firstAt/lastAt/durationMs', () => {
    const d = computeDigest([
      { kind: 'message', id: 'm1', agentId: CLAUDE, timestamp: 900, content: 'late' },
      { kind: 'message', id: 'm2', agentId: CLAUDE, timestamp: 100, content: 'early' },
      { kind: 'tool_event', id: 't1', agentId: CLAUDE, timestamp: 500, toolName: 'read_file' },
    ]);
    expect(d.firstAt).toBe(100);
    expect(d.lastAt).toBe(900);
    expect(d.durationMs).toBe(800);
    expect(d.messageCount).toBe(2);
    expect(d.toolCounts['read_file']).toBe(1);
  });

  test('tool_event with malformed JSON toolInput does not contribute a filesTouched entry', () => {
    const d = computeDigest([
      { kind: 'tool_event', id: 't1', agentId: CLAUDE, timestamp: 1, toolName: 'write_file', toolInput: '{not valid json' },
      { kind: 'tool_event', id: 't2', agentId: CLAUDE, timestamp: 2, toolName: 'write_file', toolInput: JSON.stringify({ path: 'src/ok.ts' }) },
    ]);
    expect(d.toolCounts['write_file']).toBe(2);
    expect(d.filesTouched).toEqual(['src/ok.ts']);
  });
});
