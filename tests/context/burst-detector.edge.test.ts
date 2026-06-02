// M7 QA — burst-detector edge/adversarial gate. Probes the silence-gap cut,
// minBurst/maxBurst bounds, and semantic-chain protection (Q→A, tool_use→tool_result).
// Authored independently of the M7 product code (dev≠QA).

import { describe, it, expect } from 'vitest';
import type { HierarchicalContextConfig } from '@choco/shared';
import { DEFAULT_HIERARCHICAL_CONTEXT_CONFIG } from '@choco/shared';
import { detectRecentBurst } from '@choco/api/context/burst-detector';
import { CLAUDE, CODEX, makeMessage } from './fixtures';

const GAP_MIN = 20; // 20 min > 15 min default burstSilenceGapMs
function cfg(over?: Partial<HierarchicalContextConfig>): HierarchicalContextConfig {
  return { ...DEFAULT_HIERARCHICAL_CONTEXT_CONFIG, ...over };
}

describe('detectRecentBurst (edge)', () => {
  it('treats a fully-clustered short thread as one burst (no omitted)', () => {
    const msgs = Array.from({ length: 6 }, (_, i) =>
      makeMessage({ agentId: i % 2 === 0 ? null : CLAUDE, content: `紧凑对话 #${i}`, offsetMin: i }),
    );
    const { burst, omitted } = detectRecentBurst(msgs, cfg());
    expect(burst).toHaveLength(6);
    expect(omitted).toHaveLength(0);
  });

  it('cuts at a qualifying silence gap once the tail holds >= minBurst messages', () => {
    const head = Array.from({ length: 6 }, (_, i) =>
      makeMessage({ agentId: i % 2 === 0 ? null : CLAUDE, content: `早段 #${i}`, offsetMin: i }),
    );
    const tail = Array.from({ length: 4 }, (_, i) =>
      makeMessage({ agentId: null, content: `近段 #${i}`, offsetMin: 5 + GAP_MIN + i }),
    );
    const { burst, omitted } = detectRecentBurst([...head, ...tail], cfg());
    expect(burst).toHaveLength(4);
    expect(omitted).toHaveLength(6);
    expect(burst[0]?.content).toBe('近段 #0');
  });

  it('caps the burst at maxBurstMessages when the whole tail is one cluster', () => {
    const msgs = Array.from({ length: 20 }, (_, i) =>
      makeMessage({ agentId: i % 2 === 0 ? null : CLAUDE, content: `连续 #${i}`, offsetMin: i }),
    );
    const { burst, omitted } = detectRecentBurst(msgs, cfg());
    expect(burst).toHaveLength(12); // maxBurstMessages
    expect(omitted).toHaveLength(8);
  });

  it('ignores a silence gap whose tail is shorter than minBurstMessages', () => {
    // Gap right before the final 2 messages (tail=2 < minBurst 4) must NOT be the cut;
    // with no other qualifying gap the whole thread stays one burst (not just the 2 tail msgs).
    const head = Array.from({ length: 8 }, (_, i) =>
      makeMessage({ agentId: null, content: `主体 #${i}`, offsetMin: i }),
    );
    const tail = [
      makeMessage({ agentId: CLAUDE, content: '迟到回复 A', offsetMin: 7 + GAP_MIN }),
      makeMessage({ agentId: CLAUDE, content: '迟到回复 B', offsetMin: 7 + GAP_MIN + 1 }),
    ];
    const { burst, omitted } = detectRecentBurst([...head, ...tail], cfg());
    expect(burst).toHaveLength(10); // gap ignored → whole thread is the burst
    expect(omitted).toHaveLength(0);
    expect(burst.length).not.toBe(2);
  });

  it('cuts exactly at the gap == burstSilenceGapMs boundary (>=)', () => {
    const head = Array.from({ length: 5 }, (_, i) =>
      makeMessage({ agentId: null, content: `H#${i}`, offsetMin: i }),
    );
    // gap of exactly 15 min (== default) before a 4-message tail.
    const tail = Array.from({ length: 4 }, (_, i) =>
      makeMessage({ agentId: null, content: `T#${i}`, offsetMin: 4 + 15 + i }),
    );
    const { burst } = detectRecentBurst([...head, ...tail], cfg());
    expect(burst).toHaveLength(4);
    expect(burst[0]?.content).toBe('T#0');
  });

  it('protects a Q→A chain: the user question is pulled into the burst', () => {
    const c = cfg({ minBurstMessages: 2 });
    const msgs = [
      makeMessage({ agentId: null, content: '开场', offsetMin: 0 }),
      makeMessage({ agentId: CLAUDE, content: '布偶猫回应开场', offsetMin: 1 }),
      makeMessage({ agentId: null, content: '请 review 一下迁移脚本', offsetMin: 2 }), // question
      makeMessage({ agentId: CODEX, content: '缅因猫迟到的 review 回复', offsetMin: 2 + GAP_MIN }), // answer after gap
      makeMessage({ agentId: null, content: '收到', offsetMin: 3 + GAP_MIN }),
      makeMessage({ agentId: CLAUDE, content: '布偶猫补索引', offsetMin: 4 + GAP_MIN }),
    ];
    const { burst } = detectRecentBurst(msgs, c);
    // Natural cut is at the agent answer (index 3); protection pulls in the user question (index 2).
    expect(burst[0]?.content).toBe('请 review 一下迁移脚本');
  });

  it('protects a tool_use→tool_result chain: the tool_use message is pulled in', () => {
    const c = cfg({ minBurstMessages: 2 });
    const msgs = [
      makeMessage({ agentId: CLAUDE, content: '布偶猫起手', offsetMin: 0 }),
      makeMessage({
        agentId: CODEX,
        content: '缅因猫发起读取',
        offsetMin: 1,
        toolEvents: [{ type: 'tool_use', label: 'read_file' }],
      }),
      makeMessage({
        agentId: CODEX,
        content: '读取结果（迟到，gap 后）',
        offsetMin: 1 + GAP_MIN,
        toolEvents: [{ type: 'tool_result', label: 'read_file' }],
      }),
      makeMessage({ agentId: null, content: '好的', offsetMin: 2 + GAP_MIN }),
      makeMessage({ agentId: CODEX, content: '缅因猫结论', offsetMin: 3 + GAP_MIN }),
    ];
    const { burst } = detectRecentBurst(msgs, c);
    expect(burst[0]?.content).toBe('缅因猫发起读取'); // tool_use not split from its tool_result
  });

  it('honours a custom larger minBurstMessages floor', () => {
    const msgs = Array.from({ length: 10 }, (_, i) =>
      makeMessage({ agentId: null, content: `M#${i}`, offsetMin: i }),
    );
    const { burst } = detectRecentBurst(msgs, cfg({ minBurstMessages: 6, maxBurstMessages: 6 }));
    expect(burst).toHaveLength(6);
  });

  it('honours a custom smaller maxBurstMessages cap (above the minBurst floor)', () => {
    const msgs = Array.from({ length: 10 }, (_, i) =>
      makeMessage({ agentId: null, content: `M#${i}`, offsetMin: i }),
    );
    // cap 5 < default 12 and > minBurst 4, so the cap (not the floor) binds.
    const { burst, omitted } = detectRecentBurst(msgs, cfg({ maxBurstMessages: 5 }));
    expect(burst).toHaveLength(5);
    expect(omitted).toHaveLength(5);
  });
});

