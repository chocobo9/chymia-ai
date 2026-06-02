// SqliteEvidenceStore — IEvidenceStore implementation over better-sqlite3.
//
// Source: clowder-architecture-design.md §4.5 (data model), §5.3 (IEvidenceStore
// interface + search behaviour), §7.6 (hybrid retrieval: FTS5 BM25 + vec KNN +
// RRF fusion, jieba pre-tokenization, fail-open).
//
// WHY (research, from Clowder evidence-store.ts): the reference keeps a
// contentless FTS5 table whose rowid mirrors the evidence rowid, syncs FTS on
// every upsert (delete+insert by rowid), and fuses lexical + vector results via
// RRF. We re-author that here, replacing the CJK_NN_WEIGHT down-weight with real
// jieba segmentation so Chinese lexical recall works (数据库 → 数据库选型).

import type { Database } from 'better-sqlite3';
import type {
  EvidenceItem,
  EvidenceKind,
  EvidenceStatus,
  EvidenceAuthority,
  EvidenceDrillDown,
  EvidenceProvenance,
  EntityRecord,
  EntityType,
  EvidenceEdge,
  EvidenceRelation,
  EvidenceSearchOptions,
  EvidenceSearchResult,
  EvidenceSearchMode,
} from '@choco/shared';
import { runEvidenceMigration } from './migrations/001-evidence.js';
import { tokenizeForIndex, tokenizeForQuery } from './jieba-tokenizer.js';
import { VectorStore } from './vector-store.js';
import { fuseByRrf, type RankedList } from './rrf.js';

// Default number of results returned by search. Source: §5.3 "limit 默认 10".
const DEFAULT_SEARCH_LIMIT = 10;

// How many candidates each path (lexical / semantic) fetches before fusion.
// Wider than the final limit so RRF can re-rank a richer pool; bounded to keep
// per-query work small. Local tuning constant (no canonical source value).
const CANDIDATE_POOL_MULTIPLIER = 4;

// Default search mode when the caller does not specify one.
// Source: §5.3 "mode='hybrid'（默认）".
const DEFAULT_SEARCH_MODE: EvidenceSearchMode = 'hybrid';

// --- Internal row shapes (precisely typed; no `any`) ---------------------------

interface EvidenceRow {
  rowid: number;
  anchor: string;
  kind: string;
  status: string;
  title: string;
  summary: string | null;
  keywords: string | null;
  source_path: string | null;
  source_hash: string | null;
  authority: string | null;
  superseded_by: string | null;
  materialized_from: string | null;
  pack_id: string | null;
  drill_down: string | null;
  provenance: string | null;
  updated_at: string;
}

interface FtsHitRow {
  rowid: number;
}

interface EntityRow {
  entity_id: string;
  type: string;
  canonical_name: string;
  aliases: string;
  updated_at: string;
}

interface EdgeRow {
  from_anchor: string;
  to_anchor: string;
  relation: string;
  created_at: string;
}

// IEvidenceStore (§5.3). Declared locally as a structural contract; the store
// implements it. Methods/signatures mirror the design doc exactly.
export interface IEvidenceStore {
  upsert(item: EvidenceItem): void;
  getByAnchor(anchor: string): EvidenceItem | null;
  search(query: string, options?: EvidenceSearchOptions): EvidenceSearchResult;
  upsertEmbedding(anchor: string, embedding: number[]): void;
  upsertEntity(entity: EntityRecord): void;
  resolveEntity(nameOrAlias: string): EntityRecord | null;
  upsertEdge(edge: EvidenceEdge): void;
  getEdges(anchor: string): EvidenceEdge[];
}

export class SqliteEvidenceStore implements IEvidenceStore {
  private readonly db: Database;
  private readonly vectors: VectorStore;

  /**
   * @param db injected better-sqlite3 Database (DI; no global singleton). WAL is
   *           enabled and the schema migrated here; sqlite-vec is loaded by the
   *           VectorStore so vec0 / vec_distance are available.
   */
  constructor(db: Database) {
    this.db = db;
    // WAL mode: concurrent readers + single writer, no reader/writer locks —
    // required for the "concurrent 100-write, no lock error" guarantee (§M6).
    this.db.pragma('journal_mode = WAL');
    runEvidenceMigration(this.db);
    this.vectors = new VectorStore(this.db);
  }

