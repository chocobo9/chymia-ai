/**
 * M6 QA — Evidence Store edge tests (written by QA subagent, dev≠QA per CLAUDE.md §0.5.3).
 *
 * Covers: rowid-fix regression guard, jieba lexical boundaries, hybrid RRF
 * fusion / degradation. Real technical Chinese+English evidence throughout;
 * the semantic path uses deterministic hand-set embedding vectors (never random).
 *
 * Design refs: clowder-architecture-design.md §5.3 (IEvidenceStore) / §7.6
 * (FTS5 BM25 + vec KNN + RRF). Frozen M1 type: EvidenceItem (anchor-based).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import type { EvidenceItem, EvidenceSearchResult } from '@clowder/shared';
import { SqliteEvidenceStore } from '@clowder/api/evidence/sqlite-evidence-store';

// The vec0 table dimension is fixed by the first embedding's length (default
// 384). Within a single test DB every embedding must share this dimension.
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
    kind: 'decision',
    status: 'active',
    title,
    summary,
    updatedAt: '2026-05-30T08:00:00.000Z',
    ...extra,
  };
}

// Deterministic unit basis vector: 1 at `hotIndex`, 0 elsewhere. Gives a
// controllable, repeatable KNN ordering without any randomness.
function unitVector(hotIndex: number): number[] {
  return new Array(EMBEDDING_DIM).fill(0).map((_, i) => (i === hotIndex ? 1 : 0));
}

describe('M6 edge — rowid fix regression guard', () => {
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

  it('semantic query returns the embedded anchor with no SqliteError (BigInt rowid mapped back)', () => {
    store.upsert(
      item(
        'ev:vec-search:001',
        '向量检索方案',
        '向量检索通过 sqlite-vec 的 vec0 虚拟表实现近似最近邻搜索。',
        { keywords: ['向量检索', 'sqlite-vec'] },
      ),
    );
    store.upsertEmbedding('ev:vec-search:001', unitVector(0));

    let result: EvidenceSearchResult | null = null;
    expect(() => {
      result = store.search('向量检索', { mode: 'semantic' });
    }).not.toThrow();
    expect(result).not.toBeNull();
    expect(result!.meta.effectiveMode).toBe('semantic');
    expect(result!.items.map((i) => i.anchor)).toContain('ev:vec-search:001');
  });

  it('hybrid query with an embedding returns the anchor, mode hybrid, not degraded', () => {
    store.upsert(
      item(
        'ev:rrf:001',
        '混合检索融合',
        '混合检索把 FTS5 词法路与向量语义路通过 RRF 融合并去重。',
        { keywords: ['混合检索', 'RRF'] },
      ),
    );
    store.upsertEmbedding('ev:rrf:001', unitVector(1));

    const result = store.search('混合检索', { mode: 'hybrid' });
    expect(result.meta.effectiveMode).toBe('hybrid');
    expect(result.meta.degraded).toBe(false);
    expect(result.items.map((i) => i.anchor)).toContain('ev:rrf:001');
  });

  it('re-upserting the same anchor then embedding yields exactly one vec row and one result', () => {
    store.upsert(
      item(
        'ev:dup:001',
        'better-sqlite3 同步 API',
        'better-sqlite3 采用同步阻塞 API 适合嵌入式部署。',
        { keywords: ['better-sqlite3'] },
      ),
    );
    store.upsert(
      item(
        'ev:dup:001',
        'better-sqlite3 同步 API（修订）',
        'better-sqlite3 采用同步阻塞 API 适合嵌入式部署场景。',
        { keywords: ['better-sqlite3'] },
      ),
    );
    store.upsertEmbedding('ev:dup:001', unitVector(2));
    store.upsertEmbedding('ev:dup:001', unitVector(2));

    const vecCount = db
      .prepare('SELECT COUNT(*) AS c FROM evidence_vec')
      .get() as { c: number };
    expect(vecCount.c).toBe(1);

    const result = store.search('better-sqlite3', { mode: 'semantic' });
    const matches = result.items.filter((i) => i.anchor === 'ev:dup:001');
    expect(matches).toHaveLength(1);
  });
});

describe('M6 edge — jieba lexical tokenization', () => {
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

  it('Chinese query 数据库 hits evidence whose body contains 数据库选型', () => {
    store.upsert(
      item(
        'ev:db-choice:001',
        '数据库选型对比',
        'PostgreSQL 与 better-sqlite3 的数据库选型对比分析。',
        { keywords: ['数据库', '选型'] },
      ),
    );
    const result = store.search('数据库', { mode: 'lexical' });
    expect(result.items.map((i) => i.anchor)).toContain('ev:db-choice:001');
  });

  it('mixed CJK+ASCII query matches a mixed-language evidence body', () => {
    store.upsert(
      item(
        'ev:api-design:001',
        'REST API 资源命名',
        'REST API 的资源命名应使用名词复数并保持版本前缀 v1。',
        { keywords: ['API', '资源命名'] },
      ),
    );
    const result = store.search('API 资源命名', { mode: 'lexical' });
    expect(result.items.map((i) => i.anchor)).toContain('ev:api-design:001');
  });

  it('stopword/punctuation-only query returns empty items gracefully (no throw)', () => {
    store.upsert(
      item(
        'ev:ctx:001',
        '分层上下文组装',
        '分层上下文组装在静默间隔超过阈值时切换智能窗口。',
        { keywords: ['上下文'] },
      ),
    );
    let result: EvidenceSearchResult | null = null;
    expect(() => {
      result = store.search('，。 的 了 ！？', { mode: 'lexical' });
    }).not.toThrow();
    expect(result).not.toBeNull();
    expect(result!.items).toHaveLength(0);
  });

  it('empty-string query returns empty items gracefully (no throw)', () => {
    store.upsert(
      item('ev:sop:001', 'SOP 工作流', 'SOP 工作流在事件触发时按条件分支执行动作。', {
        keywords: ['SOP'],
      }),
    );
    let result: EvidenceSearchResult | null = null;
    expect(() => {
      result = store.search('', { mode: 'lexical' });
    }).not.toThrow();
    expect(result).not.toBeNull();
    expect(result!.items).toHaveLength(0);
    expect(result!.meta.effectiveMode).toBe('lexical');
  });
});

describe('M6 edge — hybrid RRF fusion behavior', () => {
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

  it('hybrid dedups by anchor: every returned anchor is unique', () => {
    store.upsert(
      item('ev:fusion:a', '语义召回', '向量检索的语义召回弥补词法检索的字面局限。', {
        keywords: ['向量检索'],
      }),
    );
    store.upsert(
      item('ev:fusion:b', '关键词召回', '向量检索结合关键词检索提升整体召回质量。', {
        keywords: ['向量检索'],
      }),
    );
    store.upsertEmbedding('ev:fusion:a', unitVector(3));
    store.upsertEmbedding('ev:fusion:b', unitVector(4));

    const result = store.search('向量检索', { mode: 'hybrid' });
    const anchors = result.items.map((i) => i.anchor);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it('an anchor present only in the lexical path still appears in hybrid results', () => {
    // Embedded row makes the vec table non-empty so hybrid does not degrade.
    store.upsert(
      item(
        'ev:hybrid:embedded',
        '上下文组装智能窗口',
        '上下文组装使用智能窗口与摘要压缩历史消息。',
        { keywords: ['上下文组装'] },
      ),
    );
    store.upsertEmbedding('ev:hybrid:embedded', unitVector(5));
    // Lexically-matching row WITHOUT an embedding (lexical-only path).
    store.upsert(
      item(
        'ev:hybrid:lexonly',
        '上下文组装保留原始消息',
        '上下文组装还需保留最近若干条原始消息。',
        { keywords: ['上下文组装'] },
      ),
    );

    const result = store.search('上下文组装', { mode: 'hybrid' });
    expect(result.meta.effectiveMode).toBe('hybrid');
    expect(result.meta.degraded).toBe(false);
    const anchors = result.items.map((i) => i.anchor);
    expect(anchors).toContain('ev:hybrid:lexonly');
    expect(anchors).toContain('ev:hybrid:embedded');
  });

  it('hybrid with no embeddings degrades to lexical with a degradeReason', () => {
    store.upsert(
      item('ev:degrade:001', 'Skills 框架', 'Skills 框架把 Markdown 编译为 system prompt。', {
        keywords: ['Skills'],
      }),
    );
    const result = store.search('Skills', { mode: 'hybrid' });
    expect(result.meta.degraded).toBe(true);
    expect(result.meta.effectiveMode).toBe('lexical');
    expect(result.meta.degradeReason).toBeTruthy();
    expect(result.items.map((i) => i.anchor)).toContain('ev:degrade:001');
  });

  it('semantic with no embeddings degrades and serves no semantic items', () => {
    store.upsert(
      item('ev:degrade:002', 'MCP server', 'MCP server 通过工具注册暴露 evidence 检索能力。', {
        keywords: ['MCP'],
      }),
    );
    const result = store.search('MCP', { mode: 'semantic' });
    expect(result.meta.degraded).toBe(true);
    expect(result.meta.degradeReason).toBeTruthy();
    expect(result.items).toHaveLength(0);
  });
});
