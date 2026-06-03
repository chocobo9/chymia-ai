// tests/invocation/session-reopen.edge.test.ts
// QA gating tests for SessionStore.reopenSession (M3 storage). Independently
// authored by QA (≠ the dev who wrote the product code). Gates the critical
// invariant: at most ONE session is 'active' per (agentId, threadId) — reopening
// a sealed session must seal whatever is currently active for that EXACT pair,
// flip the target back to active (clearing sealedAt + digest), and never leave
// two active rows. Multi-agent isolation (reopen scoped to (agent, thread), not
// the whole thread) is the key adversarial case.
//
// Real :memory: SQLite via injected better-sqlite3 Database; real message store +
// tool-event log as transcript readers; real roster agent ids (claude-opus /
// codex-gpt / gemini-pro) and real CLI session ids.

import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createAgentId } from '@choco/shared';
import type { AgentId } from '@choco/shared';
import { SessionStore } from '@choco/api/invocation/session-store';
import { SqliteMessageStore } from '@choco/api/stores/sqlite-message-store';
import { SqliteToolEventLog } from '@choco/api/stores/sqlite-tool-event-log';

// Real roster ids (packages/api/src/config/agents.yaml).
const CLAUDE: AgentId = createAgentId('claude-opus');
const CODEX: AgentId = createAgentId('codex-gpt');
const GEMINI: AgentId = createAgentId('gemini-pro');

interface Harness {
  readonly db: Database.Database;
  readonly messageStore: SqliteMessageStore;
  readonly toolEventLog: SqliteToolEventLog;
  readonly store: SessionStore;
}

/** Monotonic clock so each seal/start gets a distinct, ordered timestamp. */
function clock(start = 1_700_000_000_000): () => number {
  let t = start;
  return () => {
    t += 1;
    return t;
  };
}

