// SqliteTaskStore — the persistent backend for task lines (任务线 / 任务).
//
// Aligned to Clowder reference/.../stores/ports/TaskStore.ts (ITaskStore +
// in-memory TaskStore). DELIBERATE DEVIATION: Clowder keeps tasks in a bounded
// in-memory Map (Redis later); choco persists to SQLite — a task line's whole
// point is surviving across conversations, and choco already persists
// thread/message/tool-event to SQLite, so tasks follow the SAME store idiom
// (prepared statements, injected clock, idempotent migration). The #320
// pr_tracking surface (kind/subjectKey/automationState/upsertBySubject) is
// dropped as out-of-scope (alignment note). Constructor injection only.

import type { Database } from 'better-sqlite3';
import type { AgentId, CreateTaskInput, TaskItem, TaskStatus, UpdateTaskInput } from '@choco/shared';
import { createAgentId } from '@choco/shared';
import { TASKS_TABLE, createTasksTable } from './migrations/006-tasks.js';

/** Valid task statuses (frozen union) — narrows the raw TEXT column. */
const STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'blocked', 'done'];

/** Clock injected for deterministic timestamps in tests; defaults to Date.now. */
export type NowFn = () => number;

/** Raw row shape for the `tasks` table (precisely typed; no `any`). */
interface TaskRow {
  readonly id: string;
  readonly thread_id: string;
  readonly title: string;
  readonly why: string;
  readonly status: string;
  readonly owner_cat_id: string | null;
  readonly created_by: string;
  readonly created_at: number;
  readonly updated_at: number;
}

/** Bind-parameter object for INSERT. Keys match the `@name` placeholders. */
interface InsertParams {
  readonly id: string;
  readonly thread_id: string;
  readonly title: string;
  readonly why: string;
  readonly status: string;
  readonly owner_cat_id: string | null;
  readonly created_by: string;
  readonly created_at: number;
  readonly updated_at: number;
}

function isStatus(value: string): value is TaskStatus {
  return (STATUSES as readonly string[]).includes(value);
}

/** createdBy is 'user' | 'system' | an AgentId; the union is preserved as-is. */
function rowToTask(row: TaskRow): TaskItem {
  const createdBy =
    row.created_by === 'user' || row.created_by === 'system'
      ? row.created_by
      : createAgentId(row.created_by);
  return {
    id: row.id,
    threadId: row.thread_id,
    title: row.title,
    why: row.why,
    status: isStatus(row.status) ? row.status : 'todo',
    ownerCatId: row.owner_cat_id !== null ? createAgentId(row.owner_cat_id) : null,
    createdBy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * SQLite-backed task store. Implements the surface the routes + snapshot
 * injection need: create / get / update / listByThread / delete / deleteByThread.
 * Idempotent migration runs in the ctor (DI Database; no global singleton).
 */
export class SqliteTaskStore {
  private readonly insertStmt;
  private readonly updateStmt;
  private readonly getStmt;
  private readonly listByThreadStmt;
  private readonly deleteStmt;
  private readonly deleteByThreadStmt;
  private readonly now: NowFn;

  constructor(db: Database, options?: { now?: NowFn }) {
    createTasksTable(db);
    this.now = options?.now ?? Date.now;

    this.insertStmt = db.prepare<InsertParams>(`
      INSERT INTO ${TASKS_TABLE}
        (id, thread_id, title, why, status, owner_cat_id, created_by, created_at, updated_at)
      VALUES
        (@id, @thread_id, @title, @why, @status, @owner_cat_id, @created_by, @created_at, @updated_at)
    `);

    // Only the mutable fields change on update (id/thread_id/created_by/created_at
    // are immutable). updated_at is always bumped.
    this.updateStmt = db.prepare<[string, string, string, string | null, number, string]>(`
      UPDATE ${TASKS_TABLE}
        SET title = ?, why = ?, status = ?, owner_cat_id = ?, updated_at = ?
      WHERE id = ?
    `);

    this.getStmt = db.prepare<[string], TaskRow>(`
      SELECT * FROM ${TASKS_TABLE} WHERE id = ?
    `);

    // Oldest-first within a thread (created order — matches the board's natural
    // reading order; the UI groups by status itself).
    this.listByThreadStmt = db.prepare<[string], TaskRow>(`
      SELECT * FROM ${TASKS_TABLE} WHERE thread_id = ? ORDER BY created_at ASC, id ASC
    `);

    this.deleteStmt = db.prepare<[string]>(`DELETE FROM ${TASKS_TABLE} WHERE id = ?`);
    this.deleteByThreadStmt = db.prepare<[string]>(`DELETE FROM ${TASKS_TABLE} WHERE thread_id = ?`);
  }

  /** Create a task (status starts 'todo'; timestamps stamped now). */
  async create(input: CreateTaskInput): Promise<TaskItem> {
    const ts = this.now();
    const ownerCatId: AgentId | null = input.ownerCatId ?? null;
    const task: TaskItem = {
      id: this.generateId(ts),
      threadId: input.threadId,
      title: input.title,
      why: input.why,
      status: 'todo',
      ownerCatId,
      createdBy: input.createdBy,
      createdAt: ts,
      updatedAt: ts,
    };
    this.insertStmt.run({
      id: task.id,
      thread_id: task.threadId,
      title: task.title,
      why: task.why,
      status: task.status,
      owner_cat_id: ownerCatId !== null ? (ownerCatId as string) : null,
      created_by: task.createdBy as string,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
    });
    return task;
  }

  /** Get a task by id, or null if unknown. */
  async get(taskId: string): Promise<TaskItem | null> {
    const row = this.getStmt.get(taskId);
    return row === undefined ? null : rowToTask(row);
  }

  /**
   * Apply a partial update — only provided fields change; updatedAt is bumped.
   * Returns the updated task, or null if the task is unknown. Built as a
   * read-modify-write over the frozen row so the immutable TaskItem is the single
   * source of truth (no per-field UPDATE statement drift).
   */
  async update(taskId: string, input: UpdateTaskInput): Promise<TaskItem | null> {
    const existing = await this.get(taskId);
    if (existing === null) return null;
    const updated: TaskItem = {
      ...existing,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.why !== undefined ? { why: input.why } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.ownerCatId !== undefined ? { ownerCatId: input.ownerCatId } : {}),
      updatedAt: this.now(),
    };
    this.updateStmt.run(
      updated.title,
      updated.why,
      updated.status,
      updated.ownerCatId !== null ? (updated.ownerCatId as string) : null,
      updated.updatedAt,
      updated.id,
    );
    return updated;
  }

  /** List a thread's tasks, oldest-first. */
  async listByThread(threadId: string): Promise<TaskItem[]> {
    return this.listByThreadStmt.all(threadId).map(rowToTask);
  }

  /** Delete a task by id. Returns true if a row was removed. */
  async delete(taskId: string): Promise<boolean> {
    return this.deleteStmt.run(taskId).changes > 0;
  }

  /** Delete every task in a thread (the thread-delete cascade). Returns the count. */
  async deleteByThread(threadId: string): Promise<number> {
    return this.deleteByThreadStmt.run(threadId).changes;
  }

  /** Generate a unique, time-sortable task id (mirrors the thread-store idiom). */
  private generateId(ts: number): string {
    const epoch = ts.toString().padStart(15, '0');
    const random = Math.random().toString(36).slice(2, 10);
    return `task_${epoch}_${random}`;
  }
}
