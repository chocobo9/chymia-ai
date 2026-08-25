import type { Database } from 'better-sqlite3';

/**
 * Logical table name for the task-progress store (an agent's in-flight TodoWrite
 * snapshot). Named const (not inlined) so every statement references one source.
 */
export const TASK_PROGRESS_TABLE = 'task_progress';

/**
 * Idempotently create `task_progress` — the LATEST in-flight task snapshot per
 * (thread, agent). PK (thread_id, agent_id) makes a new snapshot REPLACE the old
 * one (latest-wins, NOT append): the tab shows the current plan, not history.
 * `snapshot` holds the JSON-serialized TaskProgressSnapshot (the full object, so
 * read is a single parse). Cascade-deleted with its thread (SqliteThreadStore
 * delete), mirroring the tasks/messages/tool-events cascade.
 *
 * Safe to call repeatedly (CREATE TABLE IF NOT EXISTS).
 *
 * @param db injected better-sqlite3 Database (no global singleton — supplement D).
 */
export function createTaskProgressTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TASK_PROGRESS_TABLE} (
      thread_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      status TEXT NOT NULL,
      invocation_id TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, agent_id)
    );
  `);
}
