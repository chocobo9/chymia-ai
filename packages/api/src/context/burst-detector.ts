// Burst detection — find the most-recent interaction burst from the message tail.
//
// Source: clowder-design-supplement.md §B1a ("Burst 检测": 从消息尾部向前走，找到
// >= burstSilenceGapMs 的沉默间隔 → 间隔后的消息是 burst; 语义链保护: 不在 Q→A 或
// tool_use→tool_result 之间切割; 保证 minBurstMessages, 上限 maxBurstMessages).
//
// WHY (research, from Clowder context-transport.ts detectRecentBurst): the cut
// walks backward to the first qualifying silence gap, then the cut point is
// pulled earlier to avoid splitting semantic chains. We re-author it against our
// StoredMessage shape (agentId instead of catId; tool events via extra).

import type { HierarchicalContextConfig, StoredMessage } from '@choco/shared';
import { hasToolResult, hasToolUse } from './tool-scrub.js';

export interface BurstResult {
  /** Most-recent contiguous burst of messages (chronological order). */
  burst: StoredMessage[];
  /** Messages before the burst (candidates for tombstone/anchors). */
  omitted: StoredMessage[];
}

/**
 * Detect the most-recent burst. Walks backward from the tail to the first
 * silence gap >= burstSilenceGapMs (only once the tail already holds at least
 * minBurstMessages), caps the burst at maxBurstMessages, protects semantic
 * chains at the boundary, and guarantees minBurstMessages.
 */
export function detectRecentBurst(
  messages: readonly StoredMessage[],
  config: HierarchicalContextConfig,
): BurstResult {
  const len = messages.length;
  if (len === 0) return { burst: [], omitted: [] };

  // 1. Find a silence gap from the tail backward.
  let cutIndex = 0; // default: whole history is one burst
  for (let i = len - 1; i > 0; i--) {
    const gap = (messages[i]?.timestamp ?? 0) - (messages[i - 1]?.timestamp ?? 0);
    const tailCount = len - i;
    if (gap >= config.burstSilenceGapMs && tailCount >= config.minBurstMessages) {
      cutIndex = i;
      break;
    }
  }

  // 2. Cap burst length to maxBurstMessages.
  let burstStart = cutIndex;
  if (len - cutIndex > config.maxBurstMessages) {
    burstStart = len - config.maxBurstMessages;
  }

  // 3. Semantic-chain protection: never split Q→A or tool_use→tool_result.
  burstStart = protectSemanticChains(messages, burstStart);

  // 4. Guarantee minBurstMessages.
  if (len - burstStart < config.minBurstMessages) {
    burstStart = Math.max(0, len - config.minBurstMessages);
  }

  return {
    burst: messages.slice(burstStart),
    omitted: messages.slice(0, burstStart),
  };
}

/**
 * Pull the cut point earlier so it does not split a semantic chain:
 * - tool_use → tool_result: if first-in-burst has a tool_result and the preceding
 *   message has a tool_use, include the preceding message.
 * - Q → A: if first-in-burst is an agent reply and the preceding message is a
 *   user message, include the preceding question.
 * Recurses so multi-step chains stay intact.
 */
function protectSemanticChains(messages: readonly StoredMessage[], burstStart: number): number {
  if (burstStart <= 0) return burstStart;
  const firstInBurst = messages[burstStart];
  const preceding = messages[burstStart - 1];
  if (firstInBurst === undefined || preceding === undefined) return burstStart;

  if (hasToolResult(firstInBurst) && hasToolUse(preceding)) {
    return protectSemanticChains(messages, burstStart - 1);
  }
  // agentId !== null = agent reply; preceding agentId === null = user question.
  if (firstInBurst.agentId !== null && preceding.agentId === null) {
    return protectSemanticChains(messages, burstStart - 1);
  }
  return burstStart;
}
