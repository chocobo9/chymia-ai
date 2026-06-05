// SqliteEventAuditLog — the append-only audit event log over SQLite.
//
// Ported from Clowder's EventAuditLog (an NDJSON file log) into our store idiom
// (mirrors SqliteToolEventLog): DI Database, idempotent migration in the ctor,
// prepared statements compiled once, a time-sortable generated id, precise row
// typing (no `any`). The engine calls `append` at lifecycle moments (invoked /
// responded / error / session_seal); the 审计事件 route reads `readByThread`.

import type { Database } from 'better-sqlite3';
import type { AuditEvent, AuditEventInput, IEventAuditLog } from '@choco/shared';
import { AUDIT_EVENTS_TABLE, createAuditEventsTable } from './migrations/005-audit-events.js';

/** Default cap on how many recent events `readByThread` returns. */
const DEFAULT_READ_LIMIT = 200;

/** Raw row shape for the `audit_events` table (precisely typed; no `any`). */
interface AuditEventRow {
  readonly id: string;
  readonly type: string;
  readonly thread_id: string;
  readonly timestamp: number;
  readonly data: string;
}

/** Bind-parameter object for INSERT (keys match the `@name` placeholders). */
interface InsertParams {
  readonly id: string;
  readonly type: string;
  readonly thread_id: string;
  readonly timestamp: number;
  readonly data: string;
}

/** Parse a row's JSON `data` back to a record, tolerating a corrupt cell. */
function parseData(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Map a raw DB row to an immutable {@link AuditEvent}. */
function rowToEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    type: row.type,
    threadId: row.thread_id,
    timestamp: row.timestamp,
    data: parseData(row.data),
  };
}

/**
 * SQLite-backed audit event log. Implements {@link IEventAuditLog}: append (mints
 * id + stamps timestamp) and readByThread (newest-first, bounded). DI Database +
 * clock; idempotent migration.
 */
export class SqliteEventAuditLog implements IEventAuditLog {
  private readonly insertStmt;
  private readonly byThreadStmt;
  private readonly now: () => number;

  constructor(db: Database, options?: { readonly now?: () => number }) {
    createAuditEventsTable(db);
    this.now = options?.now ?? Date.now;

    this.insertStmt = db.prepare<InsertParams>(`
      INSERT INTO ${AUDIT_EVENTS_TABLE} (id, type, thread_id, timestamp, data)
      VALUES (@id, @type, @thread_id, @timestamp, @data)
    `);

    // Newest-first for a thread (the trail reads most-recent at the top); id breaks
    // ties deterministically. LIMIT bounds the payload.
    this.byThreadStmt = db.prepare<[string, number], AuditEventRow>(`
      SELECT * FROM ${AUDIT_EVENTS_TABLE}
      WHERE thread_id = ?
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `);
  }

  /** Append one audit event, minting its id + stamping the time. Returns the record. */
  async append(input: AuditEventInput): Promise<AuditEvent> {
    const id = this.generateId();
    const timestamp = input.timestamp ?? this.now();
    const data = input.data ?? {};
    this.insertStmt.run({
      id,
      type: input.type,
      thread_id: input.threadId,
      timestamp,
      data: JSON.stringify(data),
    });
    return { id, type: input.type, threadId: input.threadId, timestamp, data };
  }

  /** A thread's audit events, newest-first, capped at `limit` (default 200). */
  async readByThread(
    threadId: string,
    options?: { readonly limit?: number },
  ): Promise<AuditEvent[]> {
    const limit = options?.limit ?? DEFAULT_READ_LIMIT;
    return this.byThreadStmt.all(threadId, limit).map(rowToEvent);
  }

  /** Generate a unique, time-sortable audit-event id (mirrors the tool-event idiom). */
  private generateId(): string {
    const epoch = Date.now().toString().padStart(15, '0');
    const random = Math.random().toString(36).slice(2, 10);
    return `audit_${epoch}_${random}`;
  }
}