  // --- EvidenceItem CRUD -------------------------------------------------------

  upsert(item: EvidenceItem): void {
    // Dedup by anchor: ON CONFLICT updates the existing row (no new row), so a
    // repeated anchor upsert leaves the row count unchanged (§M6).
    const upsertEvidence = this.db.prepare(
      `INSERT INTO evidence (
         anchor, kind, status, title, summary, keywords, source_path,
         source_hash, authority, superseded_by, materialized_from, pack_id,
         drill_down, provenance, updated_at
       ) VALUES (
         @anchor, @kind, @status, @title, @summary, @keywords, @source_path,
         @source_hash, @authority, @superseded_by, @materialized_from, @pack_id,
         @drill_down, @provenance, @updated_at
       )
       ON CONFLICT(anchor) DO UPDATE SET
         kind=excluded.kind, status=excluded.status, title=excluded.title,
         summary=excluded.summary, keywords=excluded.keywords,
         source_path=excluded.source_path, source_hash=excluded.source_hash,
         authority=excluded.authority, superseded_by=excluded.superseded_by,
         materialized_from=excluded.materialized_from, pack_id=excluded.pack_id,
         drill_down=excluded.drill_down, provenance=excluded.provenance,
         updated_at=excluded.updated_at`,
    );

    // Sync FTS + evidence atomically so a contentless FTS row never dangles.
    const tx = this.db.transaction((evidenceItem: EvidenceItem) => {
      upsertEvidence.run(toEvidenceParams(evidenceItem));
      const rowid = this.rowidForAnchor(evidenceItem.anchor);
      if (rowid !== null) {
        this.syncFtsRow(rowid, evidenceItem);
      }
    });
    tx(item);
  }

  getByAnchor(anchor: string): EvidenceItem | null {
    const row = this.db
      .prepare('SELECT * FROM evidence WHERE anchor = ?')
      .get(anchor) as EvidenceRow | undefined;
    return row ? rowToEvidence(row) : null;
  }

  // --- Search ------------------------------------------------------------------

  search(query: string, options?: EvidenceSearchOptions): EvidenceSearchResult {
    const requestedMode = options?.mode ?? DEFAULT_SEARCH_MODE;
    const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
    const poolSize = Math.max(limit * CANDIDATE_POOL_MULTIPLIER, limit);

    // Pure-lexical: no fusion, just BM25 order.
    if (requestedMode === 'lexical') {
      const anchors = this.lexicalSearch(query, poolSize, options?.kind);
      return this.buildResult(anchors.slice(0, limit), 'lexical', false);
    }

    // Pure-semantic: KNN only (empty when no embeddings present).
    if (requestedMode === 'semantic') {
      if (!this.vectors.hasEmbeddings()) {
        // No vectors → cannot serve semantic; degrade to empty semantic result.
        return this.buildResult([], 'semantic', true, 'no embeddings');
      }
      const anchors = this.semanticSearch(query, poolSize, options?.kind);
      return this.buildResult(anchors.slice(0, limit), 'semantic', false);
    }

    // Hybrid: fuse lexical + semantic by RRF. Degrade to lexical when there are
    // no embeddings (§5.3 "无 embedding 时 hybrid 退化为 lexical").
    const lexicalAnchors = this.lexicalSearch(query, poolSize, options?.kind);
    if (!this.vectors.hasEmbeddings()) {
      return this.buildResult(lexicalAnchors.slice(0, limit), 'lexical', true, 'no embeddings');
    }
    const semanticAnchors = this.semanticSearch(query, poolSize, options?.kind);
    const lists: RankedList[] = [{ anchors: lexicalAnchors }, { anchors: semanticAnchors }];
    const fused = fuseByRrf(lists).map((f) => f.anchor);
    return this.buildResult(fused.slice(0, limit), 'hybrid', false);
  }

  // --- Embeddings --------------------------------------------------------------

  upsertEmbedding(anchor: string, embedding: number[]): void {
    const rowid = this.rowidForAnchor(anchor);
    if (rowid === null) {
      throw new Error(`upsertEmbedding: unknown anchor '${anchor}' (upsert the evidence first)`);
    }
    this.vectors.upsert(rowid, embedding);
  }

