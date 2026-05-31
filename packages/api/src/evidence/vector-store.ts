// Vector store — sqlite-vec vec0 operations for the Evidence Store.
//
// Source: clowder-architecture-design.md §7.6 — "向量表：sqlite-vec vec0 虚拟表，
// dim 由首次 upsertEmbedding 确定（默认 384）"; KNN "query embedding → sqlite-vec
// KNN → [(anchor, distance)]".
//
// Responsibility boundary (M6 scope): this module STORES and QUERIES vectors it
// is given. Embedding GENERATION (text → number[]) is out of M6 scope; callers
// supply embeddings as number[]. See report.
//
// Pattern from Clowder vector-index.ts (Float32 Buffer serialization + vec0
// MATCH ... ORDER BY distance LIMIT), re-authored with explicit dim handling and
// typed rows.

import { createRequire } from 'node:module';
import type { Database } from 'better-sqlite3';
import { createVectorTable, DEFAULT_EMBEDDING_DIM } from './migrations/001-evidence.js';

// Load sqlite-vec through createRequire rather than a static ESM import.
// WHY: under Vite/vitest's ESM interop, `import * as sqliteVec from 'sqlite-vec'`
// can resolve the package's native loadable path incorrectly, so db.loadExtension
// then fails with SQLite "not authorized". createRequire resolves the package
// from the real node_modules tree so the native loadable path (and the
// db.loadExtension that sqliteVec.load performs) works identically to plain CJS.
interface SqliteVecModule {
  load(db: Database): void;
}
const nativeRequire = createRequire(import.meta.url);
const sqliteVec = nativeRequire('sqlite-vec') as SqliteVecModule;

/** Row shape returned by the vec0 KNN query. */
interface VecKnnRow {
  rowid: number;
  distance: number;
}

/** A KNN hit: an evidence rowid and its vector distance to the query. */
export interface VectorHit {
  rowid: number;
  distance: number;
}

/**
 * VectorStore — manages the sqlite-vec vec0 virtual table over an injected
 * Database. The vec0 table is created lazily on the first embedding so its
 * dimension is fixed by the first vector seen (default 384 if asked to ensure
 * the table before any embedding arrives).
 */
export class VectorStore {
  private readonly db: Database;
  private dimension: number | undefined;
  private tableReady = false;

  /**
   * @param db          injected better-sqlite3 Database (sqlite-vec extension
   *                     is loaded here so vec0 / vec_distance are available)
   * @param existingDim if the vec0 table already exists from a prior session,
   *                     pass its dimension so inserts validate against it
   */
  constructor(db: Database, existingDim?: number) {
    this.db = db;
    sqliteVec.load(db);
    if (existingDim !== undefined) {
      this.dimension = existingDim;
      this.tableReady = true;
    }
  }

  /** The fixed embedding dimension, or undefined if no embedding stored yet. */
  getDimension(): number | undefined {
    return this.dimension;
  }

  /** True once at least one embedding has been stored (semantic search ready). */
  hasEmbeddings(): boolean {
    if (!this.tableReady) {
      return false;
    }
    const row = this.db
      .prepare('SELECT EXISTS(SELECT 1 FROM evidence_vec) AS present')
      .get() as { present: number };
    return row.present === 1;
  }

  /**
   * upsert — store (or replace) the embedding for an evidence rowid.
   * Fixes the table dimension on first call. Rejects a later embedding whose
   * length disagrees with the established dimension (vec0 cannot mix dims).
   */
  upsert(rowid: number, embedding: readonly number[]): void {
    if (embedding.length === 0) {
      throw new Error('VectorStore.upsert: embedding must be non-empty');
    }
    if (!Number.isInteger(rowid)) {
      throw new Error(`VectorStore.upsert: rowid must be an integer, got ${String(rowid)}`);
    }
    this.ensureTable(embedding.length);
    if (embedding.length !== this.dimension) {
      throw new Error(
        `VectorStore.upsert: embedding dimension ${embedding.length} does not match table dimension ${this.dimension}`,
      );
    }
    const buf = toFloat32Buffer(embedding);
    // vec0's implicit rowid keys the row to evidence.rowid. sqlite-vec requires
    // this primary-key value to have SQLite's INTEGER storage class; a plain JS
    // `number` bound by better-sqlite3 is presented to vec0's xUpdate as REAL
    // and rejected with "Only integers are allowed for primary key values".
    // Binding a BigInt makes better-sqlite3 emit a true SQLite INTEGER.
    // vec0 doesn't support OR REPLACE/ON CONFLICT — DELETE then INSERT (see Clowder VectorStore)
    this.db.prepare('DELETE FROM evidence_vec WHERE rowid = ?').run(BigInt(rowid));
    this.db
      .prepare('INSERT INTO evidence_vec(rowid, embedding) VALUES (?, ?)')
      .run(BigInt(rowid), buf);
  }

  /** Remove the embedding for an evidence rowid (no-op if absent or no table). */
  remove(rowid: number): void {
    if (!this.tableReady) {
      return;
    }
    // Bind as BigInt for the same INTEGER-rowid reason as upsert (see above).
    this.db.prepare('DELETE FROM evidence_vec WHERE rowid = ?').run(BigInt(rowid));
  }

  /**
   * knn — k-nearest-neighbour search returning evidence rowids in ascending
   * distance order. Returns [] when no vec0 table exists yet (no embeddings) or
   * when the query embedding dimension does not match the table.
   */
  knn(embedding: readonly number[], k: number): VectorHit[] {
    if (!this.tableReady || this.dimension === undefined) {
      return [];
    }
    if (embedding.length !== this.dimension) {
      return [];
    }
    const buf = toFloat32Buffer(embedding);
    const rows = this.db
      .prepare(
        `SELECT rowid, distance
           FROM evidence_vec
          WHERE embedding MATCH ?
          ORDER BY distance
          LIMIT ?`,
      )
      .all(buf, k) as VecKnnRow[];
    // Coerce rowid to a JS number: better-sqlite3 may surface the vec0 INTEGER
    // rowid as a BigInt, but callers (and the evidence-row lookup) expect number.
    return rows.map((r) => ({ rowid: Number(r.rowid), distance: r.distance }));
  }

  // Create the vec0 table on first use, fixing the dimension. If the table was
  // pre-created with a known dim, this is a no-op once tableReady is set.
  private ensureTable(dim: number): void {
    if (this.tableReady) {
      return;
    }
    const effectiveDim = dim > 0 ? dim : DEFAULT_EMBEDDING_DIM;
    createVectorTable(this.db, effectiveDim);
    this.dimension = effectiveDim;
    this.tableReady = true;
  }
}

// Serialize a JS number[] to the little-endian Float32 byte buffer vec0 expects.
function toFloat32Buffer(embedding: readonly number[]): Buffer {
  const floats = Float32Array.from(embedding);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}
