import type { Database } from 'better-sqlite3';
import type { StoredMessage, StoredMessageOrigin, AgentId } from '@choco/shared';
import { createAgentId } from '@choco/shared';
import { MESSAGES_TABLE, createMessagesTable } from './migrations/001-messages.js';

/**
 * Default page size for thread reads when the caller does not supply a limit.
 * Mirrors the conversation-history budget intent from clowder-architecture-design.md
 * §C4 (Conversation History ~ recent window); kept modest to bound query cost.
 */
const DEFAULT_THREAD_LIMIT = 50;

/**
 * Default origin written when an appended message omits `origin`.
 * §A1 column default is 'user'; StoredMessage.origin is optional, so we normalize here.
 */
const DEFAULT_ORIGIN: StoredMessageOrigin = 'user';

/**
 * Known StoredMessage origins (frozen M1 shape). Used to narrow the raw TEXT column
 * back to {@link StoredMessageOrigin} without resorting to `any`.
 */
const STORED_MESSAGE_ORIGINS: readonly StoredMessageOrigin[] = [
  'user',
  'stream',
  'callback',
  'system',
];

/**
 * Raw row shape returned by better-sqlite3 for the `messages` table.
 * Used to type prepared-statement results precisely instead of `any`.
 * JSON columns (mentions/extra) come back as TEXT (or NULL).
 */
interface MessageRow {
  readonly id: string;
  readonly thread_id: string;
  readonly user_id: string;
  readonly agent_id: string | null;
  readonly content: string;
  readonly mentions: string;
  readonly origin: string;
  readonly timestamp: number;
  readonly extra: string | null;
  readonly session_id: string | null;
}

/**
 * Bind-parameter object for INSERT. Keys match the `@name` placeholders below.
 */
interface InsertParams {
  readonly id: string;
  readonly thread_id: string;
  readonly user_id: string;
  readonly agent_id: string | null;
  readonly content: string;
  readonly mentions: string;
  readonly origin: string;
  readonly timestamp: number;
  readonly extra: string | null;
  readonly session_id: string | null;
}

function isStoredMessageOrigin(value: string): value is StoredMessageOrigin {
  return (STORED_MESSAGE_ORIGINS as readonly string[]).includes(value);
}

/**
 * Parse a JSON column that is expected to be a string array of agent ids.
 * Falls back to an empty array on invalid content (fail-safe, never throws to caller).
 */
function parseMentions(raw: string): AgentId[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) return [];
  const result: AgentId[] = [];
  for (const item of value) {
    if (typeof item === 'string') result.push(createAgentId(item));
  }
  return result;
}

/**
 * Parse a nullable JSON object column into a typed record, or return undefined.
 */
