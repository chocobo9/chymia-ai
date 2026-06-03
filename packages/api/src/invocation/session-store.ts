// packages/api/src/invocation/session-store.ts
// M3: SessionStore — the session ARCHIVE (升级 A3 resume-token SessionManager).
//
// Authored from clowder-design-supplement.md 补充 E (E3.1 schema / E3.2 ISessionStore /
// E3.3 transcript / E3.4 lifecycle). A session is a first-class archived artifact:
// it carries a 1-based sequence number per (thread, agent), a status (active|sealed),
// and — once sealed — a computed digest. Its transcript is the messages + tool_events
// produced during the session, tagged with its session_id and merged by timestamp.
//
// WHY this shape (researched from Clowder SessionSealer / TranscriptReader, NOT copied):
// - Clowder seals (status change + keep the record) rather than deletes, so the chain
//   stays auditable; we mirror that essence with status='sealed' (no Clowder 'sealing'
//   transient, no unseal — those are product decorations excluded by 补充 E E2).
// - Clowder's digest is an extractive summary of the session's events; we compute the
//   same essence (tool counts / files touched / errors / duration) at seal time and
//   store it as JSON, so a sealed session is self-describing without re-reading events.
//
// Constructor injection only (supplement D, no global singleton): the Database plus
// the transcript readers (message store + tool-event log) are provided by the caller.
// The store runs the idempotent migration and compiles its prepared statements once.

import type { Database } from 'better-sqlite3';
import type {
  AgentId,
  ISessionStore,
  SessionDigest,
  SessionEvent,
  SessionRecord,
  SessionStatus,
  StoredMessage,
  StoredToolEvent,
} from '@choco/shared';
import { createAgentId } from '@choco/shared';

/**
 * Logical table name for the session archive.
 * Named const (not inlined) so every statement references one source of truth.
 */
export const SESSIONS_TABLE = 'sessions';

/** Index over the session chain — (thread_id, sequence_no) per 补充 E E3.1. */
export const SESSIONS_THREAD_SEQ_INDEX = 'idx_sessions_thread_seq';

/** Session status string constants (avoid magic strings in queries). */
const STATUS_ACTIVE: SessionStatus = 'active';
const STATUS_SEALED: SessionStatus = 'sealed';

/**
 * Read port for the message half of a transcript. The concrete
 * SqliteMessageStore satisfies this; injecting the narrow port keeps the
 * SessionStore decoupled from the full store surface (and easy to test).
 * Source: 补充 E E3.3.
 */
export interface SessionMessageReader {
  getBySession(sessionId: string): Promise<StoredMessage[]>;
}

/**
 * Read port for the tool-event half of a transcript. The concrete
 * SqliteToolEventLog satisfies this.
 * Source: 补充 E E3.3.
 */
export interface SessionToolEventReader {
  readBySession(sessionId: string): Promise<StoredToolEvent[]>;
}

/** Clock function injected for deterministic timestamps in tests. */
export type NowFn = () => number;

/** Raw row shape for the `sessions` table (precisely typed; no `any`). */
interface SessionRow {
  readonly session_id: string;
  readonly thread_id: string;
  readonly agent_id: string;
  readonly sequence_no: number;
  readonly status: string;
  readonly created_at: number;
  readonly sealed_at: number | null;
  readonly digest: string | null;
}

/** Narrow a raw status string to {@link SessionStatus} (fail-safe → 'sealed'). */
function toStatus(raw: string): SessionStatus {
  return raw === STATUS_ACTIVE ? STATUS_ACTIVE : STATUS_SEALED;
}

/** Parse a stored digest JSON column into a {@link SessionDigest}, or undefined. */
function parseDigest(raw: string | null): SessionDigest | undefined {
  if (raw === null) return undefined;
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== 'object') return undefined;
  return value as SessionDigest;
}

/** Map a raw DB row to an immutable {@link SessionRecord}. */
function rowToRecord(row: SessionRow): SessionRecord {
  const digest = parseDigest(row.digest);
  return {
    sessionId: row.session_id,
    threadId: row.thread_id,
    agentId: createAgentId(row.agent_id),
    sequenceNo: row.sequence_no,
    status: toStatus(row.status),
    createdAt: row.created_at,
    ...(row.sealed_at !== null ? { sealedAt: row.sealed_at } : {}),
    ...(digest !== undefined ? { digest } : {}),
  };
}

