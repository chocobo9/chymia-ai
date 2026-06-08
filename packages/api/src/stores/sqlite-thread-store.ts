// M8 SqliteThreadStore — minimal A7 IThreadStore over SQLite.
//
// Deviation (Makima-approved, progress.md): A7 IThreadStore was defined but not
// in any module's file list; M8's thread-routes CRUD + auto-create-on-message +
// socket thread_update all need it. We implement the MINIMAL surface over OUR
// frozen M1 Thread (thread.ts §4.4) — deliberately NOT Clowder's 60-field Thread.
//
// WHY (research, from Clowder ThreadStore.ts port): the reference keeps an
// in-memory Map + LRU (Redis later) and exposes `ensureThread(threadId, title)`
// = create-if-missing / no-op-if-exists with createdBy='system'. We port only
// that idiom (the auto-create-on-message hook) and persist to SQLite so threads
// survive restart; the Map/LRU/Redis indirection is dropped as YAGNI (one
// backend). Constructor injection only (supplement D, no global singleton).

import type { Database } from 'better-sqlite3';
import type { AgentId, Thread, ThreadRoutingPolicyV1, ThreadThinkingMode } from '@choco/shared';
import { createAgentId } from '@choco/shared';
import { THREADS_TABLE, createThreadsTable } from './migrations/002-threads.js';
import { MESSAGES_TABLE, createMessagesTable } from './migrations/001-messages.js';
import { TOOL_EVENTS_TABLE, createToolEventsTable } from './migrations/003-tool-events.js';
import { TASKS_TABLE, createTasksTable } from './migrations/006-tasks.js';
import { TASK_PROGRESS_TABLE, createTaskProgressTable } from './migrations/007-task-progress.js';

/**
 * Default thinking mode for newly created threads.
 * Source: clowder-architecture-design.md §4.4 (Thread.thinkingMode default 'debug').
 */
const DEFAULT_THINKING_MODE: ThreadThinkingMode = 'debug';

/**
 * Default SOP stage for a newly created PROJECT thread (one with a projectPath).
 * Value 'kickoff' is the first stage id of sop/development.yaml (M12 告示牌).
 * Sanctioned by Makima for SOP-Cycle-1: project threads start at kickoff so the
 * SOP hint is populated from turn one; non-project threads get no stage (undefined).
 */
const DEFAULT_PROJECT_SOP_STAGE = 'kickoff';

/** Valid thinking modes (frozen M1 union) — narrows the raw TEXT column. */
const THINKING_MODES: readonly ThreadThinkingMode[] = ['debug', 'play'];

/** Raw row shape for the `threads` table (precisely typed; no `any`). */
interface ThreadRow {
  readonly id: string;
  readonly title: string | null;
  readonly project_path: string | null;
  readonly created_at: number;
  readonly last_active_at: number;
  readonly participants: string;
  readonly sop_stage_id: string | null;
  readonly thinking_mode: string;
  readonly routing_policy: string | null;
}

/** Bind-parameter object for INSERT. Keys match the `@name` placeholders. */
interface InsertParams {
  readonly id: string;
  readonly title: string | null;
  readonly project_path: string | null;
  readonly created_at: number;
  readonly last_active_at: number;
  readonly participants: string;
  readonly sop_stage_id: string | null;
  readonly thinking_mode: string;
  readonly routing_policy: string | null;
}

/** Clock injected for deterministic timestamps in tests; defaults to Date.now. */
export type NowFn = () => number;

/**
 * A thread participant plus its activity in that thread, used by the router's
 * participant-based fallback (Clowder getParticipantsWithActivity).
 * `messageCount` = how many messages this agent authored in the thread.
 *
 * NOTE: Clowder also carries `lastResponseHealthy` (a per-reply health flag set
 * by its vision-guard / error machinery). This repo has NO reply-health mechanism
 * yet, so the field is intentionally absent — the router treats absent as healthy
 * (Clowder: `lastResponseHealthy !== false`). When a reply-health signal is added
 * it should be surfaced here.
 */
export interface ParticipantActivity {
  readonly agentId: AgentId;
  readonly messageCount: number;
}

/** Options for creating a thread. All optional — a bare create() is valid. */
export interface CreateThreadInput {
  /** Pre-chosen id (e.g. for auto-create on a known threadId). Generated if absent. */
  readonly id?: string;
  readonly title?: string;
  readonly projectPath?: string;
  readonly thinkingMode?: ThreadThinkingMode;
  /**
   * Explicit SOP stage. When omitted AND `projectPath` is set, the thread
   * defaults to {@link DEFAULT_PROJECT_SOP_STAGE} (Makima-sanctioned, M12). A
   * non-project thread with no explicit stage stays unstaged (undefined).
   */
  readonly sopStageId?: string;
}

