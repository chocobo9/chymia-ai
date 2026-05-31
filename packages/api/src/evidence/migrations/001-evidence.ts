// Migration 001 — Evidence Store schema (idempotent).
//
// Source: clowder-architecture-design.md §4.5 (EvidenceItem / EntityRecord /
// EvidenceEdge fields) + §7.6 ("FTS5 schema：用 contentless 表 (content='')，
// 手动管理 rowid ↔ anchor 映射"; "向量表：sqlite-vec vec0 虚拟表").
//
// Schema shape mirrors the reference evidence-store.sql.ts (FTS5 contentless +
// vec0), re-authored here against our M1 types. Everything is CREATE ... IF NOT
// EXISTS so the migration is safe to run on every store construction.

import type { Database } from 'better-sqlite3';

// Default embedding dimension when the vec0 table is created before any
// embedding is supplied. Source: §7.6 "dim 由首次 upsertEmbedding 确定（默认 384）".
// 384 = MiniLM-class sentence embedding size (Clowder reference default).
export const DEFAULT_EMBEDDING_DIM = 384;

// Base relational + FTS5 schema. The FTS5 table uses the unicode61 tokenizer
// and stores the jieba-pre-segmented searchable text; its rowid is kept equal
// to evidence.rowid for the anchor mapping. A plain (non-external-content) FTS5
// table is used so a changed row can be re-indexed via a simple
// DELETE ... WHERE rowid + re-INSERT on upsert (the external-content 'delete'
// command requires re-supplying the exact prior column values, which the
// reference handles via SQL triggers; we keep the write path in TS instead).
const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS evidence (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  anchor TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  keywords TEXT,
  source_path TEXT,
  source_hash TEXT,
  authority TEXT,
  superseded_by TEXT,
  materialized_from TEXT,
  pack_id TEXT,
  drill_down TEXT,
  provenance TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_kind ON evidence(kind);
CREATE INDEX IF NOT EXISTS idx_evidence_status ON evidence(status);

CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
  content,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS entities (
  entity_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  aliases TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  from_anchor TEXT NOT NULL,
  to_anchor TEXT NOT NULL,
  relation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_anchor, to_anchor, relation)
);

CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_anchor);
`;

/**
 * runEvidenceMigration — create the base relational + FTS5 + entity/edge tables.
 * Idempotent (CREATE ... IF NOT EXISTS). The vec0 virtual table is created
 * lazily via createVectorTable once an embedding dimension is known.
 */
export function runEvidenceMigration(db: Database): void {
  db.exec(BASE_SCHEMA);
}

/**
 * createVectorTable — create the sqlite-vec vec0 virtual table for the given
 * embedding dimension. Uses vec0's implicit integer `rowid` primary key, set
 * equal to evidence.rowid, so KNN results map straight back to evidence rows.
 * Idempotent.
 *
 * NOTE: sqlite-vec rejects an explicitly named INTEGER PRIMARY KEY column
 * ("Only integers are allowed for primary key values"); the implicit `rowid`
 * is the supported way to key a vec0 row to an external integer id.
 *
 * NOTE: dim is fixed at table-creation time by sqlite-vec; a later embedding of
 * a different length is a caller error (the store rejects it).
 */
export function createVectorTable(db: Database, dim: number): void {
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS evidence_vec USING vec0(
       embedding FLOAT[${dim}]
     );`,
  );
}