function parseExtra(raw: string | null): Record<string, unknown> | undefined {
  if (raw === null) return undefined;
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Map a raw DB row to an immutable {@link StoredMessage}.
 * Builds a fresh object so internal/DB state never leaks to callers.
 */
function rowToMessage(row: MessageRow): StoredMessage {
  const extra = parseExtra(row.extra);
  return {
    id: row.id,
    threadId: row.thread_id,
    userId: row.user_id,
    agentId: row.agent_id === null ? null : createAgentId(row.agent_id),
    content: row.content,
    mentions: parseMentions(row.mentions),
    origin: isStoredMessageOrigin(row.origin) ? row.origin : DEFAULT_ORIGIN,
    timestamp: row.timestamp,
    ...(extra !== undefined ? { extra } : {}),
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
  };
}

/**
 * SQLite-backed implementation of the message store (clowder-design-supplement.md §A1).
 *
 * Design notes:
 * - Constructor injection only: the Database is provided by the caller (supplement D,
 *   "no global singleton"). The store never opens its own connection.
 * - WAL journal mode is enabled so concurrent writers do not hit `SQLITE_BUSY`
 *   "database is locked" under burst appends.
 * - All queries use prepared statements compiled once in the constructor.
 * - JSON columns (mentions/extra) are serialized on write and parsed on read.
 */
export class SqliteMessageStore {
  private readonly insertStmt;
  private readonly getByIdStmt;
  private readonly getByThreadStmt;
  private readonly getByThreadBeforeStmt;
  private readonly getTimestampByIdStmt;
  private readonly updateExtraStmt;
  private readonly getBySessionStmt;

  constructor(db: Database) {
    createMessagesTable(db);

    // WAL allows concurrent reads with a single writer and avoids reader/writer lock
    // contention under burst appends. NORMAL synchronous is the standard WAL pairing.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');

    this.insertStmt = db.prepare<InsertParams>(`
      INSERT INTO ${MESSAGES_TABLE}
        (id, thread_id, user_id, agent_id, content, mentions, origin, timestamp, extra, session_id)
      VALUES
        (@id, @thread_id, @user_id, @agent_id, @content, @mentions, @origin, @timestamp, @extra, @session_id)
    `);

    this.getByIdStmt = db.prepare<[string], MessageRow>(`
      SELECT * FROM ${MESSAGES_TABLE} WHERE id = ?
    `);

    // Newest N rows for a thread, returned in chronological (ascending) order.
    // Pattern: order DESC + LIMIT to get the tail, then re-sort ascending in JS via SQL.
    this.getByThreadStmt = db.prepare<[string, number], MessageRow>(`
      SELECT * FROM (
        SELECT * FROM ${MESSAGES_TABLE}
        WHERE thread_id = ?
        ORDER BY timestamp DESC, id DESC
        LIMIT ?
      ) ORDER BY timestamp ASC, id ASC
    `);

    // Page of rows strictly older than a reference (timestamp, id) cursor.
    // The (timestamp, id) tuple keeps ordering stable when timestamps collide.
    this.getByThreadBeforeStmt = db.prepare<[string, number, number, string, number], MessageRow>(`
      SELECT * FROM (
        SELECT * FROM ${MESSAGES_TABLE}
        WHERE thread_id = ?
          AND (timestamp < ? OR (timestamp = ? AND id < ?))
        ORDER BY timestamp DESC, id DESC
        LIMIT ?
      ) ORDER BY timestamp ASC, id ASC
    `);

    this.getTimestampByIdStmt = db.prepare<[string], { timestamp: number }>(`
      SELECT timestamp FROM ${MESSAGES_TABLE} WHERE id = ?
    `);

    this.updateExtraStmt = db.prepare<[string, string]>(`
      UPDATE ${MESSAGES_TABLE} SET extra = ? WHERE id = ?
    `);

    // Session transcript: all messages tagged with a session_id, chronological.
    // Source: clowder-design-supplement.md 补充 E E3.3 (getTranscript composition).
    this.getBySessionStmt = db.prepare<[string], MessageRow>(`
      SELECT * FROM ${MESSAGES_TABLE}
      WHERE session_id = ?
      ORDER BY timestamp ASC, id ASC
    `);
  }

  /**
   * Append a message, generating its id. Returns the persisted {@link StoredMessage}.
   */
  async append(msg: Omit<StoredMessage, 'id'>): Promise<StoredMessage> {
    const id = this.generateId();
    const origin: StoredMessageOrigin = msg.origin ?? DEFAULT_ORIGIN;
    const mentions: AgentId[] = msg.mentions ?? [];
    const params: InsertParams = {
      id,
      thread_id: msg.threadId,
      user_id: msg.userId,
      agent_id: msg.agentId === null ? null : (msg.agentId as string),
      content: msg.content,
      mentions: JSON.stringify(mentions),
      origin,
      timestamp: msg.timestamp,
      extra: msg.extra === undefined ? null : JSON.stringify(msg.extra),
      session_id: msg.sessionId ?? null,
    };
    this.insertStmt.run(params);

    return {
      id,
      threadId: msg.threadId,
      userId: msg.userId,
      agentId: msg.agentId,
      content: msg.content,
      mentions: [...mentions],
      origin,
      timestamp: msg.timestamp,
      ...(msg.extra !== undefined ? { extra: { ...msg.extra } } : {}),
      ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}),
    };
  }

  /**
   * Return the most recent `limit` messages for a thread, in chronological order.
   */
  async getByThread(
    threadId: string,
    limit: number = DEFAULT_THREAD_LIMIT,
  ): Promise<StoredMessage[]> {
    const rows = this.getByThreadStmt.all(threadId, this.normalizeLimit(limit));
    return rows.map(rowToMessage);
  }

  /**
   * Return up to `limit` messages strictly older than `beforeId` in the same thread,
   * in chronological order. Returns [] if `beforeId` does not exist.
   */
  async getByThreadBefore(
    threadId: string,
    beforeId: string,
    limit: number = DEFAULT_THREAD_LIMIT,
  ): Promise<StoredMessage[]> {
    const cursor = this.getTimestampByIdStmt.get(beforeId);
    if (cursor === undefined) return [];
    const rows = this.getByThreadBeforeStmt.all(
      threadId,
      cursor.timestamp,
      cursor.timestamp,
      beforeId,
      this.normalizeLimit(limit),
    );
    return rows.map(rowToMessage);
  }

  /**
   * Return all messages tagged with `sessionId`, in chronological order.
   * Source: clowder-design-supplement.md 补充 E E3.3 — the message half of a
   * session transcript. Returns [] when the session has no tagged messages.
   */
  async getBySession(sessionId: string): Promise<StoredMessage[]> {
    return this.getBySessionStmt.all(sessionId).map(rowToMessage);
  }

  /**
   * Return a single message by id, or null if not found.
   */
  async getById(id: string): Promise<StoredMessage | null> {
    const row = this.getByIdStmt.get(id);
    return row === undefined ? null : rowToMessage(row);
  }

  /**
   * Replace the `extra` JSON bag for a message. No-op (silently) if id is unknown.
   */
  async updateExtra(id: string, extra: Record<string, unknown>): Promise<void> {
    this.updateExtraStmt.run(JSON.stringify(extra), id);
  }

  /**
   * Clamp a caller-supplied limit to a positive integer.
   * Non-positive / NaN limits collapse to the default page size.
   */
  private normalizeLimit(limit: number): number {
    if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_THREAD_LIMIT;
    return Math.floor(limit);
  }

  /**
   * Generate a unique, time-sortable message id.
   * Prefix with zero-padded epoch ms so lexical id order roughly tracks insertion order
   * (helps the (timestamp, id) tie-break stay intuitive), suffixed with a random segment.
   */
  private generateId(): string {
    const epoch = Date.now().toString().padStart(15, '0');
    const random = Math.random().toString(36).slice(2, 10);
    return `msg_${epoch}_${random}`;
  }
}

/**
 * Test/dev helper: build a store over a caller-provided Database with the schema migrated.
 * Production wiring injects a persistent Database per supplement D — this is only a
 * convenience for hermetic tests; the store itself still receives the Database.
 */
export function createMessageStore(db: Database): SqliteMessageStore {
  return new SqliteMessageStore(db);
}
