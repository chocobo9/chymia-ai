import { describe, it, expect } from 'vitest';
import { buildCoverageMap, formatCoverageMap } from '@choco/api/context/coverage-map';

function makeInput() {
  return {
    omitted: { count: 18, timeRange: { from: 1_000, to: 2_000 }, participants: ['布偶猫', '缅因猫'] },
    burst: { count: 7, timeRange: { from: 3_000, to: 4_000 } },
    anchorIds: ['msg_a', 'msg_b'],
    threadMemory: { available: true, sessionsIncorporated: 2, decisions: ['用 SQLite'] },
    retrievalHints: ['search_evidence("database schema", threadId="thread-todo-api")'],
  };
}

describe('coverage map (unit, happy path)', () => {
  it('normalizes a flat input into the nested CoverageMap shape', () => {
    const input = makeInput();
    const map = buildCoverageMap(input);
    expect(map.omitted.count).toBe(18);
    expect(map.omitted.timeRange).toEqual({ from: 1_000, to: 2_000 });
    expect(map.burst.count).toBe(7);
    expect(map.anchorIds).toEqual(['msg_a', 'msg_b']);
    expect(map.threadMemory?.sessionsIncorporated).toBe(2);
    // Defensive copies — mutating the input arrays must not affect the map.
    input.anchorIds.push('msg_c');
    expect(map.anchorIds).toEqual(['msg_a', 'msg_b']);
  });

  it('formats a compact one-line coverage string', () => {
    const map = buildCoverageMap(makeInput());
    const line = formatCoverageMap(map);
    expect(line).toContain('omitted 18');
    expect(line).toContain('burst 7');
    expect(line).toContain('anchors 2');
    expect(line).toContain('Thread memory: 2 session(s)');
    expect(line).toContain('search_evidence(');
  });
});
