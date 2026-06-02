// M6 dev tests (happy path) — SqliteEvidenceStore over better-sqlite3 + FTS5 +
// sqlite-vec + jieba. Each test gets a fresh in-memory DB (hermetic).
// QA owns edge/adversarial coverage (concurrency, dim mismatch, dedup edge,
// only-stopword queries, etc.).

import { test, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import type { EvidenceItem } from '@choco/shared';
import { SqliteEvidenceStore } from '../../packages/api/src/evidence/sqlite-evidence-store.js';

let db: BetterSqliteDatabase;
let store: SqliteEvidenceStore;

beforeEach(() => {
  db = new Database(':memory:');
  store = new SqliteEvidenceStore(db);
});

afterEach(() => {
  db.close();
});

// Real technical evidence content (Chinese + English), no placeholder data.
const EVIDENCE: EvidenceItem[] = [
  {
    anchor: 'decision:db-selection',
    kind: 'decision',
    status: 'active',
    title: '数据库选型：SQLite + FTS5 + sqlite-vec',
    summary: '团队决定采用 SQLite 作为嵌入式存储，配合 FTS5 全文检索与 sqlite-vec 向量检索。',
    keywords: ['数据库', 'SQLite', '向量检索'],
    updatedAt: '2026-05-30T08:00:00.000Z',
  },
  {
    anchor: 'research:hybrid-retrieval',
    kind: 'research',
    status: 'active',
    title: 'Hybrid retrieval with RRF fusion',
    summary:
      'Reciprocal Rank Fusion combines BM25 lexical ranking with vector KNN for hybrid search.',
    keywords: ['RRF', 'hybrid', 'retrieval'],
    updatedAt: '2026-05-30T08:05:00.000Z',
  },
  {
    anchor: 'lesson:wal-concurrency',
    kind: 'lesson',
    status: 'active',
    title: 'WAL 模式避免并发写锁',
    summary: '开启 SQLite WAL 日志模式后，读写并发不再触发 database is locked 错误。',
    keywords: ['WAL', '并发', 'SQLite'],
    updatedAt: '2026-05-30T08:10:00.000Z',
  },
  {
    anchor: 'plan:embedding-pipeline',
    kind: 'plan',
    status: 'active',
    title: '嵌入向量生成流水线规划',
    summary: '将文档切块后调用 embedding 模型生成 384 维向量，写入 evidence 向量表。',
    keywords: ['embedding', '向量', 'pipeline'],
    updatedAt: '2026-05-30T08:15:00.000Z',
  },
];

function seedEvidence(): void {
  for (const item of EVIDENCE) {
    store.upsert(item);
  }
}

test('integration: upsert several evidence then FTS5 lexical search returns BM25-ordered hits', () => {
  // Arrange
  seedEvidence();

  // Act — "SQLite" is a token in two items (db-selection title/keywords and
  // wal-concurrency summary/keywords); the embedding-pipeline item does not
  // mention SQLite, so it must NOT match.
  const result = store.search('SQLite', { mode: 'lexical' });

  // Assert
  expect(result.meta.effectiveMode).toBe('lexical');
  expect(result.meta.degraded).toBe(false);
  const anchors = result.items.map((i) => i.anchor);
  expect(anchors).toContain('decision:db-selection');
  expect(anchors).toContain('lesson:wal-concurrency');
  expect(anchors).not.toContain('plan:embedding-pipeline');
});

test('integration: Chinese query "数据库" hits evidence containing "数据库选型" via jieba', () => {
  // Arrange
  seedEvidence();

  // Act — jieba segments "数据库选型" so the "数据库" token matches.
  const result = store.search('数据库', { mode: 'lexical' });

  // Assert
  const anchors = result.items.map((i) => i.anchor);
  expect(anchors).toContain('decision:db-selection');
});

test('integration: lexical search can filter by kind', () => {
  // Arrange
  seedEvidence();

  // Act — restrict the SQLite query to lessons only.
  const result = store.search('SQLite', { mode: 'lexical', kind: 'lesson' });

  // Assert
  const anchors = result.items.map((i) => i.anchor);
  expect(anchors).toContain('lesson:wal-concurrency');
  expect(anchors).not.toContain('decision:db-selection');
});

test('integration: hybrid search fuses lexical + semantic and de-duplicates', () => {
  // Arrange — seed and attach deterministic embeddings (hand-set, not random).
  seedEvidence();
  // 4-d vectors; db-selection and hybrid-retrieval are close in vector space.
  store.upsertEmbedding('decision:db-selection', [1, 0, 0, 0]);
  store.upsertEmbedding('research:hybrid-retrieval', [0.9, 0.1, 0, 0]);
  store.upsertEmbedding('lesson:wal-concurrency', [0, 1, 0, 0]);
  store.upsertEmbedding('plan:embedding-pipeline', [0, 0, 1, 0]);

  // Act — query that matches lexically (SQLite) and is anchored on db-selection.
  const result = store.search('SQLite 向量检索', { mode: 'hybrid' });

  // Assert — hybrid mode, not degraded, deduped (each anchor appears once).
  expect(result.meta.effectiveMode).toBe('hybrid');
  expect(result.meta.degraded).toBe(false);
  const anchors = result.items.map((i) => i.anchor);
  expect(new Set(anchors).size).toBe(anchors.length);
  expect(anchors).toContain('decision:db-selection');
});

test('integration: hybrid degrades to lexical when no embeddings are stored', () => {
  // Arrange — seed evidence but store NO embeddings.
  seedEvidence();

  // Act
  const result = store.search('SQLite', { mode: 'hybrid' });

  // Assert — degraded path per §5.3.
  expect(result.meta.effectiveMode).toBe('lexical');
  expect(result.meta.degraded).toBe(true);
  expect(result.meta.degradeReason).toBe('no embeddings');
  expect(result.items.length).toBeGreaterThan(0);
});

test('integration: duplicate-anchor upsert updates in place (row count unchanged)', () => {
  // Arrange
  store.upsert(EVIDENCE[0]);
  const countBefore = (db.prepare('SELECT COUNT(*) AS c FROM evidence').get() as { c: number }).c;

  // Act — re-upsert the same anchor with a changed title + status.
  store.upsert({
    ...EVIDENCE[0],
    title: '数据库选型（已定稿）：SQLite + FTS5 + sqlite-vec',
    status: 'done',
    updatedAt: '2026-05-30T09:00:00.000Z',
  });
  const countAfter = (db.prepare('SELECT COUNT(*) AS c FROM evidence').get() as { c: number }).c;

  // Assert — no new row; the existing row was updated.
  expect(countBefore).toBe(1);
  expect(countAfter).toBe(1);
  const updated = store.getByAnchor('decision:db-selection');
  expect(updated?.status).toBe('done');
  expect(updated?.title).toContain('已定稿');
});

test('integration: re-indexed FTS row matches updated content after duplicate upsert', () => {
  // Arrange — initial content.
  store.upsert(EVIDENCE[0]);

  // Act — update the summary to introduce a new searchable Chinese term.
  store.upsert({
    ...EVIDENCE[0],
    summary: '本条目记录最终的架构裁决与权衡分析。',
    updatedAt: '2026-05-30T09:30:00.000Z',
  });

  // Assert — the new term is searchable (FTS row was re-synced).
  const result = store.search('裁决', { mode: 'lexical' });
  expect(result.items.map((i) => i.anchor)).toContain('decision:db-selection');
});

test('integration: getByAnchor round-trips all optional EvidenceItem fields', () => {
  // Arrange — a rich item exercising drillDown + provenance + extra fields.
  const rich: EvidenceItem = {
    anchor: 'feature:evidence-store',
    kind: 'feature',
    status: 'active',
    title: 'Evidence Store 混合检索',
    summary: 'FTS5 + sqlite-vec + RRF。',
    keywords: ['evidence', 'hybrid'],
    sourcePath: 'docs/clowder-architecture-design.md',
    sourceHash: 'abc123',
    authority: 'authoritative',
    packId: 'memory',
    drillDown: {
      tool: 'evidence_search',
      params: { anchor: 'feature:evidence-store' },
      hint: '查看详情',
    },
    provenance: { tier: 'authoritative', source: 'design-doc' },
    updatedAt: '2026-05-30T10:00:00.000Z',
  };

  // Act
  store.upsert(rich);
  const back = store.getByAnchor('feature:evidence-store');

  // Assert
  expect(back).not.toBeNull();
  expect(back?.keywords).toEqual(['evidence', 'hybrid']);
  expect(back?.drillDown?.tool).toBe('evidence_search');
  expect(back?.provenance?.tier).toBe('authoritative');
  expect(back?.authority).toBe('authoritative');
});

test('integration: entity alias resolution finds the canonical record by alias', () => {
  // Arrange — an agent entity with aliases.
  store.upsertEntity({
    entityId: 'agent:claude',
    type: 'agent',
    canonicalName: 'Claude',
    aliases: ['claude-opus', 'Claude Code', '克劳德'],
    updatedAt: '2026-05-30T08:00:00.000Z',
  });

  // Act + Assert — canonical name (case-insensitive).
  expect(store.resolveEntity('claude')?.entityId).toBe('agent:claude');
  // Act + Assert — by ASCII alias.
  expect(store.resolveEntity('claude-opus')?.entityId).toBe('agent:claude');
  // Act + Assert — by Chinese alias.
  expect(store.resolveEntity('克劳德')?.entityId).toBe('agent:claude');
  // Unknown name resolves to null.
  expect(store.resolveEntity('gemini')).toBeNull();
});

test('integration: edges round-trip via upsertEdge + getEdges (both directions)', () => {
  // Arrange
  seedEvidence();
  store.upsertEdge({
    fromAnchor: 'plan:embedding-pipeline',
    toAnchor: 'decision:db-selection',
    relation: 'related',
    createdAt: '2026-05-30T08:20:00.000Z',
  });

  // Act — getEdges returns edges where the anchor is either endpoint.
  const fromPlan = store.getEdges('plan:embedding-pipeline');
  const fromDecision = store.getEdges('decision:db-selection');

  // Assert
  expect(fromPlan).toHaveLength(1);
  expect(fromPlan[0].relation).toBe('related');
  expect(fromDecision).toHaveLength(1);
  expect(fromDecision[0].fromAnchor).toBe('plan:embedding-pipeline');
});

test('integration: semantic search returns vector-ranked anchors when embeddings exist', () => {
  // Arrange — "向量检索" is unique to decision:db-selection (keyword + summary),
  // so the lexical seed is unambiguous and the query vector is deterministically
  // db-selection's. db-selection and wal-concurrency are far apart in vector
  // space so KNN ordering is stable.
  seedEvidence();
  store.upsertEmbedding('decision:db-selection', [1, 0, 0, 0]);
  store.upsertEmbedding('lesson:wal-concurrency', [0, 1, 0, 0]);

  // Act — seed resolves to db-selection's embedding [1,0,0,0]; nearest neighbour
  // is db-selection itself (distance 0).
  const result = store.search('向量检索', { mode: 'semantic' });

  // Assert — semantic mode served, db-selection (nearest) ranked first.
  expect(result.meta.effectiveMode).toBe('semantic');
  expect(result.items.length).toBeGreaterThan(0);
  expect(result.items[0].anchor).toBe('decision:db-selection');
});
