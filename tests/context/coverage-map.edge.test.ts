// M7 QA — coverage-map edge/adversarial gate. Probes nested normalization,
// defensive copying, and the formatted one-liner (thread-memory, hints, empties).
// dev≠QA.

import { describe, it, expect } from 'vitest';
import type { CoverageMapInput } from '@clowder/api/context/coverage-map';
import { buildCoverageMap, formatCoverageMap } from '@clowder/api/context/coverage-map';

function input(over?: Partial<CoverageMapInput>): CoverageMapInput {
  return {
    omitted: { count: 18, timeRange: { from: 1000, to: 2000 }, participants: ['布偶猫', '缅因猫'] },
    burst: { count: 7, timeRange: { from: 3000, to: 4000 } },
    anchorIds: ['msg_a', 'msg_b'],
    threadMemory: null,
    retrievalHints: ['search_evidence("database schema")'],
    ...over,
  };
}

describe('buildCoverageMap (edge)', () => {
  it('normalizes a flat input into the nested CoverageMap shape', () => {
    const map = buildCoverageMap(input());
    expect(map.omitted.count).toBe(18);
    expect(map.omitted.timeRange).toEqual({ from: 1000, to: 2000 });
    expect(map.burst.count).toBe(7);
    expect(map.anchorIds).toEqual(['msg_a', 'msg_b']);
  });

  it('defensively copies arrays so later input mutation does not leak in', () => {
    const src = input();
    const map = buildCoverageMap(src);
    src.omitted.participants.push('暹罗猫');
    src.anchorIds.push('msg_c');
    src.retrievalHints.push('extra');
    expect(map.omitted.participants).toEqual(['布偶猫', '缅因猫']);
    expect(map.anchorIds).toEqual(['msg_a', 'msg_b']);
    expect(map.retrievalHints).toEqual(['search_evidence("database schema")']);
  });
});

describe('formatCoverageMap (edge)', () => {
  it('includes thread-memory session count when available', () => {
    const map = buildCoverageMap(
      input({ threadMemory: { available: true, sessionsIncorporated: 2 } }),
    );
    expect(formatCoverageMap(map)).toContain('Thread memory: 2 session(s).');
  });

  it('omits the thread-memory clause when unavailable', () => {
    const map = buildCoverageMap(input({ threadMemory: null }));
    expect(formatCoverageMap(map)).not.toContain('Thread memory:');
  });

  it('falls back to 用户 when there are no omitted participants', () => {
    const map = buildCoverageMap(input({ omitted: { count: 3, timeRange: { from: 1, to: 2 }, participants: [] } }));
    expect(formatCoverageMap(map)).toContain('participants: 用户');
  });
});

describe('coverage-map (adversarial)', () => {
  it('omits the Hints clause when there are no retrieval hints', () => {
    const map = buildCoverageMap(input({ retrievalHints: [] }));
    expect(formatCoverageMap(map)).not.toContain('Hints:');
  });

  it('handles all-empty arrays without throwing', () => {
    const map = buildCoverageMap({
      omitted: { count: 0, timeRange: { from: 0, to: 0 }, participants: [] },
      burst: { count: 0, timeRange: { from: 0, to: 0 } },
      anchorIds: [],
      threadMemory: null,
      retrievalHints: [],
    });
    expect(map.anchorIds).toEqual([]);
    expect(formatCoverageMap(map)).toContain('omitted 0');
  });
});
