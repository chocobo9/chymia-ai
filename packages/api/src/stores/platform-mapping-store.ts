// G4 SqlitePlatformMappingStore — A10 IPlatformMappingStore over SQLite.
//
// Source: clowder-design-supplement.md §A10. resolveThread/resolveUser are
// find-or-create: the FIRST time an adapter reports a platform channelId/userId
// we mint a stable internal id and persist the mapping; subsequent calls return
// the same internal id (so one platform conversation always maps to one thread).
// getChannelId is the reverse path an adapter uses to deliver a thread's replies
// back to the right platform conversation.
//
// Shared by M13 (WeChat) + M14 (Telegram): both resolve through this one store
// so the two adapters never diverge on id assignment. Constructor injection only
// (supplement D, no global singleton); idempotent migration runs in the ctor —
// mirrors the SqliteThreadStore DI pattern.

import type { Database } from 'better-sqlite3';
import type {
  IPlatformMappingStore,
  PlatformMappingType,
} from '@clowder/shared';
import {
  PLATFORM_MAPPINGS_TABLE,
  createPlatformMappingsTable,
} from './migrations/004-platform-mappings.js';

/** Clock injected for deterministic created_at in tests; defaults to Date.now. */
export type NowFn = () => number;

/** Mapping type discriminators (the §A10 `type` column values). */
const MAPPING_TYPE_THREAD: PlatformMappingType = 'thread';
const MAPPING_TYPE_USER: PlatformMappingType = 'user';

/** Raw row shape for a forward lookup (typed; no `any`). */
interface InternalIdRow {
  readonly internal_id: string;
}

/** Raw row shape for the reverse lookup (typed; no `any`). */
interface PlatformIdRow {
  readonly platform_id: string;
}

/** Bind-parameter object for INSERT. Keys match the `@name` placeholders. */
interface InsertParams {
  readonly adapter_name: string;
  readonly platform_id: string;
  readonly internal_id: string;
  readonly type: PlatformMappingType;
  readonly created_at: number;
}

/**
 * SQLite-backed A10 platform-mapping store. Implements resolveThread /
 * resolveUser (find-or-create) + getChannelId (reverse lookup). DI Database;
 * idempotent migration in the ctor.
 */
export class SqlitePlatformMappingStore implements IPlatformMappingStore {
  private readonly forwardStmt;
  private readonly reverseStmt;
  private readonly insertStmt;
  private readonly now: NowFn;
  /** Wrap forward-lookup + conditional insert in one atomic find-or-create txn. */
  private readonly resolveTxn: (
    adapterName: string,
    platformId: string,
    type: PlatformMappingType,
    internalId: string,
  ) => string;

  constructor(db: Database, options?: { now?: NowFn }) {
    createPlatformMappingsTable(db);
    this.now = options?.now ?? Date.now;

    this.forwardStmt = db.prepare<[string, string, string], InternalIdRow>(`
      SELECT internal_id FROM ${PLATFORM_MAPPINGS_TABLE}
      WHERE adapter_name = ? AND platform_id = ? AND type = ?
    `);

    this.reverseStmt = db.prepare<[string, string, string], PlatformIdRow>(`
      SELECT platform_id FROM ${PLATFORM_MAPPINGS_TABLE}
      WHERE adapter_name = ? AND internal_id = ? AND type = ?
    `);

    this.insertStmt = db.prepare<InsertParams>(`
      INSERT INTO ${PLATFORM_MAPPINGS_TABLE}
        (adapter_name, platform_id, internal_id, type, created_at)
      VALUES
        (@adapter_name, @platform_id, @internal_id, @type, @created_at)
    `);

    // find-or-create under one transaction: re-check inside the txn so two
    // concurrent resolves for the same platform id can't both insert (the second
    // sees the first's row). Returns the winning internal id.
    this.resolveTxn = db.transaction(
      (
        adapterName: string,
        platformId: string,
        type: PlatformMappingType,
        candidateInternalId: string,
      ): string => {
        const existing = this.forwardStmt.get(adapterName, platformId, type);
        if (existing !== undefined) return existing.internal_id;
        const params: InsertParams = {
          adapter_name: adapterName,
          platform_id: platformId,
          internal_id: candidateInternalId,
          type,
          created_at: this.now(),
        };
        this.insertStmt.run(params);
        return candidateInternalId;
      },
    );
  }

  /** Resolve a platform conversation to an internal threadId (find-or-create). */
  async resolveThread(adapterName: string, channelId: string): Promise<string> {
    return this.resolveTxn(
      adapterName,
      channelId,
      MAPPING_TYPE_THREAD,
      this.generateId('thread', adapterName),
    );
  }

  /** Resolve a platform user to an internal userId (find-or-create). */
  async resolveUser(adapterName: string, platformUserId: string): Promise<string> {
    return this.resolveTxn(
      adapterName,
      platformUserId,
      MAPPING_TYPE_USER,
      this.generateId('user', adapterName),
    );
  }

  /** Reverse lookup: internal threadId → platform channelId, or null if unmapped. */
  async getChannelId(adapterName: string, threadId: string): Promise<string | null> {
    const row = this.reverseStmt.get(adapterName, threadId, MAPPING_TYPE_THREAD);
    return row === undefined ? null : row.platform_id;
  }

  /**
   * Generate a unique, time-sortable internal id, namespaced by kind + adapter so
   * platform-originated ids never collide with web-originated thread ids and are
   * recognizable in storage (mirrors the SqliteThreadStore id idiom).
   */
  private generateId(kind: 'thread' | 'user', adapterName: string): string {
    const epoch = this.now().toString().padStart(15, '0');
    const random = Math.random().toString(36).slice(2, 10);
    return `${kind}_${adapterName}_${epoch}_${random}`;
  }
}
