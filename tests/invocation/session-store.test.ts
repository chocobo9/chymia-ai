// tests/invocation/session-store.test.ts
// M3 dev happy-path tests for the SessionStore archive (补充 E).
// Real :memory: SQLite via injected better-sqlite3 Database; real message store +
// tool-event log as transcript readers; real agent ids / tool names / CLI session ids.

import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createAgentId } from '@clowder/shared';
import type { AgentId } from '@clowder/shared';
import { SessionStore } from '@clowder/api/invocation/session-store';
import { SqliteMessageStore } from '@clowder/api/stores/sqlite-message-store';
import { SqliteToolEventLog } from '@clowder/api/stores/sqlite-tool-event-log';

const CLAUDE: AgentId = createAgentId('claude-opus');
const CODEX: AgentId = createAgentId('codex');

/** Build a SessionStore over a fresh in-memory db wired to real transcript readers. */
function harness(now: () => number = () => 1_700_000_000_000): {
  db: Database.Database;
  messageStore: SqliteMessageStore;
  toolEventLog: SqliteToolEventLog;
  store: SessionStore;
} {
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

describe('SessionStore — resume surface (happy path)', () => {
  test('startSession then getActiveSessionId returns the active CLI session id', () => {
    // Arrange
    const { db, store } = harness();

    // Act
    store.startSession(CLAUDE, 'thread-todo-api', 'sess-claude-9c1d4e');
    const active = store.getActiveSessionId(CLAUDE, 'thread-todo-api');

    // Assert
    expect(active).toBe('sess-claude-9c1d4e');
    db.close();
  });

  test('getActiveSessionId returns undefined for an unstarted (agent, thread)', () => {
    const { db, store } = harness();
    expect(store.getActiveSessionId(CODEX, 'thread-empty')).toBeUndefined();
    db.close();
  });

  test('startSession seals the prior active session and increments sequence_no', () => {
    // Arrange
    const { db, store } = harness();
    const threadId = 'thread-chain';

    // Act: two sessions in sequence for the same (agent, thread).
    const first = store.startSession(CLAUDE, threadId, 'sess-first-0001');
    const second = store.startSession(CLAUDE, threadId, 'sess-second-0002');

    // Assert: seq increments; only the second is active; the first is sealed (kept).
    expect(first.sequenceNo).toBe(1);
    expect(second.sequenceNo).toBe(2);
    expect(store.getActiveSessionId(CLAUDE, threadId)).toBe('sess-second-0002');

    const firstRecord = store.getSession('sess-first-0001');
    expect(firstRecord?.status).toBe('sealed');
    expect(firstRecord?.sealedAt).toBeDefined();
    const secondRecord = store.getSession('sess-second-0002');
    expect(secondRecord?.status).toBe('active');
    db.close();
  });

  test('sealActiveSession seals (does NOT delete) the active session and stores a digest', async () => {
    // Arrange
    const { db, messageStore, toolEventLog, store } = harness();
    const threadId = 'thread-seal';
    store.startSession(CLAUDE, threadId, 'sess-seal-01');

    // Real transcript: one agent reply + one tool event tagged to this session.
    await messageStore.append({
      threadId,
      userId: 'user',
      agentId: CLAUDE,
      content: 'Implemented the DELETE /todos/:id route.',
      mentions: [],
      origin: 'stream',
      timestamp: 1_700_000_000_100,
      sessionId: 'sess-seal-01',
    });
    await toolEventLog.append({
      invocationId: 'inv-1',
      threadId,
      agentId: CLAUDE,
      toolName: 'write_file',
      toolInput: JSON.stringify({ path: 'src/routes/todos.ts' }),
      timestamp: 1_700_000_000_150,
      sessionId: 'sess-seal-01',
    });

    // Act
    store.sealActiveSession(CLAUDE, threadId);

    // Assert: row still present, sealed, digest populated; no longer active.
    const record = store.getSession('sess-seal-01');
    expect(record).not.toBeNull();
    expect(record?.status).toBe('sealed');
    expect(record?.digest).toBeDefined();
    expect(record?.digest?.messageCount).toBe(1);
    expect(record?.digest?.toolCounts['write_file']).toBe(1);
    expect(record?.digest?.filesTouched).toContain('src/routes/todos.ts');
    expect(store.getActiveSessionId(CLAUDE, threadId)).toBeUndefined();
    db.close();
  });
});

describe('SessionStore — archive surface (happy path)', () => {
  test('listByThread returns the session chain in sequence order (multi-agent)', () => {
    // Arrange: two agents each opening a session on one thread.
    const { db, store } = harness();
    const threadId = 'thread-multi';
    store.startSession(CLAUDE, threadId, 'sess-claude-a');
    store.startSession(CODEX, threadId, 'sess-codex-a');
    store.startSession(CLAUDE, threadId, 'sess-claude-b'); // seals claude-a, seq 2

    // Act
    const chain = store.listByThread(threadId);

    // Assert: ascending by sequence_no; all three present.
    expect(chain.map((s) => s.sessionId)).toEqual([
      'sess-claude-a',
      'sess-codex-a',
      'sess-claude-b',
    ]);
    expect(chain.map((s) => s.sequenceNo)).toEqual([1, 1, 2]);
    db.close();
  });

  test('getTranscript merges messages + tool_events of a session by timestamp', async () => {
    // Arrange
    const { db, messageStore, toolEventLog, store } = harness();
    const threadId = 'thread-transcript';
    store.startSession(CLAUDE, threadId, 'sess-tx-01');

    // Interleaved by timestamp: message@100, tool@150, message@200.
    await messageStore.append({
      threadId,
      userId: 'user',
      agentId: CLAUDE,
      content: 'Starting the implementation.',
      mentions: [],
      origin: 'stream',
      timestamp: 100,
      sessionId: 'sess-tx-01',
    });
    await toolEventLog.append({
      invocationId: 'inv-1',
      threadId,
      agentId: CLAUDE,
      toolName: 'run_tests',
      timestamp: 150,
      sessionId: 'sess-tx-01',
    });
    await messageStore.append({
      threadId,
      userId: 'user',
      agentId: CLAUDE,
      content: 'Tests pass.',
      mentions: [],
      origin: 'stream',
      timestamp: 200,
      sessionId: 'sess-tx-01',
    });

    // Act
    const transcript = await store.getTranscript('sess-tx-01');

    // Assert: three events, chronological, correct kinds.
    expect(transcript.map((e) => e.kind)).toEqual(['message', 'tool_event', 'message']);
    expect(transcript.map((e) => e.timestamp)).toEqual([100, 150, 200]);
    expect(transcript[1]?.toolName).toBe('run_tests');
    db.close();
  });

  test('getDigest returns the stored digest for a sealed session', async () => {
    // Arrange
    const { db, messageStore, toolEventLog, store } = harness();
    const threadId = 'thread-digest';
    store.startSession(CLAUDE, threadId, 'sess-dg-01');
    await messageStore.append({
      threadId,
      userId: 'user',
      agentId: CLAUDE,
      content: 'Refactored the store.',
      mentions: [],
      origin: 'stream',
      timestamp: 300,
      sessionId: 'sess-dg-01',
    });
    await toolEventLog.append({
      invocationId: 'inv-1',
      threadId,
      agentId: CLAUDE,
      toolName: 'edit_file',
      toolInput: JSON.stringify({ file_path: 'src/store.ts' }),
      timestamp: 360,
      sessionId: 'sess-dg-01',
    });
    store.sealActiveSession(CLAUDE, threadId);

    // Act
    const digest = await store.getDigest('sess-dg-01');

    // Assert
    expect(digest).not.toBeNull();
    expect(digest?.messageCount).toBe(1);
    expect(digest?.toolCounts['edit_file']).toBe(1);
    expect(digest?.filesTouched).toContain('src/store.ts');
    expect(digest?.durationMs).toBe(60); // 360 - 300
    expect(digest?.firstAt).toBe(300);
    expect(digest?.lastAt).toBe(360);
    db.close();
  });

  test('getDigest computes a fresh digest for an active (unsealed) session', async () => {
    // Arrange
    const { db, messageStore, store } = harness();
    const threadId = 'thread-active-digest';
    store.startSession(CLAUDE, threadId, 'sess-active-01');
    await messageStore.append({
      threadId,
      userId: 'user',
      agentId: CLAUDE,
      content: 'Working...',
      mentions: [],
      origin: 'stream',
      timestamp: 500,
      sessionId: 'sess-active-01',
    });

    // Act
    const digest = await store.getDigest('sess-active-01');

    // Assert: computed live (session is still active, no stored digest).
    expect(digest?.messageCount).toBe(1);
    db.close();
  });

  test('getSession returns null for an unknown session id', () => {
    const { db, store } = harness();
    expect(store.getSession('sess-does-not-exist')).toBeNull();
    db.close();
  });

  test('migration is idempotent: constructing two stores over one db does not throw', () => {
    const { db, messageStore, toolEventLog } = harness();
    expect(() => {
      const a = new SessionStore(db, { messageReader: messageStore, toolEventReader: toolEventLog });
      const b = new SessionStore(db, { messageReader: messageStore, toolEventReader: toolEventLog });
      a.startSession(CODEX, 'thread-x', 'sess-x-1');
      expect(b.getActiveSessionId(CODEX, 'thread-x')).toBe('sess-x-1');
    }).not.toThrow();
    db.close();
  });
});
