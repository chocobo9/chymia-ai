// Evidence (shared memory) model: items, entities, edges, search shapes.
// Source: clowder-architecture-design.md §4.5 (Evidence 共享记忆) + §5.3 (检索).

/**
 * EvidenceKind — evidence 的类别。
 * Source: §4.5.
 */
export type EvidenceKind =
  | 'feature'
  | 'decision'
  | 'plan'
  | 'session'
  | 'lesson'
  | 'thread'
  | 'discussion'
  | 'research'
  | 'pack-knowledge';

/**
 * EvidenceStatus — evidence 的生命周期状态。
 * Source: §4.5.
 */
export type EvidenceStatus =
  | 'active'
  | 'done'
  | 'archived'
  | 'review'
  | 'invalidated';

/**
 * EvidenceAuthority — 知识权威级别。
 * Source: §4.5 (EvidenceItem.authority / provenance.tier)。
 */
export type EvidenceAuthority = 'authoritative' | 'derived' | 'soft_clue';

/**
 * EvidenceDrillDown — 深入查看的工具提示。
 * Source: §4.5 (EvidenceItem.drillDown)。
 */
export interface EvidenceDrillDown {
  tool: string;
  params: Record<string, unknown>;
  hint?: string;
}

/**
 * EvidenceProvenance — 来源追踪。
 * Source: §4.5 (EvidenceItem.provenance)。
 */
export interface EvidenceProvenance {
  tier: EvidenceAuthority;
  source: string;
}

/**
 * EvidenceItem — 单条 evidence。
 * Source: §4.5.
 */
export interface EvidenceItem {
  anchor: string; // 唯一标识（如 'decision:2026-05-30-api-framework'）
  kind: EvidenceKind;
  status: EvidenceStatus;
  title: string;
  summary?: string;
  keywords?: string[];
  sourcePath?: string;
  sourceHash?: string; // 源文件 hash（用于变更检测）
  authority?: EvidenceAuthority; // 知识权威级别
  supersededBy?: string; // 被谁取代
  materializedFrom?: string; // 从哪个 evidence 演化而来
  packId?: string; // 所属 skill pack
  drillDown?: EvidenceDrillDown; // 深入查看的工具提示
  provenance?: EvidenceProvenance; // 来源追踪
  updatedAt: string; // ISO8601
}

/**
 * EntityType — 实体类型。
 * Source: §4.5 (EntityRecord.type)。
 */
export type EntityType = 'person' | 'agent' | 'concept' | 'external';

/**
 * EntityRecord — 实体（人、agent、概念）。
 * Source: §4.5.
 */
export interface EntityRecord {
  entityId: string;
  type: EntityType;
  canonicalName: string;
  aliases: string[];
  updatedAt: string; // ISO8601
}

/**
 * EvidenceRelation — 实体/evidence 间关系类型。
 * Source: §4.5 (EvidenceEdge.relation)。
 */
export type EvidenceRelation =
  | 'evolved_from'
  | 'blocked_by'
  | 'related'
  | 'supersedes'
  | 'invalidates';

/**
 * EvidenceEdge — 实体间关系。
 * Source: §4.5.
 */
export interface EvidenceEdge {
  fromAnchor: string;
  toAnchor: string;
  relation: EvidenceRelation;
  createdAt: string; // ISO8601
}

/**
 * EvidenceSearchMode — 检索模式。
 * Source: §4.5 / §5.3.
 */
export type EvidenceSearchMode = 'lexical' | 'semantic' | 'hybrid';

/**
 * EvidenceSearchScope — 检索范围。
 * Source: §4.5 (EvidenceSearchOptions.scope)。
 */
export type EvidenceSearchScope = 'all' | 'project' | 'global';

/**
 * EvidenceSearchOptions — 检索选项。
 * Source: §4.5.
 */
export interface EvidenceSearchOptions {
  kind?: EvidenceKind;
  mode?: EvidenceSearchMode;
  limit?: number;
  scope?: EvidenceSearchScope;
}

/**
 * EvidenceSearchResult — 检索结果（含解释 meta）。
 * Source: §4.5.
 */
export interface EvidenceSearchResult {
  items: EvidenceItem[];
  meta: {
    effectiveMode: EvidenceSearchMode;
    degraded: boolean;
    degradeReason?: string;
  };
}
