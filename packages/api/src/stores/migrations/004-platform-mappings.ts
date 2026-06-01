import type { Database } from 'better-sqlite3';

/**
 * Logical table name for the platform-mapping store (A10).
 * Named const (not inlined) so every statement references one source of truth.
 */
export const PLATFORM_MAPPINGS_TABLE = 'platform_mappings';

/**
 * Index for the reverse lookup getChannelId(adapterName, threadId): given an
 * internal id (+ adapter + type) find the platform id. The composite PK already
 * indexes (adapter_name, platform_id, type) for the forward path; this covers
 * the reverse (adapter_name, internal_id, type) path.
 */
export const PLATFORM_MAPPINGS_REVERSE_INDEX = 'idx_platform_mappings_reverse';

/**
 * Idempotently create the `platform_mappings` table and its reverse-lookup index.
 *
 * Schema maps 1:1 to clowder-design-supplement.md §A10: composite PK
 * (adapter_name, platform_id, type) so a given platform id resolves to exactly
 * one internal id per type; internal_id (the resolved thread/user id); type is
 * 'thread' | 'user'; created_at epoch ms. Columns map to the frozen M1
 * {@link PlatformMappingRecord} shape (packages/shared/src/types/platform.ts).
 *
 * Safe to call repeatedly (CREATE TABLE / INDEX IF NOT EXISTS) — mirrors the
 * idempotency pattern of migrations/002-threads.ts + 003-tool-events.ts.
 *
 * @param db injected better-sqlite3 Database (no global singleton — supplement D).
 */
export function createPlatformMappingsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${PLATFORM_MAPPINGS_TABLE} (
      adapter_name TEXT NOT NULL,
      platform_id TEXT NOT NULL,
      internal_id TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (adapter_name, platform_id, type)
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS ${PLATFORM_MAPPINGS_REVERSE_INDEX}
      ON ${PLATFORM_MAPPINGS_TABLE} (adapter_name, internal_id, type);
  `);
}
