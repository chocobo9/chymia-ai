import type { Database } from 'better-sqlite3';

/**
 * Logical table name for the task-line store (任务线 / 毛线球).
 * Named const (not inlined) so every statement references one source of truth.
 */
export const TASKS_TABLE = 'tasks';

/**
 * Index for listing a thread's tasks (listByThread filters by thread_id, orders
 * by created_at). Matches the SqliteTaskStore read path.
 */
export const TASKS_THREAD_INDEX = 'idx_tasks_thread';

/**
 * Idempotently create the `tasks` table.
 *
 * Schema maps 1:1 to OUR minimal TaskItem (packages/shared/src/types/task.ts):
 * id PK, thread_id, title, why, status ('todo'|'doing'|'blocked'|'done'),
 * owner_cat_id (nullable AgentId), created_by ('user'|catId|'system'),
 * created_at / updated_at (epoch ms). DELIBERATELY NOT Clowder's #320 unified
 * shape (no kind/subject_key/automation_state) — that PR-tracking machinery is
 * out of scope (alignment note). Tasks are CASCADE-deleted with their thread
 * (see SqliteThreadStore.delete), mirroring the messages/tool-events cascade.
 *
 * Safe to call repeatedly (CREATE TABLE / INDEX IF NOT EXISTS).
 *
 * @param db injected better-sqlite3 Database (no global singleton — supplement D).
 */
export function createTasksTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TASKS_TABLE} (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      title TEXT NOT NULL,
      why TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo',
      owner_cat_id TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS ${TASKS_THREAD_INDEX}
      ON ${TASKS_TABLE} (thread_id, created_at);
  `);
}
