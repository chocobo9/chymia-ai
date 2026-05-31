// Hierarchical context: scoring config, coverage map, tombstones, scored messages.
// Source: clowder-design-supplement.md §B1a (层级上下文接口定义, 从 context-transport.ts 提取).

import type { StoredMessage } from './message.js';

/**
 * HierarchicalContextConfig — 智能上下文窗口/评分的配置。
 * 所有默认值见 DEFAULT_HIERARCHICAL_CONTEXT_CONFIG。
 * Source: §B1a.
 */
export interface HierarchicalContextConfig {
  /** 未读消息数阈值：低于=普通路径，高于=智能窗口 */
  coldMentionThreshold: number;
  /** 沉默间隔（ms）用于检测 burst 边界 */
  burstSilenceGapMs: number;
  /** burst 最大消息数 */
  maxBurstMessages: number;
  /** burst 最小保证消息数 */
  minBurstMessages: number;
  /** tombstone 最大关键词数 */
  maxTombstoneKeywords: number;
  /** evidence 检索超时 ms */
  evidenceRecallTimeoutMs: number;
  /** evidence 最大命中条数 */
  maxEvidenceHits: number;
  /** token 数阈值：消息少但 token 多时也触发智能窗口 */
  coldMentionTokenThreshold: number;
  /** anchor 最大数量 */
  maxAnchors: number;
  /** thread memory token 预算 */
  maxThreadMemoryTokens: number;
}

// === HierarchicalContextConfig 各默认值常量 ===
// 全部来源: clowder-design-supplement.md §B1a (从 context-transport.ts 提取的默认值)。

export const DEFAULT_COLD_MENTION_THRESHOLD = 15; // 15 messages cold-mention threshold — Clowder context-transport default (B1a)
export const DEFAULT_BURST_SILENCE_GAP_MS = 15 * 60 * 1000; // 15 min silence gap (ms) for burst boundary — Clowder context-transport default (B1a)
export const DEFAULT_MAX_BURST_MESSAGES = 12; // 12 max burst messages — Clowder context-transport default (B1a)
export const DEFAULT_MIN_BURST_MESSAGES = 4; // 4 min guaranteed burst messages — Clowder context-transport default (B1a)
export const DEFAULT_MAX_TOMBSTONE_KEYWORDS = 4; // 4 max tombstone keywords — Clowder context-transport default (B1a)
export const DEFAULT_EVIDENCE_RECALL_TIMEOUT_MS = 500; // 500 ms evidence recall timeout (fail-open) — Clowder context-transport default (B1a)
export const DEFAULT_MAX_EVIDENCE_HITS = 3; // 3 max evidence hits — Clowder context-transport default (B1a)
export const DEFAULT_COLD_MENTION_TOKEN_THRESHOLD = 10_000; // 10_000 token cold-mention threshold — Clowder context-transport default (B1a)
export const DEFAULT_MAX_ANCHORS = 3; // 3 max anchors — Clowder context-transport default (B1a)
export const DEFAULT_MAX_THREAD_MEMORY_TOKENS = 300; // 300 token thread-memory budget — Clowder context-transport default (B1a)

/**
 * DEFAULT_HIERARCHICAL_CONTEXT_CONFIG — 上下文配置默认值聚合。
 * Source: §B1a（每项默认值见上方常量注释）。
 */
export const DEFAULT_HIERARCHICAL_CONTEXT_CONFIG: HierarchicalContextConfig = {
  coldMentionThreshold: DEFAULT_COLD_MENTION_THRESHOLD,
  burstSilenceGapMs: DEFAULT_BURST_SILENCE_GAP_MS,
  maxBurstMessages: DEFAULT_MAX_BURST_MESSAGES,
  minBurstMessages: DEFAULT_MIN_BURST_MESSAGES,
  maxTombstoneKeywords: DEFAULT_MAX_TOMBSTONE_KEYWORDS,
  evidenceRecallTimeoutMs: DEFAULT_EVIDENCE_RECALL_TIMEOUT_MS,
  maxEvidenceHits: DEFAULT_MAX_EVIDENCE_HITS,
  coldMentionTokenThreshold: DEFAULT_COLD_MENTION_TOKEN_THRESHOLD,
  maxAnchors: DEFAULT_MAX_ANCHORS,
  maxThreadMemoryTokens: DEFAULT_MAX_THREAD_MEMORY_TOKENS,
} as const;

/**
 * TimeRange — 一段时间区间（epoch ms）。
 * Source: §B1a（CoverageMap / ContextTombstone 内联结构）。
 */
export interface TimeRange {
  from: number;
  to: number;
}

/**
 * CoverageMapThreadMemory — coverage map 的 thread memory 摘要部分。
 * Source: §B1a (CoverageMap.threadMemory)。
 */
export interface CoverageMapThreadMemory {
  available: boolean;
  sessionsIncorporated: number;
  decisions?: string[];
  openQuestions?: string[];
}

/**
 * CoverageMap — 覆盖图（描述哪些消息被省略/纳入 burst/作为 anchor）。
 * Source: §B1a.
 */
export interface CoverageMap {
  omitted: { count: number; timeRange: TimeRange; participants: string[] };
  burst: { count: number; timeRange: TimeRange };
  anchorIds: string[];
  threadMemory: CoverageMapThreadMemory | null;
  retrievalHints: string[];
}

/**
 * ContextTombstone — 墓碑（被省略消息的压缩摘要）。
 * Source: §B1a.
 */
export interface ContextTombstone {
  omittedCount: number;
  timeRange: TimeRange;
  participants: string[];
  /** 从被省略消息中按词频提取的关键词（去停用词、最少 3 字符） */
  keywords: string[];
  /** 检索提示（如 'search_evidence("关键词", threadId="xxx")'） */
  retrievalHints: string[];
}

/**
 * ImportanceSignals — 计算消息重要性的评分分量。
 * Source: §B1a.
 */
export interface ImportanceSignals {
  structural: number; // 代码块 +3、@mention +2、tool event +2、长内容 +1
  positional: number; // thread 第一条 +5
  relevance: number; // 匹配查询关键词 +1/term
}

/**
 * ScoredMessage — 评分后的消息（总分 = structural + positional + relevance）。
 * Source: §B1a.
 */
export interface ScoredMessage {
  message: StoredMessage;
  score: number;
  signals: ImportanceSignals;
  isPrimacy: boolean; // 是否是 thread 第一条消息
}
