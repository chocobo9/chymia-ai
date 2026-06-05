import type { Database } from 'better-sqlite3';

/** Logical table name for the audit event log (one source of truth). */
export const AUDIT_EVENTS_TABLE = 'audit_events';

/** Index for thread-scoped reads ordered newest-first (readByThread). */
export const AUDIT_EVENTS_THREAD_INDEX = 'idx_audit_events_thread';

/**
 * Idempotently create the `audit_events` table + its index.
 *
 * Ported from Clowder's EventAuditLog (an append-only NDJSON log) into our SQLite
 * idiom: id PK, type (the event discriminator), thread_id, timestamp (epoch ms),
 * data (the event-specific payload as JSON TEXT). The (thread_id, timestamp) index
 * serves the per-thread, newest-first read the 审计事件 tab makes.
 *
 * @param db injected better-sqlite3 Database (no global singleton — supplement D).
 */
export function createAuditEventsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${AUDIT_EVENTS_TABLE} (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS ${AUDIT_EVENTS_THREAD_INDEX}
      ON ${AUDIT_EVENTS_TABLE} (thread_id, timestamp);
  `);
}
