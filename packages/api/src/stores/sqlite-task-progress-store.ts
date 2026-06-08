// SqliteTaskProgressStore — the persistent backend for an agent's in-flight task
// snapshot (TodoWrite plan). Latest-snapshot-wins per (thread, agent): a new
// snapshot REPLACES the prior one (PK conflict → INSERT OR REPLACE), so the 任务
// tab shows the CURRENT plan, not an append log.
//
// Aligned to Clowder TaskProgressStore.setSnapshot/getThreadSnapshots. DELIBERATE
// DEVIATION: SQLite-persisted (Clowder Redis hash); follows the SAME store idiom
// as SqliteTaskStore (prepared statements, idempotent migration, DI Database).

import type { Database } from 'better-sqlite3';
import type { TaskProgressSnapshot } from '@choco/shared';
import { TASK_PROGRESS_TABLE, createTaskProgressTable } from './migrations/007-task-progress.js';

/** Raw row shape for the `task_progress` table. */
interface TaskProgressRow {
  readonly thread_id: string;
  readonly agent_id: string;
  readonly snapshot: string;
  readonly status: string;
  readonly invocation_id: string | null;
  readonly updated_at: number;
}

/** Bind-parameter object for the upsert. Keys match the `@name` placeholders. */
interface UpsertParams {
  readonly thread_id: string;
  readonly agent_id: string;
  readonly snapshot: string;
  readonly status: string;
  readonly invocation_id: string | null;
  readonly updated_at: number;
}

/**
 * SQLite-backed task-progress store. setSnapshot (latest-wins upsert) /
 * listByThread (newest-first) / deleteByThread (thread cascade). Idempotent
 * migration runs in the ctor (DI Database; no global singleton).
 */
export class SqliteTaskProgressStore {
  private readonly upsertStmt;
  private readonly listByThreadStmt;
  private readonly deleteByThreadStmt;

  constructor(db: Database) {
    createTaskProgressTable(db);

    // PK (thread_id, agent_id) → REPLACE keeps exactly one (latest) row per agent.
    this.upsertStmt = db.prepare<UpsertParams>(`
      INSERT OR REPLACE INTO ${TASK_PROGRESS_TABLE}
        (thread_id, agent_id, snapshot, status, invocation_id, updated_at)
      VALUES
        (@thread_id, @agent_id, @snapshot, @status, @invocation_id, @updated_at)
    `);

    this.listByThreadStmt = db.prepare<[string], TaskProgressRow>(`
      SELECT * FROM ${TASK_PROGRESS_TABLE} WHERE thread_id = ? ORDER BY updated_at DESC, agent_id ASC
    `);

    this.deleteByThreadStmt = db.prepare<[string]>(`DELETE FROM ${TASK_PROGRESS_TABLE} WHERE thread_id = ?`);
  }

  /** Upsert the latest snapshot for (thread, agent). */
  setSnapshot(snapshot: TaskProgressSnapshot): void {
    this.upsertStmt.run({
      thread_id: snapshot.threadId,
      agent_id: snapshot.agentId as string,
      snapshot: JSON.stringify(snapshot),
      status: snapshot.status,
      invocation_id: snapshot.lastInvocationId ?? null,
      updated_at: snapshot.updatedAt,
    });
  }

  /** List a thread's current per-agent snapshots, newest-first. */
  listByThread(threadId: string): TaskProgressSnapshot[] {
    return this.listByThreadStmt.all(threadId).map((r) => JSON.parse(r.snapshot) as TaskProgressSnapshot);
  }

  /** Delete every snapshot in a thread (the thread-delete cascade). Returns count. */
  deleteByThread(threadId: string): number {
    return this.deleteByThreadStmt.run(threadId).changes;
  }
}