/**
 * Options for {@link SqliteThreadStore.list} (A7 signature). Both optional —
 * omitting them returns every thread (back-compat with callers that paginate in
 * the UI/route layer rather than the store).
 */
export interface ListThreadsOptions {
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Sentinel passed to SQLite LIMIT when the caller supplies an offset but no
 * limit. SQLite has no OFFSET-without-LIMIT form, so -1 = "no limit" lets a bare
 * offset still skip rows while returning the remaining tail.
 * Source: SQLite SELECT grammar (LIMIT -1 ⇒ unbounded).
 */
const NO_LIMIT = -1;

function isThinkingMode(value: string): value is ThreadThinkingMode {
  return (THINKING_MODES as readonly string[]).includes(value);
}

function parseParticipants(raw: string): AgentId[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) return [];
  const result: AgentId[] = [];
  for (const item of value) {
    if (typeof item === 'string') result.push(createAgentId(item));
  }
  return result;
}

/**
 * Parse a persisted routing policy (JSON or null). Defensive: corrupt JSON or a
 * non-v1 shape from external persistence is treated as "no policy" (returns
 * undefined) rather than throwing inside a get().
 */
function parseRoutingPolicy(raw: string | null): ThreadRoutingPolicyV1 | undefined {
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (value !== null && typeof value === 'object' && (value as { v?: unknown }).v === 1) {
      return value as ThreadRoutingPolicyV1;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function rowToThread(row: ThreadRow): Thread {
  const routingPolicy = parseRoutingPolicy(row.routing_policy);
  return {
    id: row.id,
    ...(row.title !== null ? { title: row.title } : {}),
    ...(row.project_path !== null ? { projectPath: row.project_path } : {}),
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    participants: parseParticipants(row.participants),
    ...(row.sop_stage_id !== null ? { sopStageId: row.sop_stage_id } : {}),
    thinkingMode: isThinkingMode(row.thinking_mode)
      ? row.thinking_mode
      : DEFAULT_THINKING_MODE,
    ...(routingPolicy !== undefined ? { routingPolicy } : {}),
  };
}

/**
 * SQLite-backed minimal thread store. Implements the A7 surface M8 needs:
 * create / get / list / updateLastActive / updateSopStage / updateTitle /
 * delete / ensureThread (auto-create-on-message). DI Database; idempotent migration.
 */
export class SqliteThreadStore {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly listStmt;
  private readonly updateLastActiveStmt;
  private readonly updateSopStageStmt;
  private readonly updateTitleStmt;
  private readonly updateParticipantsStmt;
  private readonly updateRoutingPolicyStmt;
  private readonly countAgentMessagesStmt;
  private readonly deleteStmt;
  private readonly deleteMessagesStmt;
  private readonly deleteToolEventsStmt;
  private readonly deleteTasksStmt;
  private readonly deleteTaskProgressStmt;
  private readonly deleteCascadeTxn: (threadId: string) => boolean;
  private readonly now: NowFn;

  constructor(db: Database, options?: { now?: NowFn }) {
    createThreadsTable(db);
    // delete() cascades into the sibling M5 tables, so they must exist even when
    // this store is constructed standalone (e.g. hermetic store tests). All three
    // migrations are idempotent (CREATE TABLE IF NOT EXISTS) — re-running is a no-op.
    createMessagesTable(db);
    createToolEventsTable(db);
    // Task lines are CASCADE-deleted with their thread (same orphan-free idiom);
    // ensure the table exists even when this store is constructed standalone.
    createTasksTable(db);
    // Task-progress snapshots cascade with their thread too (same orphan-free idiom).
    createTaskProgressTable(db);
    this.now = options?.now ?? Date.now;

    this.insertStmt = db.prepare<InsertParams>(`
      INSERT INTO ${THREADS_TABLE}
        (id, title, project_path, created_at, last_active_at, participants, sop_stage_id, thinking_mode, routing_policy)
      VALUES
        (@id, @title, @project_path, @created_at, @last_active_at, @participants, @sop_stage_id, @thinking_mode, @routing_policy)
    `);

    this.getStmt = db.prepare<[string], ThreadRow>(`
      SELECT * FROM ${THREADS_TABLE} WHERE id = ?
    `);

    // Newest-active first (matches the C6/sidebar ordering intent). LIMIT/OFFSET
    // are always bound: limit = -1 means unbounded (A7 pagination, verify "list 分页").
    this.listStmt = db.prepare<[number, number], ThreadRow>(`
      SELECT * FROM ${THREADS_TABLE}
      ORDER BY last_active_at DESC, id DESC
      LIMIT ? OFFSET ?
    `);

    this.updateLastActiveStmt = db.prepare<[number, string]>(`
      UPDATE ${THREADS_TABLE} SET last_active_at = ? WHERE id = ?
    `);

    this.updateSopStageStmt = db.prepare<[string | null, string]>(`
      UPDATE ${THREADS_TABLE} SET sop_stage_id = ? WHERE id = ?
    `);

    this.updateTitleStmt = db.prepare<[string, string]>(`
      UPDATE ${THREADS_TABLE} SET title = ? WHERE id = ?
    `);

    this.updateParticipantsStmt = db.prepare<[string, string]>(`
      UPDATE ${THREADS_TABLE} SET participants = ? WHERE id = ?
    `);

    this.updateRoutingPolicyStmt = db.prepare<[string | null, string]>(`
      UPDATE ${THREADS_TABLE} SET routing_policy = ? WHERE id = ?
    `);

    // Per-participant activity: how many messages an agent authored in a thread.
    // Backs getParticipantsWithActivity (the router's participant-based fallback).
    this.countAgentMessagesStmt = db.prepare<[string, string], { n: number }>(`
      SELECT COUNT(*) AS n FROM ${MESSAGES_TABLE} WHERE thread_id = ? AND agent_id = ?
    `);

    this.deleteStmt = db.prepare<[string]>(`
      DELETE FROM ${THREADS_TABLE} WHERE id = ?
    `);

    // Cascade sweep: a deleted thread leaves no orphan messages or tool events
    // (orchestrator decision). These reference the M5-owned sibling tables.
    this.deleteMessagesStmt = db.prepare<[string]>(`
      DELETE FROM ${MESSAGES_TABLE} WHERE thread_id = ?
    `);
    this.deleteToolEventsStmt = db.prepare<[string]>(`
      DELETE FROM ${TOOL_EVENTS_TABLE} WHERE thread_id = ?
    `);
    this.deleteTasksStmt = db.prepare<[string]>(`
      DELETE FROM ${TASKS_TABLE} WHERE thread_id = ?
    `);
    this.deleteTaskProgressStmt = db.prepare<[string]>(`
      DELETE FROM ${TASK_PROGRESS_TABLE} WHERE thread_id = ?
    `);

    // Wrap the deletes in one atomic transaction so a thread never ends up
    // half-deleted (its rows gone but the thread row remaining, or vice versa).
    // better-sqlite3's `transaction()` runs the body synchronously and returns
    // its result. Returns whether the thread row itself existed.
    this.deleteCascadeTxn = db.transaction((threadId: string): boolean => {
      this.deleteMessagesStmt.run(threadId);
      this.deleteToolEventsStmt.run(threadId);
      this.deleteTasksStmt.run(threadId);
      this.deleteTaskProgressStmt.run(threadId);
      return this.deleteStmt.run(threadId).changes > 0;
    });
  }

  /** Create a new thread (generating an id when none is supplied). */
  async create(input: CreateThreadInput = {}): Promise<Thread> {
    const ts = this.now();
    const id = input.id ?? this.generateId();
    // M12 告示牌: a project thread (has a projectPath) with no explicit stage
    // defaults to 'kickoff'; a non-project thread stays unstaged (undefined).
    const sopStageId =
      input.sopStageId ??
      (input.projectPath !== undefined ? DEFAULT_PROJECT_SOP_STAGE : undefined);
    const thread: Thread = {
      id,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.projectPath !== undefined ? { projectPath: input.projectPath } : {}),
      createdAt: ts,
      lastActiveAt: ts,
      participants: [],
      ...(sopStageId !== undefined ? { sopStageId } : {}),
      thinkingMode: input.thinkingMode ?? DEFAULT_THINKING_MODE,
    };
    this.insertRow(thread);
    return thread;
  }

  /** Get a thread by id, or null if unknown. */
  async get(threadId: string): Promise<Thread | null> {
    const row = this.getStmt.get(threadId);
    return row === undefined ? null : rowToThread(row);
  }

  /**
   * List threads, newest-active first. With no options, returns every thread
   * (back-compat). `limit` / `offset` apply SQL LIMIT/OFFSET for paginated reads
   * (A7 signature). A bare `offset` (no `limit`) still skips rows via LIMIT -1.
   */
  async list(options?: ListThreadsOptions): Promise<Thread[]> {
    const limit = this.normalizeLimit(options?.limit);
    const offset = this.normalizeOffset(options?.offset);
    return this.listStmt.all(limit, offset).map(rowToThread);
  }

  /** Stamp a thread's lastActiveAt to now. No-op if unknown. */
  async updateLastActive(threadId: string): Promise<void> {
    this.updateLastActiveStmt.run(this.now(), threadId);
  }

  /** Set (or clear, with null) a thread's SOP stage. No-op if unknown. */
  async updateSopStage(threadId: string, sopStageId: string | null): Promise<void> {
    this.updateSopStageStmt.run(sopStageId, threadId);
  }

  /** Set a thread's title. No-op if unknown. */
  async updateTitle(threadId: string, title: string): Promise<void> {
    this.updateTitleStmt.run(title, threadId);
  }

  /**
   * Set or clear a thread's routing policy (Clowder updateRoutingPolicy, F042).
   * A null / non-v1 / empty-scopes policy CLEARS it (stored NULL). No-op if the
   * thread is unknown (UPDATE matches no row).
   */
  async updateRoutingPolicy(
    threadId: string,
    policy: ThreadRoutingPolicyV1 | null,
  ): Promise<void> {
    const scopes = policy?.scopes;
    const hasScopes = scopes !== undefined && Object.keys(scopes).length > 0;
    const value = !policy || policy.v !== 1 || !hasScopes ? null : JSON.stringify(policy);
    this.updateRoutingPolicyStmt.run(value, threadId);
  }

  /**
   * Add agent ids to a thread's participant set (dedup'd). No-op if unknown.
   * Used after routing so the thread tracks which agents have participated.
   */
  async addParticipants(threadId: string, agentIds: readonly AgentId[]): Promise<void> {
    const existing = await this.get(threadId);
    if (existing === null) return;
    const merged = [...existing.participants];
    for (const id of agentIds) {
      if (!merged.includes(id)) merged.push(id);
    }
    this.updateParticipantsStmt.run(JSON.stringify(merged), threadId);
  }

  /**
   * Read a thread's participant ids (empty if the thread is unknown). Mirrors
   * Clowder IThreadStore.getParticipants — the read seam group mentions (@thread)
   * and the router's participant fallback build on.
   */
  async getParticipants(threadId: string): Promise<AgentId[]> {
    const thread = await this.get(threadId);
    return thread === null ? [] : thread.participants;
  }

  /**
   * Read each participant plus its in-thread activity (messageCount), for the
   * router's participant-based fallback (Clowder getParticipantsWithActivity).
   * Returns [] for an unknown thread. `lastResponseHealthy` is omitted — this
   * repo has no reply-health signal yet (see {@link ParticipantActivity}).
   */
  async getParticipantsWithActivity(threadId: string): Promise<ParticipantActivity[]> {
    const thread = await this.get(threadId);
    if (thread === null) return [];
    return thread.participants.map((agentId) => ({
      agentId,
      messageCount: this.countAgentMessagesStmt.get(threadId, agentId as string)?.n ?? 0,
    }));
  }

  /**
   * Delete a thread and CASCADE its rows: in one transaction, remove the
   * thread's messages and tool events, then the thread row. Returns true if the
   * thread itself existed (a row was removed). Orphan-free by construction
   * (orchestrator decision; verify "级联删消息").
   */
  async delete(threadId: string): Promise<boolean> {
    return this.deleteCascadeTxn(threadId);
  }

  /**
   * Ensure a thread with a specific id exists: create-if-missing / no-op-if-exists.
   * This is the auto-create-on-message hook (ported idiom from Clowder
   * ThreadStore.ensureThread). Returns the existing or newly created thread.
   */
  async ensureThread(threadId: string, title: string): Promise<Thread> {
    const existing = await this.get(threadId);
    if (existing !== null) return existing;

    const ts = this.now();
    const thread: Thread = {
      id: threadId,
      title,
      createdAt: ts,
      lastActiveAt: ts,
      participants: [],
      thinkingMode: DEFAULT_THINKING_MODE,
    };
    this.insertRow(thread);
    return thread;
  }

  private insertRow(thread: Thread): void {
    const params: InsertParams = {
      id: thread.id,
      title: thread.title ?? null,
      project_path: thread.projectPath ?? null,
      created_at: thread.createdAt,
      last_active_at: thread.lastActiveAt,
      participants: JSON.stringify(thread.participants),
      sop_stage_id: thread.sopStageId ?? null,
      thinking_mode: thread.thinkingMode,
      routing_policy: thread.routingPolicy ? JSON.stringify(thread.routingPolicy) : null,
    };
    this.insertStmt.run(params);
  }

  /**
   * Normalize a caller-supplied limit for the LIMIT clause. An absent/NaN/
   * non-positive limit collapses to {@link NO_LIMIT} (-1 ⇒ unbounded), so list()
   * with no args (or with only an offset) still returns the remaining rows.
   */
  private normalizeLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return NO_LIMIT;
    return Math.floor(limit);
  }

  /** Normalize a caller-supplied offset. Absent/NaN/negative collapses to 0. */
  private normalizeOffset(offset: number | undefined): number {
    if (offset === undefined || !Number.isFinite(offset) || offset <= 0) return 0;
    return Math.floor(offset);
  }

  /** Generate a unique, time-sortable thread id (mirrors the message-store idiom). */
  private generateId(): string {
    const epoch = this.now().toString().padStart(15, '0');
    const random = Math.random().toString(36).slice(2, 10);
    return `thread_${epoch}_${random}`;
  }
}
