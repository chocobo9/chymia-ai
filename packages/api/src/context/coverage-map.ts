// Coverage map — structured description of what was omitted / kept in the window.
//
// Source: clowder-design-supplement.md §B1a (CoverageMap: omitted{count,timeRange,
// participants}, burst{count,timeRange}, anchorIds, threadMemory, retrievalHints).
//
// WHY (research, from Clowder context-transport.ts buildCoverageMap): a flat input
// object is normalized into the nested CoverageMap shape the prompt renderer reads.
// Re-authored against our frozen M1 CoverageMap type (@clowder/shared).

import type { CoverageMap, CoverageMapThreadMemory, TimeRange } from '@clowder/shared';

/** Flat input for {@link buildCoverageMap} (normalized into the nested CoverageMap). */
export interface CoverageMapInput {
  omitted: { count: number; timeRange: TimeRange; participants: string[] };
  burst: { count: number; timeRange: TimeRange };
  anchorIds: string[];
  threadMemory: CoverageMapThreadMemory | null;
  retrievalHints: string[];
}

/** Normalize a flat coverage input into the frozen {@link CoverageMap} shape. */
export function buildCoverageMap(input: CoverageMapInput): CoverageMap {
  return {
    omitted: {
      count: input.omitted.count,
      timeRange: { from: input.omitted.timeRange.from, to: input.omitted.timeRange.to },
      participants: [...input.omitted.participants],
    },
    burst: {
      count: input.burst.count,
      timeRange: { from: input.burst.timeRange.from, to: input.burst.timeRange.to },
    },
    anchorIds: [...input.anchorIds],
    threadMemory: input.threadMemory,
    retrievalHints: [...input.retrievalHints],
  };
}

/** Format a coverage map as a compact one-line context string. */
export function formatCoverageMap(map: CoverageMap): string {
  const parts = [
    `[Coverage: omitted ${map.omitted.count} (participants: ${map.omitted.participants.join(', ') || '用户'}),`,
    `burst ${map.burst.count}, anchors ${map.anchorIds.length}.`,
  ];
  if (map.threadMemory?.available) {
    parts.push(`Thread memory: ${map.threadMemory.sessionsIncorporated} session(s).`);
  }
  if (map.retrievalHints.length > 0) {
    parts.push(`Hints: ${map.retrievalHints.join('; ')}.`);
  }
  return `${parts.join(' ')}]`;
}