describe('detectRecentBurst (adversarial)', () => {
  it('returns empty partitions for an empty thread', () => {
    expect(detectRecentBurst([], cfg())).toEqual({ burst: [], omitted: [] });
  });

  it('treats a single message as the whole burst', () => {
    const msgs = [makeMessage({ agentId: null, content: '只有一条', offsetMin: 0 })];
    const { burst, omitted } = detectRecentBurst(msgs, cfg());
    expect(burst).toHaveLength(1);
    expect(omitted).toHaveLength(0);
  });

  it('does not cut on duplicate timestamps (gap == 0)', () => {
    const msgs = Array.from({ length: 6 }, (_, i) =>
      makeMessage({ agentId: null, content: `同时刻 #${i}`, offsetMin: 0 }),
    );
    const { burst, omitted } = detectRecentBurst(msgs, cfg());
    expect(burst).toHaveLength(6);
    expect(omitted).toHaveLength(0);
  });

  it('does not cut on a negative gap (out-of-order timestamps)', () => {
    const msgs = [
      makeMessage({ agentId: null, content: '晚到却排前', offsetMin: 100 }),
      makeMessage({ agentId: null, content: '早到却排后 #1', offsetMin: 0 }),
      makeMessage({ agentId: null, content: '早到却排后 #2', offsetMin: 1 }),
      makeMessage({ agentId: null, content: '早到却排后 #3', offsetMin: 2 }),
      makeMessage({ agentId: null, content: '早到却排后 #4', offsetMin: 3 }),
    ];
    const { burst } = detectRecentBurst(msgs, cfg());
    // No forward gap >= threshold → whole history is the burst (within cap).
    expect(burst.length).toBe(5);
  });
});