  // --- Entities ----------------------------------------------------------------

  upsertEntity(entity: EntityRecord): void {
    this.db
      .prepare(
        `INSERT INTO entities (entity_id, type, canonical_name, aliases, updated_at)
         VALUES (@entity_id, @type, @canonical_name, @aliases, @updated_at)
         ON CONFLICT(entity_id) DO UPDATE SET
           type=excluded.type, canonical_name=excluded.canonical_name,
           aliases=excluded.aliases, updated_at=excluded.updated_at`,
      )
      .run({
        entity_id: entity.entityId,
        type: entity.type,
        canonical_name: entity.canonicalName,
        aliases: JSON.stringify(entity.aliases),
        updated_at: entity.updatedAt,
      });
  }

  resolveEntity(nameOrAlias: string): EntityRecord | null {
    // Case-insensitive match on canonicalName OR any alias.
    // Pattern from Clowder entity-resolver.ts (JSON aliases, case-insensitive),
    // re-authored. Alias matching is done in JS since aliases are JSON-encoded.
    const needle = nameOrAlias.trim().toLowerCase();
    if (needle.length === 0) {
      return null;
    }
    const rows = this.db.prepare('SELECT * FROM entities').all() as EntityRow[];
    for (const row of rows) {
      if (row.canonical_name.toLowerCase() === needle) {
        return rowToEntity(row);
      }
      const aliases = parseAliases(row.aliases);
      if (aliases.some((a) => a.toLowerCase() === needle)) {
        return rowToEntity(row);
      }
    }
    return null;
  }

  // --- Edges -------------------------------------------------------------------

  upsertEdge(edge: EvidenceEdge): void {
    this.db
      .prepare(
        `INSERT INTO edges (from_anchor, to_anchor, relation, created_at)
         VALUES (@from_anchor, @to_anchor, @relation, @created_at)
         ON CONFLICT(from_anchor, to_anchor, relation) DO UPDATE SET
           created_at=excluded.created_at`,
      )
      .run({
        from_anchor: edge.fromAnchor,
        to_anchor: edge.toAnchor,
        relation: edge.relation,
        created_at: edge.createdAt,
      });
  }

