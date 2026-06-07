import type { Database } from 'better-sqlite3';

/**
 * Logical table name for the threads store.
 * Named const (not inlined) so every statement references one source of truth.
 */
export const THREADS_TABLE = 'threads';

/**
 * Index for listing threads newest-first (list() orders by last_active_at DESC).
 */
export const THREADS_ACTIVE_INDEX = 'idx_threads_last_active';

/**
 * Idempotently create the `threads` table.
 *
 * Schema maps 1:1 to OUR minimal frozen M1 Thread shape
 * (packages/shared/src/types/thread.ts §4.4) — NOT Clowder's 60-field Thread
 * (M8 deviation, progress.md): id PK, title (nullable), project_path (nullable),
 * created_at / last_active_at (epoch ms), participants (JSON array of AgentId),
 * sop_stage_id (nullable), thinking_mode ('debug' | 'play').
 *
 * Safe to call repeatedly (CREATE TABLE / INDEX IF NOT EXISTS).
 *
 * @param db injected better-sqlite3 Database (no global singleton — supplement D).
 */
export function createThreadsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${THREADS_TABLE} (
      id TEXT PRIMARY KEY,
      title TEXT,
      project_path TEXT,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      participants TEXT NOT NULL DEFAULT '[]',
      sop_stage_id TEXT,
      thinking_mode TEXT NOT NULL DEFAULT 'debug',
      routing_policy TEXT
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS ${THREADS_ACTIVE_INDEX}
      ON ${THREADS_TABLE} (last_active_at DESC);
  `);

  // F042: routing_policy added post-hoc; a guarded ALTER lets a pre-F042 db gain
  // it on next open without dropping data (SQLite has no ADD COLUMN IF NOT EXISTS).
  addColumnIfMissing(db, THREADS_TABLE, 'routing_policy', 'TEXT');
}

/** Raw row shape for a `PRAGMA table_info` lookup (typed; no `any`). */
interface ColumnInfoRow {
  readonly name: string;
}

/**
 * Add `column` to `table` if it is not already present. Idempotent: a no-op when
 * the column exists (so the migration is safe to re-run on an existing DB).
 */
function addColumnIfMissing(db: Database, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfoRow[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
}
