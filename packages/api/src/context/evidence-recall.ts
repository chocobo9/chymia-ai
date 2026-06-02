// Evidence recall — best-effort hybrid retrieval injected into cold-mention context.
//
// Source: clowder-design-supplement.md §B1 (recallEvidence: composite query =
// thread title + 用户消息前 300 字 + 最近 2 条消息各前 200 字; search(query,
// {mode:'hybrid'}); 超时保护 fail-open; 格式化 "[Evidence: {title}] {summary}";
// capped by maxEvidenceHits) + §B1a (evidenceRecallTimeoutMs default 500).
//
// WHY (research, from Clowder context-transport.ts recallEvidence): the recall is
// strictly best-effort — any error OR a timeout returns [] so assembly never
// blocks on memory. Re-authored against our M6 search() which returns an
// EvidenceSearchResult (items + meta) and may be sync or async.

import type {
  EvidenceSearchOptions,
  EvidenceSearchResult,
  HierarchicalContextConfig,
  StoredMessage,
} from '@choco/shared';

/** Composite-query slice sizes. Source: §B1 (300 / 200 / last-2). */
const CURRENT_MESSAGE_SLICE = 300; // 用户消息前 300 字
const RECENT_MESSAGE_SLICE = 200; // 最近消息各前 200 字
const RECENT_MESSAGE_COUNT = 2; // 最近 2 条消息

/**
 * Minimal evidence-search contract consumed by recall. Structurally satisfied by
 * M6 SqliteEvidenceStore.search (sync return is assignable to the union), while
 * allowing an async store for timeout testing.
 */
export interface EvidenceRecaller {
  search(
    query: string,
    options?: EvidenceSearchOptions,
  ): EvidenceSearchResult | Promise<EvidenceSearchResult>;
}

/** Build the composite recall query from title + current message + recent tail. */
function buildCompositeQuery(
  threadTitle: string,
  currentUserMessage: string,
  recentMessages: readonly StoredMessage[],
): string {
  const recentContent = recentMessages
    .filter((m) => m.content.length > 0)
    .slice(-RECENT_MESSAGE_COUNT)
    .map((m) => m.content.slice(0, RECENT_MESSAGE_SLICE))
    .join(' ');
  return [threadTitle, currentUserMessage.slice(0, CURRENT_MESSAGE_SLICE), recentContent]
    .filter((part) => part.length > 0)
    .join(' ')
    .trim();
}

/**
 * Recall up to maxEvidenceHits evidence items for the current cold-mention turn.
 * Races the search against an evidenceRecallTimeoutMs timeout and FAILS OPEN:
 * any timeout or error yields [] (assembly proceeds without evidence).
 * Returns formatted lines: `[Evidence: {title}] {summary}`.
 */
export async function recallEvidence(
  evidenceStore: EvidenceRecaller | undefined,
  threadTitle: string,
  currentUserMessage: string,
  recentMessages: readonly StoredMessage[],
  config: HierarchicalContextConfig,
): Promise<string[]> {
  if (!evidenceStore) return [];

  const compositeQuery = buildCompositeQuery(threadTitle, currentUserMessage, recentMessages);
  if (compositeQuery.length === 0) return [];

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Promise.resolve wraps a possibly-sync search so the race is well-formed.
    const searchPromise = Promise.resolve(
      evidenceStore.search(compositeQuery, { mode: 'hybrid', limit: config.maxEvidenceHits }),
    );
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('evidence recall timeout')),
        config.evidenceRecallTimeoutMs,
      );
    });
    const result = await Promise.race([searchPromise, timeoutPromise]);
    return result.items
      .slice(0, config.maxEvidenceHits)
      .map((item) => `[Evidence: ${item.title}] ${item.summary ?? ''}`.trim());
  } catch {
    // Fail-open: timeout or any error → no evidence injected.
    return [];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