  getEdges(anchor: string): EvidenceEdge[] {
    const rows = this.db
      .prepare('SELECT * FROM edges WHERE from_anchor = ? OR to_anchor = ?')
      .all(anchor, anchor) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  // --- Internal helpers --------------------------------------------------------

  // FTS5 BM25 lexical search through jieba pre-tokenization. Returns anchors in
  // ascending bm25() rank (best first). Empty query → no hits.
  private lexicalSearch(query: string, limit: number, kind?: EvidenceKind): string[] {
    const match = tokenizeForQuery(query);
    if (match.length === 0) {
      return [];
    }
    // bm25(evidence_fts) is ascending-good (smaller = more relevant). Join FTS
    // rowids back to evidence rows; optionally filter by kind.
    const sql = kind
      ? `SELECT e.anchor AS anchor
           FROM evidence_fts f
           JOIN evidence e ON e.rowid = f.rowid
          WHERE evidence_fts MATCH ? AND e.kind = ?
          ORDER BY bm25(evidence_fts)
          LIMIT ?`
      : `SELECT e.anchor AS anchor
           FROM evidence_fts f
           JOIN evidence e ON e.rowid = f.rowid
          WHERE evidence_fts MATCH ?
          ORDER BY bm25(evidence_fts)
          LIMIT ?`;
    const stmt = this.db.prepare(sql);
    const rows = (kind ? stmt.all(match, kind, limit) : stmt.all(match, limit)) as Array<{
      anchor: string;
    }>;
    return rows.map((r) => r.anchor);
  }

  // Semantic KNN over the vec0 table.
  //
  // Embedding GENERATION (text → vector) is out of M6 scope: the store only
  // stores/queries vectors it is given via upsertEmbedding. The §5.3 interface
  // is search(query: string) with no query-vector parameter, so to drive a
  // deterministic KNN we use a "more like this" query vector: the stored
  // embedding of the lexically best-matching row (see deriveQueryEmbedding).
  // This exercises the real vec0 KNN + RRF fusion + dedup paths without
  // inventing an embedding model. Returns [] when no usable query vector exists.
  private semanticSearch(query: string, limit: number, kind?: EvidenceKind): string[] {
    const queryEmbedding = this.deriveQueryEmbedding(query);
    if (queryEmbedding === null) {
      return [];
    }
    const hits = this.vectors.knn(queryEmbedding, limit);
    if (hits.length === 0) {
      return [];
    }
    const anchors: string[] = [];
    for (const hit of hits) {
      const row = this.db
        .prepare('SELECT anchor, kind FROM evidence WHERE rowid = ?')
        .get(hit.rowid) as { anchor: string; kind: string } | undefined;
      if (!row) {
        continue;
      }
      if (kind && row.kind !== kind) {
        continue;
      }
      anchors.push(row.anchor);
    }
    return anchors;
  }

  // Number of lexical candidates scanned to find a query "seed" embedding.
  // Keeps the seed selection robust when the BM25 top hit has no stored vector.
  // Local tuning constant (no canonical source value).
  private static readonly SEED_SCAN_LIMIT = 16;

  // Derive a query embedding to drive semantic KNN. Embedding GENERATION is out
  // of M6 scope (§ vector-store.ts), so we use the embedding of the lexically
  // best-matching evidence row that actually HAS a stored vector as the query
  // vector ("more like this" semantics). Scanning past the very top hit keeps
  // semantic recall working when the BM25 leader has no embedding yet. Returns
  // null when no lexical candidate has a stored embedding.
  private deriveQueryEmbedding(query: string): number[] | null {
    const match = tokenizeForQuery(query);
    if (match.length === 0) {
      return null;
    }
    const candidates = this.db
      .prepare(
        `SELECT f.rowid AS rowid
           FROM evidence_fts f
          WHERE evidence_fts MATCH ?
          ORDER BY bm25(evidence_fts)
          LIMIT ?`,
      )
      .all(match, SqliteEvidenceStore.SEED_SCAN_LIMIT) as FtsHitRow[];
    for (const candidate of candidates) {
      const embedding = this.readEmbedding(candidate.rowid);
      if (embedding !== null) {
        return embedding;
      }
    }
    return null;
  }

  // Read a stored embedding back as number[] (Float32 buffer → numbers).
  // The Buffer returned by better-sqlite3 is a view into Node's shared pool, so
  // its byteOffset is not guaranteed to be 4-byte aligned; viewing it directly
  // with Float32Array can throw or mis-read. Copy the exact bytes into a fresh,
  // aligned ArrayBuffer before reinterpreting as Float32.
  private readEmbedding(rowid: number): number[] | null {
    if (!this.vectors.hasEmbeddings()) {
      return null;
    }
    const row = this.db
      .prepare('SELECT embedding FROM evidence_vec WHERE rowid = ?')
      .get(rowid) as { embedding: Buffer } | undefined;
    if (!row) {
      return null;
    }
    const copy = Uint8Array.from(row.embedding);
    const floats = new Float32Array(
      copy.buffer,
      copy.byteOffset,
      copy.byteLength / Float32Array.BYTES_PER_ELEMENT,
    );
    return Array.from(floats);
  }

  // Sync the FTS5 row for a rowid: delete the old row by rowid, then insert the
  // jieba-segmented searchable text (title + summary + keywords). §7.6: "upsert
  // 时对 title+summary+keywords 分词存 FTS5". Delete-by-rowid + re-insert keeps
  // the FTS row aligned to the evidence row across content changes (a plain,
  // non-external-content FTS5 table supports DELETE ... WHERE rowid directly).
  private syncFtsRow(rowid: number, item: EvidenceItem): void {
    this.db.prepare('DELETE FROM evidence_fts WHERE rowid = ?').run(rowid);
    const searchable = buildSearchableText(item);
    const tokenized = tokenizeForIndex(searchable);
    this.db.prepare('INSERT INTO evidence_fts(rowid, content) VALUES (?, ?)').run(rowid, tokenized);
  }

  private rowidForAnchor(anchor: string): number | null {
    const row = this.db
      .prepare('SELECT rowid FROM evidence WHERE anchor = ?')
      .get(anchor) as { rowid: number } | undefined;
    return row ? row.rowid : null;
  }

  // Hydrate anchors back into ordered EvidenceItem[] and wrap in a result.
  private buildResult(
    anchors: string[],
    effectiveMode: EvidenceSearchMode,
    degraded: boolean,
    degradeReason?: string,
  ): EvidenceSearchResult {
    const items: EvidenceItem[] = [];
    for (const anchor of anchors) {
      const item = this.getByAnchor(anchor);
      if (item) {
        items.push(item);
      }
    }
    return {
      items,
      meta: degradeReason
        ? { effectiveMode, degraded, degradeReason }
        : { effectiveMode, degraded },
    };
  }
}

// --- Row <-> domain mapping (module-level pure helpers) ------------------------

function toEvidenceParams(item: EvidenceItem): Record<string, string | null> {
  return {
    anchor: item.anchor,
    kind: item.kind,
    status: item.status,
    title: item.title,
    summary: item.summary ?? null,
    keywords: item.keywords ? JSON.stringify(item.keywords) : null,
    source_path: item.sourcePath ?? null,
    source_hash: item.sourceHash ?? null,
    authority: item.authority ?? null,
    superseded_by: item.supersededBy ?? null,
    materialized_from: item.materializedFrom ?? null,
    pack_id: item.packId ?? null,
    drill_down: item.drillDown ? JSON.stringify(item.drillDown) : null,
    provenance: item.provenance ? JSON.stringify(item.provenance) : null,
    updated_at: item.updatedAt,
  };
}

function rowToEvidence(row: EvidenceRow): EvidenceItem {
  const item: EvidenceItem = {
    anchor: row.anchor,
    kind: row.kind as EvidenceKind,
    status: row.status as EvidenceStatus,
    title: row.title,
    updatedAt: row.updated_at,
  };
  if (row.summary !== null) {
    item.summary = row.summary;
  }
  if (row.keywords !== null) {
    item.keywords = parseStringArray(row.keywords);
  }
  if (row.source_path !== null) {
    item.sourcePath = row.source_path;
  }
  if (row.source_hash !== null) {
    item.sourceHash = row.source_hash;
  }
  if (row.authority !== null) {
    item.authority = row.authority as EvidenceAuthority;
  }
  if (row.superseded_by !== null) {
    item.supersededBy = row.superseded_by;
  }
  if (row.materialized_from !== null) {
    item.materializedFrom = row.materialized_from;
  }
  if (row.pack_id !== null) {
    item.packId = row.pack_id;
  }
  if (row.drill_down !== null) {
    item.drillDown = parseDrillDown(row.drill_down);
  }
  if (row.provenance !== null) {
    item.provenance = parseProvenance(row.provenance);
  }
  return item;
}

function rowToEntity(row: EntityRow): EntityRecord {
  return {
    entityId: row.entity_id,
    type: row.type as EntityType,
    canonicalName: row.canonical_name,
    aliases: parseAliases(row.aliases),
    updatedAt: row.updated_at,
  };
}

function rowToEdge(row: EdgeRow): EvidenceEdge {
  return {
    fromAnchor: row.from_anchor,
    toAnchor: row.to_anchor,
    relation: row.relation as EvidenceRelation,
    createdAt: row.created_at,
  };
}

// Compose the FTS-searchable text from an item's lexical fields.
function buildSearchableText(item: EvidenceItem): string {
  const parts: string[] = [item.title];
  if (item.summary) {
    parts.push(item.summary);
  }
  if (item.keywords && item.keywords.length > 0) {
    parts.push(item.keywords.join(' '));
  }
  return parts.join(' ');
}

function parseStringArray(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (Array.isArray(parsed) && parsed.every((v): v is string => typeof v === 'string')) {
    return parsed;
  }
  return [];
}

function parseAliases(json: string): string[] {
  return parseStringArray(json);
}

function parseDrillDown(json: string): EvidenceDrillDown {
  const parsed = JSON.parse(json) as EvidenceDrillDown;
  return parsed;
}

function parseProvenance(json: string): EvidenceProvenance {
  const parsed = JSON.parse(json) as EvidenceProvenance;
  return parsed;
}