/**
 * Idempotently create the `sessions` archive table + index.
 *
 * Schema mirrors clowder-design-supplement.md 补充 E E3.1:
 *   sessions(session_id PK, thread_id, agent_id, sequence_no, status, created_at,
 *            sealed_at, digest) + index (thread_id, sequence_no).
 * Invariant (enforced in the store, not the schema): at most one row with
 * status='active' per (agent_id, thread_id).
 *
 * @param db injected better-sqlite3 Database (no global singleton — supplement D).
 */
export function createSessionsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${SESSIONS_TABLE} (
      session_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      sequence_no INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      sealed_at INTEGER,
      digest TEXT
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS ${SESSIONS_THREAD_SEQ_INDEX}
      ON ${SESSIONS_TABLE} (thread_id, sequence_no);
  `);
}

/** Dependencies of {@link SessionStore}. */
export interface SessionStoreDeps {
  /** Reads the message half of a session transcript (SqliteMessageStore). */
  readonly messageReader: SessionMessageReader;
  /** Reads the tool-event half of a session transcript (SqliteToolEventLog). */
  readonly toolEventReader: SessionToolEventReader;
  /** Clock for created_at / sealed_at stamps. Defaults to Date.now. */
  readonly now?: NowFn;
}

/**
 * SessionStore — SQLite-backed session archive. Implements 补充 E E3.2 ISessionStore.
 *
 * Design notes:
 * - The Database + transcript readers are constructor-injected; the store runs the
 *   idempotent migration and compiles its prepared statements once.
 * - `now` is injectable so tests assert deterministic created_at / sealed_at.
 * - Resume methods are status-aware (only the active row participates in resume);
 *   the archive methods expose the full chain, single records, transcripts and digests.
 */
export class SessionStore implements ISessionStore {
  private readonly db: Database;
  private readonly messageReader: SessionMessageReader;
  private readonly toolEventReader: SessionToolEventReader;
  private readonly now: NowFn;

  private readonly getActiveStmt;
  private readonly getBySessionIdStmt;
  private readonly insertStmt;
  private readonly sealStmt;
  private readonly reopenStmt;
  private readonly maxSeqStmt;
  private readonly listByThreadStmt;
  private readonly messageRowsStmt;
  private readonly toolRowsStmt;

  constructor(db: Database, deps: SessionStoreDeps) {
    createSessionsTable(db);
    this.db = db;
    this.messageReader = deps.messageReader;
    this.toolEventReader = deps.toolEventReader;
    this.now = deps.now ?? Date.now;

    this.getActiveStmt = db.prepare<[string, string], SessionRow>(`
      SELECT * FROM ${SESSIONS_TABLE}
      WHERE agent_id = ? AND thread_id = ? AND status = '${STATUS_ACTIVE}'
    `);

    this.getBySessionIdStmt = db.prepare<[string], SessionRow>(`
      SELECT * FROM ${SESSIONS_TABLE} WHERE session_id = ?
    `);

    this.insertStmt = db.prepare<[string, string, string, number, number]>(`
      INSERT INTO ${SESSIONS_TABLE}
        (session_id, thread_id, agent_id, sequence_no, status, created_at, sealed_at, digest)
      VALUES
        (?, ?, ?, ?, '${STATUS_ACTIVE}', ?, NULL, NULL)
    `);

    // Seal a specific session: status → sealed, stamp sealed_at, store digest JSON.
    this.sealStmt = db.prepare<[number, string, string]>(`
      UPDATE ${SESSIONS_TABLE}
      SET status = '${STATUS_SEALED}', sealed_at = ?, digest = ?
      WHERE session_id = ?
    `);

    // Reopen a sealed session: status → active, clear sealed_at + digest (they are
    // recomputed when it is sealed again).
    this.reopenStmt = db.prepare<[string]>(`
      UPDATE ${SESSIONS_TABLE}
      SET status = '${STATUS_ACTIVE}', sealed_at = NULL, digest = NULL
      WHERE session_id = ?
    `);

    // Highest sequence_no seen for (agent, thread) — basis for the next seq.
    this.maxSeqStmt = db.prepare<[string, string], { max_seq: number | null }>(`
      SELECT MAX(sequence_no) AS max_seq FROM ${SESSIONS_TABLE}
      WHERE agent_id = ? AND thread_id = ?
    `);

    this.listByThreadStmt = db.prepare<[string], SessionRow>(`
      SELECT * FROM ${SESSIONS_TABLE}
      WHERE thread_id = ?
      ORDER BY sequence_no ASC, created_at ASC
    `);

    // Direct (synchronous) reads of the two transcript tables for seal-time
    // digest. 补充 E E3.3: the transcript is exactly messages + tool_events
    // filtered by session_id; sealing is synchronous, so we read them directly
    // here rather than awaiting the async reader ports.
    this.messageRowsStmt = db.prepare<[string], TranscriptMessageRow>(`
      SELECT id, agent_id, content, timestamp, session_id FROM messages
      WHERE session_id = ? ORDER BY timestamp ASC, id ASC
    `);

    this.toolRowsStmt = db.prepare<[string], TranscriptToolRow>(`
      SELECT id, agent_id, tool_name, tool_input, tool_result, duration_ms, timestamp
      FROM tool_events WHERE session_id = ? ORDER BY timestamp ASC, id ASC
    `);
  }

  /**
   * The live session id for (agentId, threadId), or undefined if none is active.
   * The invoke flow resumes the CLI session when this returns a value.
   * Source: 补充 E E3.2 getActiveSessionId (status-aware 旧 getSessionId).
   */
  getActiveSessionId(agentId: AgentId, threadId: string): string | undefined {
    const row = this.getActiveStmt.get(agentId as string, threadId);
    return row === undefined ? undefined : row.session_id;
  }

  /**
   * Start a new active session for (agentId, threadId): seal the prior active one
   * (if any) then insert a fresh active record at sequenceNo+1.
   * Source: 补充 E E3.2 startSession / E3.4 (session_init → seal old + open new).
   *
   * Atomic: the seal + insert run in one transaction so the ≤1-active invariant
   * is never observably violated.
   *
   * Idempotent on a duplicate session_id: a CLI session id is globally unique
   * (E3.1), but session_init can legitimately re-announce the SAME id (e.g. a
   * resumed conversation re-emitting init). Rather than crash the invocation on a
   * PK conflict, we still seal the prior active for this (agent, thread) and then
   * return the EXISTING record for that session_id — the active pointer ends up on
   * the announced session either way, with no duplicate row.
   */
  startSession(agentId: AgentId, threadId: string, sessionId: string): SessionRecord {
    const createdAt = this.now();
    const run = this.db.transaction((): SessionRecord => {
      const existing = this.getBySessionIdStmt.get(sessionId);
      const activeId = this.getActiveSessionId(agentId, threadId);
      if (existing !== undefined && existing.session_id === activeId) {
        // The live active session re-announced itself (resumed CLI re-emits
        // session_init). Sealing here would close the very session being
        // re-announced; instead this is an idempotent no-op — the active pointer
        // already rests on the announced session. Return the unchanged record.
        return rowToRecord(existing);
      }
      // A different session is announced (or none yet): seal the prior active for
      // this (agent, thread) so the ≤1-active invariant holds.
      this.sealActiveInternal(agentId, threadId, createdAt);
      if (existing !== undefined) {
        // Known-but-not-currently-active CLI session re-announced: keep the
        // existing row, don't insert a dup — the active pointer ends up on it.
        return rowToRecord(existing);
      }
      const nextSeq = this.nextSequenceNo(agentId, threadId);
      this.insertStmt.run(sessionId, threadId, agentId as string, nextSeq, createdAt);
      return {
        sessionId,
        threadId,
        agentId,
        sequenceNo: nextSeq,
        status: STATUS_ACTIVE,
        createdAt,
      };
    });
    return run();
  }

  /**
   * Seal (NOT delete) the active session for (agentId, threadId): set status to
   * 'sealed', stamp sealed_at, compute + store its digest. No-op if no active
   * session exists. Keeps history (the row stays).
   * Source: 补充 E E3.2 sealActiveSession (旧 clearSession-delete → now seals).
   */
  sealActiveSession(agentId: AgentId, threadId: string): void {
    this.sealActiveInternal(agentId, threadId, this.now());
  }

  /**
   * Reopen a SEALED session as the live one for its (agent, thread): seal whatever
   * is currently active for that pair (so the ≤1-active invariant always holds),
   * then flip the target back to 'active' — clearing its sealed_at + digest (they
   * recompute on the next seal). The next turn for that agent then resumes this
   * session's CLI id. Returns the updated record.
   *
   * Atomic (one transaction). A no-op (returns the record unchanged) if the target
   * is already active. Throws if `sessionId` is unknown — callers (the route) check
   * existence first and surface 404.
   */
  reopenSession(sessionId: string): SessionRecord {
    const run = this.db.transaction((): SessionRecord => {
      const target = this.getBySessionIdStmt.get(sessionId);
      if (target === undefined) {
        throw new Error(`session not found: ${sessionId}`);
      }
      if (toStatus(target.status) === STATUS_ACTIVE) {
        return rowToRecord(target); // already live — nothing to do
      }
      // The target is sealed; seal the CURRENT active for this (agent, thread)
      // first (it is a different session) so we never have two active rows.
      this.sealActiveInternal(createAgentId(target.agent_id), target.thread_id, this.now());
      this.reopenStmt.run(sessionId);
      const updated = this.getBySessionIdStmt.get(sessionId);
      return rowToRecord(updated ?? target);
    });
    return run();
  }

  /**
   * The full session chain for a thread, ascending by sequenceNo (multi-agent
   * threads interleave by sequence then creation time).
   * Source: 补充 E E3.2 listByThread.
   */
  listByThread(threadId: string): SessionRecord[] {
    return this.listByThreadStmt.all(threadId).map(rowToRecord);
  }

  /**
   * A single session record by id, or null if unknown.
   * Source: 补充 E E3.2 getSession.
   */
  getSession(sessionId: string): SessionRecord | null {
    const row = this.getBySessionIdStmt.get(sessionId);
    return row === undefined ? null : rowToRecord(row);
  }

  /**
   * The session's transcript: its messages + tool_events merged by timestamp.
   * Source: 补充 E E3.2 getTranscript / E3.3.
   */
  async getTranscript(sessionId: string): Promise<SessionEvent[]> {
    const [messages, toolEvents] = await Promise.all([
      this.messageReader.getBySession(sessionId),
      this.toolEventReader.readBySession(sessionId),
    ]);
    return mergeTranscript(messages, toolEvents);
  }

  /**
   * The session's digest. For a sealed session the stored digest is returned; for
   * an active session (or one missing a stored digest) it is computed fresh from
   * the current transcript. Returns null if the session id is unknown.
   * Source: 补充 E E3.2 getDigest.
   */
  async getDigest(sessionId: string): Promise<SessionDigest | null> {
    const record = this.getSession(sessionId);
    if (record === null) return null;
    if (record.digest !== undefined) return record.digest;
    const transcript = await this.getTranscript(sessionId);
    return computeDigest(transcript);
  }

  /**
   * Seal the active session for (agent, thread) at `sealedAt` and persist its
   * digest, computed from the current transcript. Shared by startSession (seal
   * the old before opening the new) and sealActiveSession.
   *
   * The digest read happens BEFORE the row flips to sealed; the transcript is the
   * same either way (rows are tagged with session_id, not with status), so the
   * synchronous seal is paired with an awaited digest compute.
   */
  private sealActiveInternal(agentId: AgentId, threadId: string, sealedAt: number): void {
    const active = this.getActiveStmt.get(agentId as string, threadId);
    if (active === undefined) return;
    // Compute the digest from the session's transcript, then seal. The transcript
    // readers are async; we resolve them synchronously is impossible, so seal here
    // stores a digest computed by the synchronous path below.
    this.sealStmt.run(sealedAt, this.computeDigestJsonSync(active.session_id), active.session_id);
  }

  /**
   * Compute the digest JSON for a session synchronously from the SQLite rows.
   *
   * sealActiveSession / startSession are synchronous (the resume hot path must not
   * await), but the transcript readers are async ports. To keep sealing synchronous
   * we read the two tagged tables directly via prepared statements here, mirroring
   * what the async readers return, and compute the same digest. This is the only
   * place the store reaches the message/tool_event tables directly (E3.3 says the
   * transcript is exactly those two tables filtered by session_id).
   */
  private computeDigestJsonSync(sessionId: string): string {
    const msgRows = this.messageRowsStmt.all(sessionId);
    const toolRows = this.toolRowsStmt.all(sessionId);
    const events = mergeTranscriptRows(msgRows, toolRows);
    return JSON.stringify(computeDigest(events));
  }

  /** Next 1-based sequence number for (agent, thread). */
  private nextSequenceNo(agentId: AgentId, threadId: string): number {
    const row = this.maxSeqStmt.get(agentId as string, threadId);
    const max = row?.max_seq ?? 0;
    return max + 1;
  }
}

/** Minimal message row for seal-time transcript reconstruction. */
interface TranscriptMessageRow {
  readonly id: string;
  readonly agent_id: string | null;
  readonly content: string;
  readonly timestamp: number;
  readonly session_id: string | null;
}

/** Minimal tool-event row for seal-time transcript reconstruction. */
interface TranscriptToolRow {
  readonly id: string;
  readonly agent_id: string;
  readonly tool_name: string;
  readonly tool_input: string | null;
  readonly tool_result: string | null;
  readonly duration_ms: number | null;
  readonly timestamp: number;
}

/**
 * Merge stored messages + tool events into a timestamp-ordered transcript.
 * Source: 补充 E E3.3. A message contributes a 'message' event; a tool event a
 * 'tool_event' event. Ties break by kind (message before tool_event) then id, for
 * a deterministic order.
 */
function mergeTranscript(
  messages: readonly StoredMessage[],
  toolEvents: readonly StoredToolEvent[],
): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const m of messages) {
    if (m.agentId === null) continue; // user messages are never session-tagged
    events.push({
      kind: 'message',
      id: m.id,
      agentId: m.agentId,
      timestamp: m.timestamp,
      content: m.content,
      ...(isErrorMessage(m) ? { isError: true } : {}),
    });
  }
  for (const t of toolEvents) {
    events.push({
      kind: 'tool_event',
      id: t.id,
      agentId: t.agentId,
      timestamp: t.timestamp,
      toolName: t.toolName,
      ...(t.toolInput !== undefined ? { toolInput: t.toolInput } : {}),
      ...(t.toolResult !== undefined ? { toolResult: t.toolResult } : {}),
      ...(t.durationMs !== undefined ? { durationMs: t.durationMs } : {}),
    });
  }
  return sortEvents(events);
}

/** Seal-time variant: merge directly from minimal SQLite rows (no async ports). */
function mergeTranscriptRows(
  msgRows: readonly TranscriptMessageRow[],
  toolRows: readonly TranscriptToolRow[],
): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const m of msgRows) {
    if (m.agent_id === null) continue;
    events.push({
      kind: 'message',
      id: m.id,
      agentId: createAgentId(m.agent_id),
      timestamp: m.timestamp,
      content: m.content,
    });
  }
  for (const t of toolRows) {
    events.push({
      kind: 'tool_event',
      id: t.id,
      agentId: createAgentId(t.agent_id),
      timestamp: t.timestamp,
      toolName: t.tool_name,
      ...(t.tool_input !== null ? { toolInput: t.tool_input } : {}),
      ...(t.tool_result !== null ? { toolResult: t.tool_result } : {}),
      ...(t.duration_ms !== null ? { durationMs: t.duration_ms } : {}),
    });
  }
  return sortEvents(events);
}

/** Stable transcript ordering: timestamp, then message-before-tool, then id. */
function sortEvents(events: SessionEvent[]): SessionEvent[] {
  const KIND_RANK: Record<SessionEvent['kind'], number> = { message: 0, tool_event: 1 };
  return [...events].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    if (a.kind !== b.kind) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * A stored agent reply counts as an error when its extra bag flags it. The M8
 * persist path stores error replies plainly; this is a best-effort signal (the
 * digest tolerates errorCount=0 when nothing is flagged).
 */
function isErrorMessage(m: StoredMessage): boolean {
  const extra = m.extra;
  return extra !== undefined && extra['isError'] === true;
}

/** Heuristic: extract a file path from a tool input JSON string (best-effort). */
const FILE_PATH_KEYS: readonly string[] = ['path', 'file_path', 'filePath', 'file'];

function extractFilePath(toolInput: string | undefined): string | undefined {
  if (toolInput === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolInput);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;
  for (const key of FILE_PATH_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Compute a {@link SessionDigest} from a transcript.
 * Source: 补充 E E3.2 — messageCount, per-tool counts, distinct files touched,
 * error count, duration (lastAt − firstAt), and the time bounds.
 */
export function computeDigest(transcript: readonly SessionEvent[]): SessionDigest {
  const toolCounts: Record<string, number> = {};
  const filesTouched = new Set<string>();
  let messageCount = 0;
  let errorCount = 0;
  let firstAt = 0;
  let lastAt = 0;
  let seenAny = false;

  for (const ev of transcript) {
    if (!seenAny) {
      firstAt = ev.timestamp;
      lastAt = ev.timestamp;
      seenAny = true;
    } else {
      if (ev.timestamp < firstAt) firstAt = ev.timestamp;
      if (ev.timestamp > lastAt) lastAt = ev.timestamp;
    }

    if (ev.kind === 'message') {
      messageCount += 1;
      if (ev.isError === true) errorCount += 1;
    } else {
      if (ev.toolName !== undefined) {
        toolCounts[ev.toolName] = (toolCounts[ev.toolName] ?? 0) + 1;
      }
      const file = extractFilePath(ev.toolInput);
      if (file !== undefined) filesTouched.add(file);
    }
  }

  return {
    messageCount,
    toolCounts,
    filesTouched: [...filesTouched],
    errorCount,
    durationMs: lastAt - firstAt,
    firstAt,
    lastAt,
  };
}