function harness(now: () => number = clock()): Harness {
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

/** Direct count of active rows for one (agent, thread) — bypasses the store API. */
function countActive(db: Database.Database, agentId: AgentId, threadId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sessions WHERE agent_id = ? AND thread_id = ? AND status = 'active'`,
    )
    .get(agentId as string, threadId) as { n: number };
  return row.n;
}

/** Seed one real archived message under a session id so it has a transcript to digest. */
async function seedMessage(
  store: SqliteMessageStore,
  threadId: string,
  agentId: AgentId,
  sessionId: string,
  content: string,
  timestamp: number,
): Promise<void> {
  await store.append({
    threadId,
    userId: 'user-makima',
    agentId,
    content,
    mentions: [],
    origin: 'stream',
    timestamp,
    sessionId,
  });
}

describe('SessionStore.reopenSession — ≤1-active invariant (THE core property)', () => {
  test('reopening a sealed #1 while #2 is active flips #1 active, seals #2, leaves exactly one active', async () => {
    // Arrange: a real 2-session chain — #1 sealed (carries a digest), #2 active.
    const { db, messageStore, store } = harness();
    const threadId = 'thread-two-sum';
    store.startSession(CLAUDE, threadId, 'cli-sess-1');
    await seedMessage(
      messageStore,
      threadId,
      CLAUDE,
      'cli-sess-1',
      '先写两数之和的哈希解法，O(n) 一次遍历。',
      1_700_000_000_100,
    );
    store.startSession(CLAUDE, threadId, 'cli-sess-2'); // seals #1, opens #2
    expect(store.getSession('cli-sess-1')?.status).toBe('sealed');
    expect(store.getActiveSessionId(CLAUDE, threadId)).toBe('cli-sess-2');

    // Act
    const reopened = store.reopenSession('cli-sess-1');

    // Assert: #1 is the returned, now-active record; #2 is sealed.
    expect(reopened.sessionId).toBe('cli-sess-1');
    expect(reopened.status).toBe('active');
    expect(store.getSession('cli-sess-1')?.status).toBe('active');
    expect(store.getSession('cli-sess-2')?.status).toBe('sealed');

    // The whole-thread chain has EXACTLY ONE active row.
    const chain = store.listByThread(threadId);
    expect(chain.filter((s) => s.status === 'active')).toHaveLength(1);
    // Direct DB count agrees (store API and table agree).
    expect(countActive(db, CLAUDE, threadId)).toBe(1);
    // The next turn for (claude, thread) would resume #1.
    expect(store.getActiveSessionId(CLAUDE, threadId)).toBe('cli-sess-1');
    db.close();
  });

  test('a reopened session record has NO sealedAt and NO digest (it is live again)', async () => {
    // Arrange: seal #1 with a real transcript so it genuinely has sealedAt + digest.
    const { db, messageStore, store } = harness();
    const threadId = 'thread-clear-seal';
    store.startSession(CODEX, threadId, 'cli-clear-1');
    await seedMessage(
      messageStore,
      threadId,
      CODEX,
      'cli-clear-1',
      'Implemented the retry backoff with jitter.',
      1_700_000_000_200,
    );
    store.startSession(CODEX, threadId, 'cli-clear-2'); // seals #1 → sealedAt + digest set
    const sealed = store.getSession('cli-clear-1');
    expect(sealed?.sealedAt).toBeDefined();
    expect(sealed?.digest).toBeDefined();

    // Act
    const reopened = store.reopenSession('cli-clear-1');

    // Assert: both seal artifacts are cleared on the returned record AND on re-read.
    expect(reopened.sealedAt).toBeUndefined();
    expect(reopened.digest).toBeUndefined();
    const reread = store.getSession('cli-clear-1');
    expect(reread?.sealedAt).toBeUndefined();
    expect(reread?.digest).toBeUndefined();
    db.close();
  });

  test('(deeper chain) reopening seq 1 while seq 3 is active: 1 active, 3 sealed, 2 stays sealed, order intact', () => {
    // Arrange: 3 sessions for one (agent, thread). Only seq 3 is active.
    const { db, store } = harness();
    const threadId = 'thread-deep';
    store.startSession(CLAUDE, threadId, 'cli-deep-1'); // seq 1
    store.startSession(CLAUDE, threadId, 'cli-deep-2'); // seq 2, seals 1
    store.startSession(CLAUDE, threadId, 'cli-deep-3'); // seq 3, seals 2
    expect(store.getActiveSessionId(CLAUDE, threadId)).toBe('cli-deep-3');

    // Act: reopen the OLDEST.
    store.reopenSession('cli-deep-1');

    // Assert: seq 1 active, seq 3 sealed, seq 2 untouched (still sealed).
    expect(store.getSession('cli-deep-1')?.status).toBe('active');
    expect(store.getSession('cli-deep-2')?.status).toBe('sealed');
    expect(store.getSession('cli-deep-3')?.status).toBe('sealed');
    // Exactly one active across the whole chain.
    expect(countActive(db, CLAUDE, threadId)).toBe(1);
    // Chain still ordered by sequenceNo (reopen mutates status, not sequence).
    const chain = store.listByThread(threadId);
    expect(chain.map((s) => s.sequenceNo)).toEqual([1, 2, 3]);
    expect(chain.map((s) => s.sessionId)).toEqual(['cli-deep-1', 'cli-deep-2', 'cli-deep-3']);
    expect(store.getActiveSessionId(CLAUDE, threadId)).toBe('cli-deep-1');
    db.close();
  });
});

describe('SessionStore.reopenSession — idempotence & error handling (edge)', () => {
  test('reopening the currently-active session returns it unchanged and creates no second active', () => {
    // Arrange: #1 sealed, #2 active.
    const { db, store } = harness();
    const threadId = 'thread-idem';
    store.startSession(GEMINI, threadId, 'cli-idem-1');
    store.startSession(GEMINI, threadId, 'cli-idem-2'); // #2 active, #1 sealed
    const before = store.getSession('cli-idem-2');

    // Act: reopen the ALREADY-active #2.
    const after = store.reopenSession('cli-idem-2');

    // Assert: returned unchanged; #1 was NOT re-touched (no double-seal side effect),
    // and there is still exactly one active.
    expect(after).toEqual(before);
    expect(after.status).toBe('active');
    expect(store.getSession('cli-idem-1')?.status).toBe('sealed');
    expect(countActive(db, GEMINI, threadId)).toBe(1);
    expect(store.getActiveSessionId(GEMINI, threadId)).toBe('cli-idem-2');
    db.close();
  });

  test('idempotent reopen of the active session does not re-seal a sibling (sealedAt preserved)', async () => {
    // Arrange: #1 sealed at a known time with a digest; #2 active.
    const tick = clock();
    const { db, messageStore, store } = harness(tick);
    const threadId = 'thread-idem-noseal';
    store.startSession(CLAUDE, threadId, 'cli-ns-1');
    await seedMessage(messageStore, threadId, CLAUDE, 'cli-ns-1', 'Wired the SOP evaluator.', 1_700_000_000_300);
    store.startSession(CLAUDE, threadId, 'cli-ns-2'); // seals #1
    const sealedAtBefore = store.getSession('cli-ns-1')?.sealedAt;
    const digestBefore = store.getSession('cli-ns-1')?.digest;
    expect(sealedAtBefore).toBeDefined();

    // Act: reopening the active #2 must be a pure no-op for #1.
    store.reopenSession('cli-ns-2');

    // Assert: #1's seal artifacts are untouched.
    expect(store.getSession('cli-ns-1')?.sealedAt).toBe(sealedAtBefore);
    expect(store.getSession('cli-ns-1')?.digest).toEqual(digestBefore);
    db.close();
  });

  test('(adversarial) reopening an UNKNOWN session id throws and mutates nothing', () => {
    // Arrange: a live chain we will assert is untouched after the throw.
    const { db, store } = harness();
    const threadId = 'thread-ghost';
    store.startSession(CLAUDE, threadId, 'cli-ghost-1');
    store.startSession(CLAUDE, threadId, 'cli-ghost-2'); // #2 active

    // Act + Assert: throws for an id no row owns.
    expect(() => store.reopenSession('cli-no-such-session')).toThrow(/not found/i);

    // The real chain is intact: #2 still active, #1 still sealed, one active.
    expect(store.getSession('cli-ghost-2')?.status).toBe('active');
    expect(store.getSession('cli-ghost-1')?.status).toBe('sealed');
    expect(countActive(db, CLAUDE, threadId)).toBe(1);
    db.close();
  });
});

describe('SessionStore.reopenSession — sequence integrity after reopen (edge)', () => {
  test('reopen #1 then startSession seals #1 and opens the new one at max(seq)+1 (no seq collision)', () => {
    // Arrange: #1 sealed, #2 active (max seq = 2).
    const { db, store } = harness();
    const threadId = 'thread-reopen-then-start';
    store.startSession(CLAUDE, threadId, 'cli-rs-1'); // seq 1
    store.startSession(CLAUDE, threadId, 'cli-rs-2'); // seq 2, seals 1

    // Act: reopen #1 (now active), then start a brand-new session.
    store.reopenSession('cli-rs-1');
    expect(store.getActiveSessionId(CLAUDE, threadId)).toBe('cli-rs-1');
    const fresh = store.startSession(CLAUDE, threadId, 'cli-rs-3');

    // Assert: the new session is seq 3 (max+1), NOT a reuse of 1 or 2; #1 re-sealed.
    expect(fresh.sequenceNo).toBe(3);
    expect(store.getSession('cli-rs-1')?.status).toBe('sealed');
    expect(store.getActiveSessionId(CLAUDE, threadId)).toBe('cli-rs-3');
    const chain = store.listByThread(threadId);
    expect(chain.map((s) => s.sequenceNo)).toEqual([1, 2, 3]);
    // Sequence numbers are unique — no collision introduced by the reopen detour.
    const seqs = chain.map((s) => s.sequenceNo);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(countActive(db, CLAUDE, threadId)).toBe(1);
    db.close();
  });
});

describe('SessionStore.reopenSession — multi-agent isolation (adversarial)', () => {
  test('reopening one of agent A\'s sealed sessions seals A\'s active but leaves agent B\'s active untouched', () => {
    // Arrange: ONE thread. Agent A (claude) has a 2-session chain (#A1 sealed, #A2
    // active). Agent B (codex) has its own active session on the SAME thread.
    const { db, store } = harness();
    const threadId = 'thread-shared';
    store.startSession(CLAUDE, threadId, 'cli-A1'); // A seq 1
    store.startSession(CLAUDE, threadId, 'cli-A2'); // A seq 2, seals A1; A2 active
    store.startSession(CODEX, threadId, 'cli-B1'); // B seq 1, active (independent slot)

    // Precondition: each agent has exactly one active row.
    expect(countActive(db, CLAUDE, threadId)).toBe(1);
    expect(countActive(db, CODEX, threadId)).toBe(1);
    expect(store.getActiveSessionId(CODEX, threadId)).toBe('cli-B1');

    // Act: reopen A's SEALED #A1. Must scope to (claude, thread) ONLY.
    store.reopenSession('cli-A1');

    // Assert — A side: A1 active, A2 sealed, exactly one A active.
    expect(store.getSession('cli-A1')?.status).toBe('active');
    expect(store.getSession('cli-A2')?.status).toBe('sealed');
    expect(countActive(db, CLAUDE, threadId)).toBe(1);
    expect(store.getActiveSessionId(CLAUDE, threadId)).toBe('cli-A1');

    // Assert — B side (the key adversarial check): B's active session is UNTOUCHED.
    // A reopen scoped to the whole thread (the bug) would have sealed cli-B1 here.
    expect(store.getSession('cli-B1')?.status).toBe('active');
    expect(countActive(db, CODEX, threadId)).toBe(1);
    expect(store.getActiveSessionId(CODEX, threadId)).toBe('cli-B1');

    // Whole-thread view: precisely TWO active rows total (one per agent), never one
    // or three — proving the seal landed only on A's slot.
    const chain = store.listByThread(threadId);
    expect(chain.filter((s) => s.status === 'active')).toHaveLength(2);
    db.close();
  });

  test('(adversarial) two sealed siblings of A while B is active: reopening the OLDER A seals only A2, never B', () => {
    // Arrange: A has 3 sessions (A1,A2 sealed, A3 active); B has one active. Reopen A1.
    const { db, store } = harness();
    const threadId = 'thread-shared-deep';
    store.startSession(CLAUDE, threadId, 'cli-DA1');
    store.startSession(CLAUDE, threadId, 'cli-DA2');
    store.startSession(CLAUDE, threadId, 'cli-DA3'); // A3 active
    store.startSession(GEMINI, threadId, 'cli-DB1'); // B active (gemini)

    // Act
    store.reopenSession('cli-DA1');

    // Assert: only A3 (A's prior active) got sealed; A1 active; A2 stays sealed.
    expect(store.getSession('cli-DA1')?.status).toBe('active');
    expect(store.getSession('cli-DA2')?.status).toBe('sealed');
    expect(store.getSession('cli-DA3')?.status).toBe('sealed');
    // B (gemini) is entirely untouched.
    expect(store.getSession('cli-DB1')?.status).toBe('active');
    expect(countActive(db, CLAUDE, threadId)).toBe(1);
    expect(countActive(db, GEMINI, threadId)).toBe(1);
    db.close();
  });
});

describe('SessionStore.reopenSession — atomicity / no partial state (adversarial)', () => {
  test('after reopen the resulting chain never has 0 active and never 2 active for the (agent, thread)', () => {
    // Drive a sequence of reopens and assert the end-state invariant each time.
    const { db, store } = harness();
    const threadId = 'thread-atomic';
    store.startSession(CLAUDE, threadId, 'cli-at-1');
    store.startSession(CLAUDE, threadId, 'cli-at-2');
    store.startSession(CLAUDE, threadId, 'cli-at-3'); // 3 active

    const reopenTargets = ['cli-at-1', 'cli-at-2', 'cli-at-3', 'cli-at-1'];
    for (const target of reopenTargets) {
      store.reopenSession(target);
      // Invariant: exactly one active for the pair after EVERY reopen — never 0, never 2.
      expect(countActive(db, CLAUDE, threadId)).toBe(1);
      // And that one active is precisely the reopened target.
      expect(store.getActiveSessionId(CLAUDE, threadId)).toBe(target);
    }
    db.close();
  });

  test('reopen does not duplicate rows or alter the chain length (status-only mutation)', () => {
    const { db, store } = harness();
    const threadId = 'thread-no-dup';
    store.startSession(CODEX, threadId, 'cli-nd-1');
    store.startSession(CODEX, threadId, 'cli-nd-2');
    const lenBefore = store.listByThread(threadId).length;

    store.reopenSession('cli-nd-1');

    const after = store.listByThread(threadId);
    expect(after).toHaveLength(lenBefore); // no new rows
    // Same two session ids, same sequence numbers — only status changed.
    expect(after.map((s) => s.sessionId)).toEqual(['cli-nd-1', 'cli-nd-2']);
    expect(after.map((s) => s.sequenceNo)).toEqual([1, 2]);
    db.close();
  });
});
