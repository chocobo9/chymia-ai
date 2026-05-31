import type { Database } from 'better-sqlite3';

/**
 * Logical table name for the messages store.
 * Kept as a named const (not inlined) so every statement references one source of truth.
 */
export const MESSAGES_TABLE = 'messages';

/**
 * Composite index name for thread + timeline ordered lookups
 * (getByThread / getByThreadBefore both scan by thread_id then timestamp).
 */
export const MESSAGES_THREAD_INDEX = 'idx_messages_thread';

/**
 * Index name for session-scoped reads (getBySession — session transcript).
 * Source: clowder-design-supplement.md 补充 E E3.3 (transcript = messages tagged
 * with session_id). Ordered (session_id, timestamp) so a session's messages come
 * back in chronological order without a sort.
 */
export const MESSAGES_SESSION_INDEX = 'idx_messages_session';

/**
 * Idempotently create the `messages` table and its indexes.
 *
 * Schema mirrors clowder-design-supplement.md §A1 + 补充 E E3.3: id PK, thread_id,
 * user_id, agent_id (NULL = user-authored), content, mentions (JSON array of
 * AgentId), origin, timestamp (epoch ms), extra (JSON), session_id (NULL for user
 * messages; tagged on agent replies so they can be grouped into a session
 * transcript). Columns map 1:1 to the frozen M1 StoredMessage shape
 * (packages/shared/src/types/message.ts §4.3).
 *
 * Safe to call repeatedly (CREATE TABLE / INDEX IF NOT EXISTS); the session_id
 * column is added via a guarded ALTER so an already-created table (pre-补充-E)
 * gains it on next open without dropping data.
 *
 * @param db injected better-sqlite3 Database (no global singleton — see supplement D).
 */
export function createMessagesTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MESSAGES_TABLE} (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      agent_id TEXT,
      content TEXT NOT NULL,
      mentions TEXT NOT NULL DEFAULT '[]',
      origin TEXT NOT NULL DEFAULT 'user',
      timestamp INTEGER NOT NULL,
      extra TEXT,
      session_id TEXT
    );
  `);

  addColumnIfMissing(db, MESSAGES_TABLE, 'session_id', 'TEXT');

  db.exec(`
    CREATE INDEX IF NOT EXISTS ${MESSAGES_THREAD_INDEX}
      ON ${MESSAGES_TABLE} (thread_id, timestamp);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS ${MESSAGES_SESSION_INDEX}
      ON ${MESSAGES_TABLE} (session_id, timestamp);
  `);
}

/** Raw row shape for a `PRAGMA table_info` lookup (typed; no `any`). */
interface ColumnInfoRow {
  readonly name: string;
}

/**
 * Add `column` to `table` if it is not already present. Idempotent: a no-op when
 * the column exists (so the migration is safe to re-run on an existing DB).
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so we inspect PRAGMA table_info.
 */
function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  type: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfoRow[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
}
