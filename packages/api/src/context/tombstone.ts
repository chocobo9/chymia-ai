// Tombstone — compressed summary of omitted (skipped) messages.
//
// Source: clowder-design-supplement.md §B1a (ContextTombstone: 从被省略消息中按词频
// 提取关键词，去停用词、最少 3 字符、按频率排序、capped by maxTombstoneKeywords; +
// 检索提示 retrievalHints). Format target ~40 tokens.
//
// WHY (research, from Clowder context-transport.ts buildTombstone): zero-LLM-cost
// keyword extraction by word frequency over omitted content, plus a
// search_evidence(...) retrieval hint so the model can recover detail on demand.
// Re-authored against our StoredMessage (agentId instead of catId).

import type {
  ContextTombstone,
  HierarchicalContextConfig,
  StoredMessage,
} from '@choco/shared';
import { formatPromptTimeRange, getSenderName, type ResolveAgentConfig } from './context-assembler.js';

/** Minimum keyword length (chars) — drops noise like 'is'/'的'. Source: §B1a (最少 3 字符). */
const MIN_KEYWORD_LENGTH = 3;

/**
 * English stopwords dropped during keyword extraction. CJK keywords rely on the
 * length filter (Chinese carries meaning in ≥2-char words; we keep ≥3 to match
 * the design's "最少 3 字符" rule uniformly). Source: Clowder STOP_WORDS list.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'shall', 'can', 'need', 'must', 'and', 'but', 'or', 'not',
  'nor', 'for', 'into', 'about', 'over', 'under', 'then', 'than', 'that', 'this',
  'these', 'those', 'its', 'our', 'your', 'them', 'what', 'which', 'who', 'whom',
  'how', 'when', 'where', 'why', 'all', 'each', 'every', 'both', 'few', 'more',
  'most', 'some', 'any', 'just', 'also', 'very', 'too', 'only', 'still', 'here',
  'there', 'because', 'while', 'after', 'before', 'with', 'from',
]);

/** Tokenize content into candidate keywords (lowercased, latin+CJK runs). */
function extractWords(content: string): string[] {
  return content
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .filter((w) => w.length >= MIN_KEYWORD_LENGTH && !STOP_WORDS.has(w));
}

/**
 * Build a tombstone for the omitted messages, or null when none were omitted.
 * Keywords are frequency-ranked and capped at config.maxTombstoneKeywords.
 */
export function buildTombstone(
  omitted: readonly StoredMessage[],
  threadTitle: string,
  config: HierarchicalContextConfig,
  options?: { threadId?: string; resolveConfig?: ResolveAgentConfig },
): ContextTombstone | null {
  if (omitted.length === 0) return null;

  const first = omitted[0];
  const last = omitted[omitted.length - 1];
  if (first === undefined || last === undefined) return null;

  const participants = [
    ...new Set(
      omitted
        .filter((m) => m.agentId !== null)
        .map((m) => getSenderName(m.agentId, options?.resolveConfig)),
    ),
  ];

  const wordCounts = new Map<string, number>();
  for (const msg of omitted) {
    for (const word of extractWords(msg.content)) {
      wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
    }
  }

  const keywords = [...wordCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, config.maxTombstoneKeywords)
    .map(([word]) => word);

  const keywordHint = keywords.length > 0 ? keywords.slice(0, 2).join(' ') : threadTitle;
  const retrievalHints = [
    options?.threadId
      ? `search_evidence("${keywordHint}", threadId="${options.threadId}")`
      : `search_evidence("${keywordHint}")`,
  ];

  return {
    omittedCount: omitted.length,
    timeRange: { from: first.timestamp, to: last.timestamp },
    participants,
    keywords,
    retrievalHints,
  };
}

/** Format a tombstone as a compact one-line context string (~40 tokens). */
export function formatTombstone(tombstone: ContextTombstone): string {
  const range = formatPromptTimeRange(tombstone.timeRange.from, tombstone.timeRange.to);
  return [
    `[System: skipped ${tombstone.omittedCount} messages (${range}).`,
    `Participants: ${tombstone.participants.join(', ') || '用户'}.`,
    `Keywords: ${tombstone.keywords.join(', ') || 'N/A'}.`,
    `For details: ${tombstone.retrievalHints.join('; ')}]`,
  ].join(' ');
}
