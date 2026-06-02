// Anchor selection — pick the most important omitted messages to keep verbatim.
//
// Source: clowder-design-supplement.md §B1a (ImportanceSignals: 代码块 +3、@mention
// +2、tool event +2、长内容 +1; positional: thread 第一条 +5; relevance: 匹配查询
// 关键词 +1/term. 选择规则: 按 score top-N，保证 primacy(第一条)必选; 输出按时间线排序).
//
// WHY (research, from Clowder context-transport.ts scoreImportance/selectAnchors):
// zero-LLM structural+positional+relevance scoring, with an explicit primacy
// guarantee (AC-C3) so the thread opener is never dropped. Re-authored against
// our StoredMessage (mentions[], tool events via extra).

import type { ImportanceSignals, ScoredMessage, StoredMessage } from '@choco/shared';
import { getSenderName, type ResolveAgentConfig } from './context-assembler.js';
import { getToolEvents } from './tool-scrub.js';

// Importance weights. Source: §B1a (exact point values).
const CODE_BLOCK_WEIGHT = 3; // fenced code block present
const MENTION_WEIGHT = 2; // message @-mentions someone
const TOOL_EVENT_WEIGHT = 2; // message carries tool events
const LONG_CONTENT_WEIGHT = 1; // substantial content
const PRIMACY_WEIGHT = 5; // thread opener (index 0)
const RELEVANCE_WEIGHT = 1; // per matched query term

/** Content length (chars) above which a message earns the long-content signal. */
const LONG_CONTENT_THRESHOLD = 500; // Clowder threshold: content.length > 500
/** Default per-anchor display truncation when formatting anchor lines. */
const DEFAULT_ANCHOR_TRUNCATE = 200;

const CODE_BLOCK_PATTERN = /```[\s\S]*?```/;

/**
 * Score a single omitted message for importance.
 * Score = structural + positional + relevance. Zero LLM cost.
 */
export function scoreImportance(
  msg: StoredMessage,
  index: number,
  _totalOmitted: number,
  queryTerms: readonly string[],
): ScoredMessage {
  let structural = 0;
  if (CODE_BLOCK_PATTERN.test(msg.content)) structural += CODE_BLOCK_WEIGHT;
  if (msg.mentions.length > 0) structural += MENTION_WEIGHT;
  if (getToolEvents(msg).length > 0) structural += TOOL_EVENT_WEIGHT;
  if (msg.content.length > LONG_CONTENT_THRESHOLD) structural += LONG_CONTENT_WEIGHT;

  const isPrimacy = index === 0;
  const positional = isPrimacy ? PRIMACY_WEIGHT : 0;

  let relevance = 0;
  if (queryTerms.length > 0) {
    const lower = msg.content.toLowerCase();
    for (const term of queryTerms) {
      if (term.length > 0 && lower.includes(term)) relevance += RELEVANCE_WEIGHT;
    }
  }

  const signals: ImportanceSignals = { structural, positional, relevance };
  return { message: msg, score: structural + positional + relevance, signals, isPrimacy };
}

/**
 * Select up to maxAnchors anchors from omitted messages.
 * Guarantees the primacy message (index 0) is always included (AC-C3) and returns
 * anchors in chronological (original-index) order.
 */
export function selectAnchors(
  omitted: readonly StoredMessage[],
  queryTerms: readonly string[],
  maxAnchors: number,
): ScoredMessage[] {
  if (omitted.length === 0 || maxAnchors <= 0) return [];

  const scored = omitted.map((msg, i) => scoreImportance(msg, i, omitted.length, queryTerms));
  const byScore = [...scored].sort((a, b) => b.score - a.score);
  const selected = byScore.slice(0, maxAnchors);

  // Primacy guarantee (AC-C3): ensure index-0 is present, displacing the lowest.
  if (!selected.some((s) => s.isPrimacy)) {
    const primacy = scored[0];
    if (primacy !== undefined) {
      if (selected.length >= maxAnchors) selected.pop();
      selected.push(primacy);
    }
  }

  const indexMap = new Map(omitted.map((m, i) => [m.id, i]));
  selected.sort((a, b) => (indexMap.get(a.message.id) ?? 0) - (indexMap.get(b.message.id) ?? 0));
  return selected;
}

/**
 * Format anchors as labeled context lines (chronological order).
 * `[Thread opener @sender: id] content` for primacy, else `[Anchor i/N @sender: id] content`.
 */
export function formatAnchors(
  anchors: readonly ScoredMessage[],
  options?: { truncate?: number; resolveConfig?: ResolveAgentConfig },
): string[] {
  if (anchors.length === 0) return [];
  const truncate = options?.truncate ?? DEFAULT_ANCHOR_TRUNCATE;
  return anchors.map((a, i) => {
    const raw = a.message.content;
    const content = raw.length > truncate ? `${raw.slice(0, truncate)}...` : raw;
    const speaker = getSenderName(a.message.agentId, options?.resolveConfig);
    const label = a.isPrimacy ? 'Thread opener' : `Anchor ${i + 1}/${anchors.length}`;
    return `[${label} @${speaker}: ${a.message.id}] ${content}`;
  });
}
