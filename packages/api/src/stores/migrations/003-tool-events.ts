import type { Database } from 'better-sqlite3';

/**
 * Logical table name for the tool-event log.
 * Named const (not inlined) so every statement references one source of truth.
 */
export const TOOL_EVENTS_TABLE = 'tool_events';

/** Index for thread-scoped reads ordered along the timeline (readByThread). */
export const TOOL_EVENTS_THREAD_INDEX = 'idx_tool_events_thread';

/** Index for invocation-scoped reads (readByInvocation). */
export const TOOL_EVENTS_INVOCATION_INDEX = 'idx_tool_events_invocation';

/**
 * Index for session-scoped reads (readBySession — session transcript).
 * Source: clowder-design-supplement.md 补充 E E3.3. Ordered (session_id,
 * timestamp) so a session's tool events come back chronologically.
 */
export const TOOL_EVENTS_SESSION_INDEX = 'idx_tool_events_session';

/**
 * Idempotently create the `tool_events` table and its indexes.
 *
 * Schema maps 1:1 to clowder-design-supplement.md §A6 + 补充 E E3.3: id PK,
 * invocation_id, thread_id, agent_id, tool_name (NOT NULL), tool_input (JSON
 * TEXT, nullable), tool_result (TEXT, nullable), duration_ms (INTEGER, nullable —
 * unpaired tool_use has no duration yet), timestamp (epoch ms, NOT NULL),
 * session_id (nullable — tagged so events can be grouped into a session
 * transcript). Columns map to the frozen M1 StoredToolEvent shape
 * (packages/shared/src/types/tool-event.ts).
 *
 * Safe to call repeatedly (CREATE TABLE / INDEX IF NOT EXISTS); session_id is
 * added via a guarded ALTER so a pre-补充-E table gains it without data loss.
 *
 * @param db injected better-sqlite3 Database (no global singleton — supplement D).
 */
export function createToolEventsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TOOL_EVENTS_TABLE} (
      id TEXT PRIMARY KEY,
      invocation_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_input TEXT,
      tool_result TEXT,
      duration_ms INTEGER,
      timestamp INTEGER NOT NULL,
      session_id TEXT
    );
  `);

  addColumnIfMissing(db, TOOL_EVENTS_TABLE, 'session_id', 'TEXT');

  db.exec(`
    CREATE INDEX IF NOT EXISTS ${TOOL_EVENTS_THREAD_INDEX}
      ON ${TOOL_EVENTS_TABLE} (thread_id, timestamp);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS ${TOOL_EVENTS_INVOCATION_INDEX}
      ON ${TOOL_EVENTS_TABLE} (invocation_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS ${TOOL_EVENTS_SESSION_INDEX}
      ON ${TOOL_EVENTS_TABLE} (session_id, timestamp);
  `);
}

/** Raw row shape for a `PRAGMA table_info` lookup (typed; no `any`). */
interface ColumnInfoRow {
  readonly name: string;
}

/**
 * Add `column` to `table` if it is not already present. Idempotent: a no-op when
 * the column exists. SQLite has no `ADD COLUMN IF NOT EXISTS`, so we inspect
 * PRAGMA table_info first.
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
