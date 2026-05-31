// M5 SqliteToolEventLog — A6 IToolEventLog over SQLite.
//
// Source: clowder-design-supplement.md §A6. Persists one row per agent tool call
// (tool_use, optionally enriched with the paired tool_result's duration). Mirrors
// the message/thread store idioms: constructor injection of the Database (no
// global singleton — supplement D), idempotent migration in the ctor, prepared
// statements compiled once, a time-sortable generated id, and precise row typing
// (no `any`). agent_id is stored as the raw branded string and re-branded on read.

import type { Database } from 'better-sqlite3';
import type { IToolEventLog, StoredToolEvent } from '@clowder/shared';
import { createAgentId } from '@clowder/shared';
import { TOOL_EVENTS_TABLE, createToolEventsTable } from './migrations/003-tool-events.js';

/** Raw row shape for the `tool_events` table (precisely typed; no `any`). */
interface ToolEventRow {
  readonly id: string;
  readonly invocation_id: string;
  readonly thread_id: string;
  readonly agent_id: string;
  readonly tool_name: string;
  readonly tool_input: string | null;
  readonly tool_result: string | null;
  readonly duration_ms: number | null;
  readonly timestamp: number;
  readonly session_id: string | null;
}

/** Bind-parameter object for INSERT. Keys match the `@name` placeholders. */
interface InsertParams {
  readonly id: string;
  readonly invocation_id: string;
  readonly thread_id: string;
  readonly agent_id: string;
  readonly tool_name: string;
  readonly tool_input: string | null;
  readonly tool_result: string | null;
  readonly duration_ms: number | null;
  readonly timestamp: number;
  readonly session_id: string | null;
}

/** Map a raw DB row to an immutable {@link StoredToolEvent}. */
function rowToToolEvent(row: ToolEventRow): StoredToolEvent {
  return {
    id: row.id,
    invocationId: row.invocation_id,
    threadId: row.thread_id,
    agentId: createAgentId(row.agent_id),
    toolName: row.tool_name,
    ...(row.tool_input !== null ? { toolInput: row.tool_input } : {}),
    ...(row.tool_result !== null ? { toolResult: row.tool_result } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    timestamp: row.timestamp,
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
  };
}

/**
 * SQLite-backed tool-event log. Implements the A6 surface: append / readByThread
 * (timeline order) / readByInvocation (filtered by invocation). DI Database;
 * idempotent migration.
 */
export class SqliteToolEventLog implements IToolEventLog {
  private readonly insertStmt;
  private readonly byThreadStmt;
  private readonly byInvocationStmt;
  private readonly bySessionStmt;

  constructor(db: Database) {
    createToolEventsTable(db);

    this.insertStmt = db.prepare<InsertParams>(`
      INSERT INTO ${TOOL_EVENTS_TABLE}
        (id, invocation_id, thread_id, agent_id, tool_name, tool_input, tool_result, duration_ms, timestamp, session_id)
      VALUES
        (@id, @invocation_id, @thread_id, @agent_id, @tool_name, @tool_input, @tool_result, @duration_ms, @timestamp, @session_id)
    `);

    // Timeline order for a thread: timestamp asc (id break ties deterministically).
    this.byThreadStmt = db.prepare<[string], ToolEventRow>(`
      SELECT * FROM ${TOOL_EVENTS_TABLE}
      WHERE thread_id = ?
      ORDER BY timestamp ASC, id ASC
    `);

    this.byInvocationStmt = db.prepare<[string], ToolEventRow>(`
      SELECT * FROM ${TOOL_EVENTS_TABLE}
      WHERE invocation_id = ?
      ORDER BY timestamp ASC, id ASC
    `);

    // Session transcript: all tool events tagged with a session_id, chronological.
    // Source: clowder-design-supplement.md 补充 E E3.3 (getTranscript composition).
    this.bySessionStmt = db.prepare<[string], ToolEventRow>(`
      SELECT * FROM ${TOOL_EVENTS_TABLE}
      WHERE session_id = ?
      ORDER BY timestamp ASC, id ASC
    `);
  }

  /** Append one tool event, generating its id. Returns the persisted record. */
  async append(event: Omit<StoredToolEvent, 'id'>): Promise<StoredToolEvent> {
    const id = this.generateId();
    const params: InsertParams = {
      id,
      invocation_id: event.invocationId,
      thread_id: event.threadId,
      agent_id: event.agentId as string,
      tool_name: event.toolName,
      tool_input: event.toolInput ?? null,
      tool_result: event.toolResult ?? null,
      duration_ms: event.durationMs ?? null,
      timestamp: event.timestamp,
      session_id: event.sessionId ?? null,
    };
    this.insertStmt.run(params);

    return {
      id,
      invocationId: event.invocationId,
      threadId: event.threadId,
      agentId: event.agentId,
      toolName: event.toolName,
      ...(event.toolInput !== undefined ? { toolInput: event.toolInput } : {}),
      ...(event.toolResult !== undefined ? { toolResult: event.toolResult } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      timestamp: event.timestamp,
      ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
    };
  }

  /** All tool events for a thread, in timeline (ascending) order. */
  async readByThread(threadId: string): Promise<StoredToolEvent[]> {
    return this.byThreadStmt.all(threadId).map(rowToToolEvent);
  }

  /** All tool events for one invocation, in timeline (ascending) order. */
  async readByInvocation(invocationId: string): Promise<StoredToolEvent[]> {
    return this.byInvocationStmt.all(invocationId).map(rowToToolEvent);
  }

  /**
   * All tool events tagged with `sessionId`, in timeline (ascending) order.
   * Source: clowder-design-supplement.md 补充 E E3.3 — the tool-event half of a
   * session transcript. Returns [] when the session has no tagged events.
   */
  async readBySession(sessionId: string): Promise<StoredToolEvent[]> {
    return this.bySessionStmt.all(sessionId).map(rowToToolEvent);
  }

  /** Generate a unique, time-sortable tool-event id (mirrors the message-store idiom). */
  private generateId(): string {
    const epoch = Date.now().toString().padStart(15, '0');
    const random = Math.random().toString(36).slice(2, 10);
    return `tool_${epoch}_${random}`;
  }
}
