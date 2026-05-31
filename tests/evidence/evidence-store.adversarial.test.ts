/**
 * M6 QA — Evidence Store adversarial tests (written by QA subagent, dev≠QA per
 * CLAUDE.md §0.5.3).
 *
 * Covers: idempotency / duplicate upsert, batch-volume upsert (no lock error),
 * embedding dimension mismatch, entity alias resolution, edge bidirectionality.
 * Real technical Chinese+English evidence; deterministic hand-set embeddings.
 *
 * Design refs: clowder-architecture-design.md §5.3 (IEvidenceStore) / §7.6.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import type { EvidenceItem, EntityRecord, EvidenceEdge } from '@clowder/shared';
import { SqliteEvidenceStore } from '@clowder/api/evidence/sqlite-evidence-store';

// vec0 table dimension is fixed (default 384) by the first embedding.
const EMBEDDING_DIM = 384;

function makeStoreWithDb(): {
  store: SqliteEvidenceStore;
  db: BetterSqliteDatabase;
} {
  const db = new Database(':memory:');
  const store = new SqliteEvidenceStore(db);
  return { store, db };
}

function item(
  anchor: string,
  title: string,
  summary: string,
  extra?: Partial<EvidenceItem>,
): EvidenceItem {
  return {
    anchor,
    kind: 'lesson',
    status: 'active',
    title,
    summary,
    updatedAt: '2026-05-30T08:00:00.000Z',
    ...extra,
  };
}

function unitVector(hotIndex: number): number[] {
  return new Array(EMBEDDING_DIM).fill(0).map((_, i) => (i === hotIndex ? 1 : 0));
}

describe('M6 adversarial — idempotency & duplicate upsert', () => {
  let store: SqliteEvidenceStore;
  let db: BetterSqliteDatabase;

  beforeEach(() => {
    const made = makeStoreWithDb();
    store = made.store;
    db = made.db;
  });

  afterEach(() => {
    db.close();
  });

  it('duplicate-anchor upsert updates in place: getByAnchor reflects the latest body', () => {
    store.upsert(
      item('ev:update:001', 'API server 框架（初版）', '初版决定 API server 选用 Express 框架。'),
    );
    store.upsert(
      item(
        'ev:update:001',
        'API server 框架（修订）',
        '修订决定 API server 改用 Fastify 框架以提升吞吐。',
      ),
    );
    const got = store.getByAnchor('ev:update:001');
    expect(got).not.toBeNull();
    expect(got!.summary).toContain('Fastify');
    expect(got!.summary).not.toContain('Express');
  });

  it('duplicate-anchor upsert keeps a single evidence row and a stable lexical count', () => {
    store.upsert(
      item('ev:update:002', 'NDJSON 流式', '流式响应使用 NDJSON 逐行聚合多 agent 输出。', {
        keywords: ['NDJSON'],
      }),
    );
    store.upsert(
      item('ev:update:002', 'NDJSON 流式', '流式响应使用 NDJSON 协议逐行聚合输出片段。', {
        keywords: ['NDJSON'],
      }),
    );
    store.upsert(
      item('ev:update:002', 'NDJSON 流式', '流式响应使用 NDJSON 编码逐行合并 agent 片段。', {
        keywords: ['NDJSON'],
      }),
    );

    const evCount = db
      .prepare('SELECT COUNT(*) AS c FROM evidence')
      .get() as { c: number };
    expect(evCount.c).toBe(1);

    const ftsCount = db
      .prepare('SELECT COUNT(*) AS c FROM evidence_fts')
      .get() as { c: number };
    expect(ftsCount.c).toBe(1);

    const result = store.search('NDJSON', { mode: 'lexical' });
    expect(result.items.filter((i) => i.anchor === 'ev:update:002')).toHaveLength(1);
  });
});

describe('M6 adversarial — batch upsert volume', () => {
  let store: SqliteEvidenceStore;
  let db: BetterSqliteDatabase;

  beforeEach(() => {
    const made = makeStoreWithDb();
    store = made.store;
    db = made.db;
  });

  afterEach(() => {
    db.close();
  });

  it('100 sequential upserts succeed with no lock error and all are retrievable', () => {
    const total = 100;
    expect(() => {
      for (let n = 0; n < total; n++) {
        const id = String(n).padStart(3, '0');
        store.upsert(
          item(
            `ev:batch:${id}`,
            `分布式追踪条目 ${n}`,
            `第 ${n} 条证据：分布式追踪通过 trace id 关联跨 agent 调用链。`,
            { keywords: ['分布式追踪'] },
          ),
        );
      }
    }).not.toThrow();

    for (let n = 0; n < total; n++) {
      const id = String(n).padStart(3, '0');
      expect(store.getByAnchor(`ev:batch:${id}`)).not.toBeNull();
    }

    const result = store.search('分布式追踪', { mode: 'lexical', limit: total });
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('100 embeddings then a semantic query returns anchors entirely from this batch', () => {
    const total = 100;
    for (let n = 0; n < total; n++) {
      const id = String(n).padStart(3, '0');
      store.upsert(
        item(
          `ev:emb:${id}`,
          `向量检索召回 ${n}`,
          `第 ${n} 条：向量检索的召回质量取决于 embedding 模型的语义表达。`,
          { keywords: ['向量检索'] },
        ),
      );
      // Distinct hot index per row → distinguishable deterministic vectors.
      store.upsertEmbedding(`ev:emb:${id}`, unitVector(n % EMBEDDING_DIM));
    }
    const result = store.search('向量检索', { mode: 'semantic', limit: 5 });
    expect(result.meta.effectiveMode).toBe('semantic');
    expect(result.items.length).toBeGreaterThan(0);
    for (const it of result.items) {
      expect(it.anchor.startsWith('ev:emb:')).toBe(true);
    }
  });
});

describe('M6 adversarial — embedding dimension mismatch', () => {
  let store: SqliteEvidenceStore;
  let db: BetterSqliteDatabase;

  beforeEach(() => {
    const made = makeStoreWithDb();
    store = made.store;
    db = made.db;
  });

  afterEach(() => {
    db.close();
  });

  it('an embedding shorter than the established dim throws clearly and does not corrupt the vec table', () => {
    store.upsert(item('ev:dim:001', 'API 契约', 'API 设计需要稳定的版本化契约。'));
    store.upsertEmbedding('ev:dim:001', unitVector(0)); // establishes 384

    store.upsert(item('ev:dim:002', 'API 网关', 'API 网关负责鉴权与限流。'));
    expect(() => {
      store.upsertEmbedding('ev:dim:002', [1, 0, 0, 1]); // 4-dim, mismatched
    }).toThrow(/does not match table dimension/i);

    // Uncorrupted: still only the first row's vector is stored.
    const vecCount = db
      .prepare('SELECT COUNT(*) AS c FROM evidence_vec')
      .get() as { c: number };
    expect(vecCount.c).toBe(1);
  });

  it('an embedding longer than the established dim throws clearly', () => {
    store.upsert(item('ev:dim:003', '消息存储', '消息存储使用 better-sqlite3 持久化。'));
    store.upsertEmbedding('ev:dim:003', unitVector(0)); // 384

    store.upsert(item('ev:dim:004', '消息分页', '消息存储支持按会话分页查询。'));
    const tooLong = new Array(EMBEDDING_DIM + 1).fill(0);
    expect(() => {
      store.upsertEmbedding('ev:dim:004', tooLong);
    }).toThrow(/does not match table dimension/i);
  });

  it('upsertEmbedding for an unknown anchor throws and creates no vec row', () => {
    expect(() => {
      store.upsertEmbedding('ev:nonexistent:999', unitVector(0));
    }).toThrow(/unknown anchor/i);
    // No table/row was created (no embedding ever established).
    const exists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='evidence_vec'")
      .get() as { name: string } | undefined;
    if (exists) {
      const vecCount = db
        .prepare('SELECT COUNT(*) AS c FROM evidence_vec')
        .get() as { c: number };
      expect(vecCount.c).toBe(0);
    } else {
      expect(exists).toBeUndefined();
    }
  });
});

describe('M6 adversarial — entity alias resolution', () => {
  let store: SqliteEvidenceStore;
  let db: BetterSqliteDatabase;

  beforeEach(() => {
    const made = makeStoreWithDb();
    store = made.store;
    db = made.db;
  });

  afterEach(() => {
    db.close();
  });

  it('resolves by canonicalName and by alias, case-insensitively', () => {
    const entity: EntityRecord = {
      entityId: 'concept:postgresql',
      type: 'concept',
      canonicalName: 'PostgreSQL',
      aliases: ['Postgres', 'pg'],
      updatedAt: '2026-05-30T08:00:00.000Z',
    };
    store.upsertEntity(entity);

    expect(store.resolveEntity('PostgreSQL')?.canonicalName).toBe('PostgreSQL');
    expect(store.resolveEntity('postgresql')?.canonicalName).toBe('PostgreSQL');
    expect(store.resolveEntity('Postgres')?.canonicalName).toBe('PostgreSQL');
    expect(store.resolveEntity('PG')?.canonicalName).toBe('PostgreSQL');
  });

  it('returns null for an unknown name or alias and for an empty string', () => {
    store.upsertEntity({
      entityId: 'concept:fastify',
      type: 'concept',
      canonicalName: 'Fastify',
      aliases: ['fastify-server'],
      updatedAt: '2026-05-30T08:00:00.000Z',
    });
    expect(store.resolveEntity('Koa')).toBeNull();
    expect(store.resolveEntity('')).toBeNull();
  });

  it('re-upserting an entity updates its aliases in place', () => {
    store.upsertEntity({
      entityId: 'concept:sqlite-vec',
      type: 'concept',
      canonicalName: 'sqlite-vec',
      aliases: ['vec0'],
      updatedAt: '2026-05-30T08:00:00.000Z',
    });
    store.upsertEntity({
      entityId: 'concept:sqlite-vec',
      type: 'concept',
      canonicalName: 'sqlite-vec',
      aliases: ['vec0', 'sqlitevec'],
      updatedAt: '2026-05-30T09:00:00.000Z',
    });
    expect(store.resolveEntity('sqlitevec')?.canonicalName).toBe('sqlite-vec');
    expect(store.resolveEntity('vec0')?.canonicalName).toBe('sqlite-vec');

    // Single physical row (updated in place, not duplicated).
    const count = db
      .prepare('SELECT COUNT(*) AS c FROM entities')
      .get() as { c: number };
    expect(count.c).toBe(1);
  });
});

describe('M6 adversarial — edges (bidirectional)', () => {
  let store: SqliteEvidenceStore;
  let db: BetterSqliteDatabase;

  beforeEach(() => {
    const made = makeStoreWithDb();
    store = made.store;
    db = made.db;
  });

  afterEach(() => {
    db.close();
  });

  it('getEdges returns edges where the anchor is the source (fromAnchor)', () => {
    const edge: EvidenceEdge = {
      fromAnchor: 'ev:db-choice:001',
      toAnchor: 'ev:vec-search:001',
      relation: 'related',
      createdAt: '2026-05-30T08:00:00.000Z',
    };
    store.upsertEdge(edge);
    const edges = store.getEdges('ev:db-choice:001');
    expect(edges).toHaveLength(1);
    expect(edges[0].toAnchor).toBe('ev:vec-search:001');
    expect(edges[0].relation).toBe('related');
  });

  it('getEdges returns edges where the anchor is the target (toAnchor)', () => {
    store.upsertEdge({
      fromAnchor: 'ev:db-choice:001',
      toAnchor: 'ev:vec-search:001',
      relation: 'related',
      createdAt: '2026-05-30T08:00:00.000Z',
    });
    const edges = store.getEdges('ev:vec-search:001');
    expect(edges).toHaveLength(1);
    expect(edges[0].fromAnchor).toBe('ev:db-choice:001');
  });

  it('getEdges returns edges from both directions for a hub anchor', () => {
    store.upsertEdge({
      fromAnchor: 'ev:hub:001',
      toAnchor: 'ev:leaf:a',
      relation: 'supersedes',
      createdAt: '2026-05-30T08:00:00.000Z',
    });
    store.upsertEdge({
      fromAnchor: 'ev:leaf:b',
      toAnchor: 'ev:hub:001',
      relation: 'blocked_by',
      createdAt: '2026-05-30T08:01:00.000Z',
    });
    const edges = store.getEdges('ev:hub:001');
    expect(edges).toHaveLength(2);
    const relations = edges.map((e) => e.relation).sort();
    expect(relations).toEqual(['blocked_by', 'supersedes']);
  });

  it('duplicate edge (same from/to/relation) updates in place, not duplicated', () => {
    store.upsertEdge({
      fromAnchor: 'ev:a',
      toAnchor: 'ev:b',
      relation: 'related',
      createdAt: '2026-05-30T08:00:00.000Z',
    });
    store.upsertEdge({
      fromAnchor: 'ev:a',
      toAnchor: 'ev:b',
      relation: 'related',
      createdAt: '2026-05-30T09:00:00.000Z',
    });
    const edges = store.getEdges('ev:a');
    expect(edges).toHaveLength(1);
    expect(edges[0].createdAt).toBe('2026-05-30T09:00:00.000Z');
  });

  it('getEdges returns an empty array for an anchor with no edges', () => {
    expect(store.getEdges('ev:isolated:001')).toEqual([]);
  });
});
