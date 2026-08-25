import { describe, it, expect } from 'vitest';
import type { HierarchicalContextConfig } from '@choco/shared';
import { DEFAULT_HIERARCHICAL_CONTEXT_CONFIG } from '@choco/shared';
import { detectRecentBurst } from '@choco/api/context/burst-detector';
import { CLAUDE, CODEX, makeMessage, build25MessageThread } from './fixtures';

/** Config with a small min-burst so the cut lands precisely on crafted chains. */
const chainConfig: HierarchicalContextConfig = {
  ...DEFAULT_HIERARCHICAL_CONTEXT_CONFIG,
  minBurstMessages: 1,
  burstSilenceGapMs: 10 * 60 * 1000,
};

describe('detectRecentBurst (unit, happy path)', () => {
  it('cuts at the silence gap on a real 25-message thread', () => {
    const { burst, omitted } = detectRecentBurst(
      build25MessageThread(),
      DEFAULT_HIERARCHICAL_CONTEXT_CONFIG,
    );
    expect(omitted).toHaveLength(18);
    expect(burst).toHaveLength(7);
    // Burst opens with the user handing review to @codex.
    expect(burst[0]?.content).toContain('@codex');
  });

  it('semantic-chain protection: Q→A pair is not split', () => {
    const msgs = [
      makeMessage({ agentId: null, content: '项目启动：先定 API 边界。', offsetMin: 0 }),
      makeMessage({ agentId: CLAUDE, content: 'Claude：API 边界我来定。', offsetMin: 1 }),
      makeMessage({ agentId: null, content: '@claude database schema 怎么设计？', mentions: [CLAUDE], offsetMin: 2 }),
      // 18-minute gap before the answer → naive cut would land on the answer alone.
      makeMessage({ agentId: CLAUDE, content: 'Claude：schema 用 todos 表，加 created_at 索引。', offsetMin: 20 }),
    ];
    const { burst, omitted } = detectRecentBurst(msgs, chainConfig);
    expect(burst).toHaveLength(2);
    expect(burst[0]?.content).toContain('怎么设计'); // question pulled in
    expect(burst[1]?.content).toContain('schema 用 todos'); // answer
    expect(omitted).toHaveLength(2);
  });

  it('semantic-chain protection: tool_use→tool_result pair is not split', () => {
    const msgs = [
      // Agent opener (not a user message) so Q→A protection does not also pull it in;
      // keeps this test focused on the tool_use→tool_result chain.
      makeMessage({ agentId: CODEX, content: 'Codex：准备 review 迁移脚本。', offsetMin: 0 }),
      makeMessage({
        agentId: CODEX,
        content: 'Codex：开始读取迁移脚本。',
        offsetMin: 1,
        toolEvents: [{ type: 'tool_use', label: 'read_file' }],
      }),
      // 19-minute gap → naive cut would split the tool call from its result.
      makeMessage({
        agentId: CODEX,
        content: 'Codex：迁移脚本读取完成，内容是 CREATE TABLE todos ...',
        offsetMin: 20,
        toolEvents: [{ type: 'tool_result', label: 'read_file' }],
      }),
    ];
    const { burst, omitted } = detectRecentBurst(msgs, chainConfig);
    expect(burst).toHaveLength(2);
    expect(burst[0]?.content).toContain('开始读取'); // tool_use pulled in
    expect(omitted).toHaveLength(1);
  });
});
