// tests/invocation/session-store.adversarial.test.ts
// QA adversarial coverage for the SessionStore archive (补充 E). Independently
// authored (≠ the dev). Hammers sequence integrity under rapid successive starts,
// seal→start→seal→start chains (seq must keep climbing, never reuse), the
// ≤1-active invariant under hostile interleaving, transcript merge under
// interleaved + adversarial timestamps, and digest robustness against unicode /
// huge tool inputs. Real :memory: SQLite, real stores, real ids.

import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createAgentId } from '@clowder/shared';
import type { AgentId } from '@clowder/shared';
import { SessionStore } from '@clowder/api/invocation/session-store';
import { SqliteMessageStore } from '@clowder/api/stores/sqlite-message-store';
import { SqliteToolEventLog } from '@clowder/api/stores/sqlite-tool-event-log';

const CLAUDE: AgentId = createAgentId('claude-opus');
const CODEX: AgentId = createAgentId('codex');

interface Harness {
  readonly db: Database.Database;
  readonly messageStore: SqliteMessageStore;
  readonly toolEventLog: SqliteToolEventLog;
  readonly store: SessionStore;
}

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

function countActive(db: Database.Database, agentId: AgentId, threadId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sessions WHERE agent_id = ? AND thread_id = ? AND status = 'active'`,
    )
    .get(agentId as string, threadId) as { n: number };
  return row.n;
}

describe('SessionStore — sequence integrity under stress (adversarial)', () => {
  test('rapid successive startSession yields a strictly increasing 1..N sequence with no gaps or reuse', () => {
    const { db, store } = harness();
    const threadId = 'thread-rapid';
    const N = 25;
    for (let i = 1; i <= N; i += 1) {
      const rec = store.startSession(CLAUDE, threadId, `sess-rapid-${i}`);
      expect(rec.sequenceNo).toBe(i);
    }
    const chain = store.listByThread(threadId);
    expect(chain).toHaveLength(N);
    // Sequence is exactly 1..N, monotonic, no gaps, no reuse.
    expect(chain.map((s) => s.sequenceNo)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    // Exactly one active row (the last), the rest sealed.
    expect(countActive(db, CLAUDE, threadId)).toBe(1);
    expect(chain[N - 1]?.status).toBe('active');
    expect(chain.slice(0, N - 1).every((s) => s.status === 'sealed')).toBe(true);
    db.close();
  });

  test('seal → start → seal → start: sequence keeps climbing across explicit seals (no reuse)', () => {
    const { db, store } = harness();
    const threadId = 'thread-sawtooth';
    const s1 = store.startSession(CLAUDE, threadId, 'sess-saw-1');
    store.sealActiveSession(CLAUDE, threadId); // explicitly seal seq 1
    expect(store.getActiveSessionId(CLAUDE, threadId)).toBeUndefined();
    const s2 = store.startSession(CLAUDE, threadId, 'sess-saw-2'); // nothing active to seal
    store.sealActiveSession(CLAUDE, threadId);
    const s3 = store.startSession(CLAUDE, threadId, 'sess-saw-3');
    expect([s1.sequenceNo, s2.sequenceNo, s3.sequenceNo]).toEqual([1, 2, 3]);
    // Even after seals that emptied the active slot, the next seq is max+1, not 1.
    expect(store.getSession('sess-saw-2')?.sequenceNo).toBe(2);
    expect(store.getSession('sess-saw-3')?.sequenceNo).toBe(3);
    db.close();
  });

  test('interleaved two-agent starts never produce a second active row for either agent', () => {
    const { db, store } = harness();
    const threadId = 'thread-interleave';
    // Hostile interleaving: alternate agents, both repeatedly re-opening.
    store.startSession(CLAUDE, threadId, 'c1');
    store.startSession(CODEX, threadId, 'x1');
    store.startSession(CLAUDE, threadId, 'c2');
    store.startSession(CODEX, threadId, 'x2');
    store.startSession(CLAUDE, threadId, 'c3');
    expect(countActive(db, CLAUDE, threadId)).toBe(1);
    expect(countActive(db, CODEX, threadId)).toBe(1);
    expect(store.getActiveSessionId(CLAUDE, threadId)).toBe('c3');
    expect(store.getActiveSessionId(CODEX, threadId)).toBe('x2');
    // Per-agent sequences are independent: claude 1,2,3 ; codex 1,2.
    expect(store.getSession('c3')?.sequenceNo).toBe(3);
    expect(store.getSession('x2')?.sequenceNo).toBe(2);
    db.close();
  });

  test('duplicate re-announce interleaved with fresh starts does not corrupt the sequence', () => {
    const { db, store } = harness();
    const threadId = 'thread-dup-mix';
    store.startSession(CLAUDE, threadId, 'd1'); // seq 1, active
    store.startSession(CLAUDE, threadId, 'd1'); // re-announce same → still seq1, active, no dup
    store.startSession(CLAUDE, threadId, 'd2'); // seals d1, seq 2, active
    store.startSession(CLAUDE, threadId, 'd2'); // re-announce d2 → no-op-ish, still active
    expect(store.listByThread(threadId).map((s) => s.sessionId)).toEqual(['d1', 'd2']);
    expect(store.getSession('d1')?.sequenceNo).toBe(1);
    expect(store.getSession('d2')?.sequenceNo).toBe(2);
    expect(store.getActiveSessionId(CLAUDE, threadId)).toBe('d2');
    expect(countActive(db, CLAUDE, threadId)).toBe(1);
    db.close();
  });
});

describe('SessionStore — transcript merge under adversarial timestamps (adversarial)', () => {
  test('heavily interleaved message/tool_event timestamps merge into strict chronological order', async () => {
    const { db, messageStore, toolEventLog, store } = harness();
    const threadId = 'thread-interleave-tx';
    store.startSession(CLAUDE, threadId, 'sess-itx');
    // Insert in a deliberately scrambled order; expect chronological output.
    await toolEventLog.append({ invocationId: 'i', threadId, agentId: CLAUDE, toolName: 'read_file', toolInput: JSON.stringify({ path: 'a.ts' }), timestamp: 300, sessionId: 'sess-itx' });
    await messageStore.append({ threadId, userId: 'user', agentId: CLAUDE, content: 'm@100', mentions: [], origin: 'stream', timestamp: 100, sessionId: 'sess-itx' });
    await toolEventLog.append({ invocationId: 'i', threadId, agentId: CLAUDE, toolName: 'write_file', toolInput: JSON.stringify({ path: 'b.ts' }), timestamp: 150, sessionId: 'sess-itx' });
    await messageStore.append({ threadId, userId: 'user', agentId: CLAUDE, content: 'm@400', mentions: [], origin: 'stream', timestamp: 400, sessionId: 'sess-itx' });
    await messageStore.append({ threadId, userId: 'user', agentId: CLAUDE, content: 'm@200', mentions: [], origin: 'stream', timestamp: 200, sessionId: 'sess-itx' });
    const tx = await store.getTranscript('sess-itx');
    expect(tx.map((e) => e.timestamp)).toEqual([100, 150, 200, 300, 400]);
    expect(tx.map((e) => e.kind)).toEqual(['message', 'tool_event', 'message', 'tool_event', 'message']);
    db.close();
  });

  test('a large transcript (200 events) merges + digests without loss', async () => {
    const { db, messageStore, toolEventLog, store } = harness();
    const threadId = 'thread-large';
    store.startSession(CLAUDE, threadId, 'sess-large');
    const COUNT = 100;
    for (let i = 0; i < COUNT; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await messageStore.append({
        threadId,
        userId: 'user',
        agentId: CLAUDE,
        content: `progress update ${i}`,
        mentions: [],
        origin: 'stream',
        timestamp: 1000 + i * 2,
        sessionId: 'sess-large',
      });
      // eslint-disable-next-line no-await-in-loop
      await toolEventLog.append({
        invocationId: 'inv',
        threadId,
        agentId: CLAUDE,
        toolName: 'read_file',
        toolInput: JSON.stringify({ path: `src/module-${i}.ts` }),
        timestamp: 1000 + i * 2 + 1,
        sessionId: 'sess-large',
      });
    }
    const tx = await store.getTranscript('sess-large');
    expect(tx).toHaveLength(COUNT * 2);
    const d = await store.getDigest('sess-large');
    expect(d?.messageCount).toBe(COUNT);
    expect(d?.toolCounts['read_file']).toBe(COUNT);
    expect(d?.filesTouched).toHaveLength(COUNT); // all distinct paths
    expect(d?.firstAt).toBe(1000);
    expect(d?.lastAt).toBe(1000 + (COUNT - 1) * 2 + 1);
    db.close();
  });
});

describe('SessionStore — digest robustness against hostile inputs (adversarial)', () => {
  test('unicode + emoji tool names and file paths survive digest aggregation', async () => {
    const { db, toolEventLog, store } = harness();
    const threadId = 'thread-unicode';
    store.startSession(CLAUDE, threadId, 'sess-uni');
    await toolEventLog.append({
      invocationId: 'i',
      threadId,
      agentId: CLAUDE,
      toolName: '写文件_🔧',
      toolInput: JSON.stringify({ path: 'src/路由/路由器.ts' }),
      timestamp: 10,
      sessionId: 'sess-uni',
    });
    await toolEventLog.append({
      invocationId: 'i',
      threadId,
      agentId: CLAUDE,
      toolName: '写文件_🔧',
      toolInput: JSON.stringify({ path: 'src/路由/路由器.ts' }),
      timestamp: 20,
      sessionId: 'sess-uni',
    });
    const d = await store.getDigest('sess-uni');
    expect(d?.toolCounts['写文件_🔧']).toBe(2);
    expect(d?.filesTouched).toEqual(['src/路由/路由器.ts']);
    db.close();
  });

  test('a huge tool input (250KB) is stored, read back, and digested without truncation error', async () => {
    const { db, toolEventLog, store } = harness();
    const threadId = 'thread-huge';
    store.startSession(CODEX, threadId, 'sess-huge');
    const hugePath = `src/${'deep/'.repeat(2000)}leaf.ts`;
    const hugeInput = JSON.stringify({ path: hugePath, blob: 'x'.repeat(200_000) });
    await toolEventLog.append({
      invocationId: 'i',
      threadId,
      agentId: CODEX,
      toolName: 'write_file',
      toolInput: hugeInput,
      timestamp: 5,
      sessionId: 'sess-huge',
    });
    const d = await store.getDigest('sess-huge');
    expect(d?.toolCounts['write_file']).toBe(1);
    expect(d?.filesTouched).toEqual([hugePath]);
    db.close();
  });

  test('tool input that parses to a non-object (JSON array / number) contributes no filesTouched', async () => {
    const { db, toolEventLog, store } = harness();
    const threadId = 'thread-weird-input';
    store.startSession(CLAUDE, threadId, 'sess-weird');
    await toolEventLog.append({ invocationId: 'i', threadId, agentId: CLAUDE, toolName: 'shell', toolInput: '[1,2,3]', timestamp: 1, sessionId: 'sess-weird' });
    await toolEventLog.append({ invocationId: 'i', threadId, agentId: CLAUDE, toolName: 'shell', toolInput: '42', timestamp: 2, sessionId: 'sess-weird' });
    await toolEventLog.append({ invocationId: 'i', threadId, agentId: CLAUDE, toolName: 'shell', toolInput: 'null', timestamp: 3, sessionId: 'sess-weird' });
    const d = await store.getDigest('sess-weird');
    expect(d?.toolCounts['shell']).toBe(3);
    expect(d?.filesTouched).toEqual([]);
    db.close();
  });

  test('a session id containing SQL metacharacters is handled via bound params (no injection, isolation holds)', async () => {
    const { db, messageStore, store } = harness();
    // Hostile-looking session id; prepared statements bind it as a literal.
    const evilId = `sess'; DROP TABLE sessions; --`;
    const threadId = 'thread-sqli';
    store.startSession(CLAUDE, threadId, evilId);
    await messageStore.append({
      threadId,
      userId: 'user',
      agentId: CLAUDE,
      content: 'still here',
      mentions: [],
      origin: 'stream',
      timestamp: 1,
      sessionId: evilId,
    });
    // The table still exists and the record round-trips by its literal id.
    expect(store.getSession(evilId)?.sessionId).toBe(evilId);
    const tx = await store.getTranscript(evilId);
    expect(tx).toHaveLength(1);
    db.close();
  });
});
