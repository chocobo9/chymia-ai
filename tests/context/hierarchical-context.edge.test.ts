// M7 QA — hierarchical-context edge/adversarial gate. Probes the cold-mention gate
// (count AND token thresholds + boundaries), the budget truncation order invariant,
// evidence fail-open integration, and degenerate threads. dev≠QA.

import { describe, it, expect } from 'vitest';
import type { EvidenceSearchResult, HierarchicalContextConfig } from '@clowder/shared';
import { DEFAULT_HIERARCHICAL_CONTEXT_CONFIG } from '@clowder/shared';
import { buildHierarchicalContext } from '@clowder/api/context/hierarchical-context';
import type { EvidenceRecaller } from '@clowder/api/context/evidence-recall';
import { build25MessageThread, CLAUDE, makeMessage, resolveConfig } from './fixtures';

const DROP_ORDER = ['evidence', 'coverageMap', 'anchors', 'tombstone', 'burst'] as const;

function cfg(over?: Partial<HierarchicalContextConfig>): HierarchicalContextConfig {
  return { ...DEFAULT_HIERARCHICAL_CONTEXT_CONFIG, ...over };
}

function staticStore(): EvidenceRecaller {
  const r: EvidenceSearchResult = {
    items: [
      {
        anchor: 'decision:fastify',
        kind: 'decision',
        status: 'active',
        title: 'API 框架选型：Fastify',
        summary: '确定用 Fastify。',
        updatedAt: '2026-05-30T14:00:00Z',
      },
    ],
    meta: { effectiveMode: 'hybrid', degraded: false },
  };
  return { search: () => r };
}

function shortThread(n: number): ReturnType<typeof makeMessage>[] {
  return Array.from({ length: n }, (_, i) =>
    makeMessage({ agentId: i % 2 === 0 ? null : CLAUDE, content: `短消息 #${i}`, offsetMin: i }),
  );
}

const CURRENT = '现在 database schema 怎么样了？';

describe('buildHierarchicalContext cold-mention gate (edge)', () => {
  it('engages the smart window on the TOKEN threshold even with few messages', async () => {
    const messages = [
      makeMessage({ agentId: null, content: 'a'.repeat(14_000), offsetMin: 0 }),
      makeMessage({ agentId: CLAUDE, content: 'a'.repeat(14_000), offsetMin: 1 }),
      makeMessage({ agentId: null, content: 'a'.repeat(14_000), offsetMin: 2 }),
    ];
    const result = await buildHierarchicalContext({
      messages,
      threadTitle: 'TODO API',
      currentUserMessage: CURRENT,
      maxContextTokens: 100_000,
    });
    expect(result.usedSmartWindow).toBe(true); // > coldMentionTokenThreshold (10_000)
  });

  it('stays on the plain window at exactly coldMentionThreshold messages, engages just above', async () => {
    const at = await buildHierarchicalContext({
      messages: shortThread(15),
      threadTitle: 'TODO API',
      currentUserMessage: CURRENT,
    });
    const above = await buildHierarchicalContext({
      messages: shortThread(16),
      threadTitle: 'TODO API',
      currentUserMessage: CURRENT,
    });
    expect(at.usedSmartWindow).toBe(false); // 15 is NOT > 15
    expect(above.usedSmartWindow).toBe(true); // 16 > 15
  });
});

describe('buildHierarchicalContext budget truncation (edge)', () => {
  it('always drops layers as a prefix of evidence→coverageMap→anchors→tombstone→burst', async () => {
    for (const budget of [5, 60, 300, 100_000]) {
      const result = await buildHierarchicalContext({
        messages: build25MessageThread(),
        threadTitle: 'TODO API',
        currentUserMessage: CURRENT,
        evidenceStore: staticStore(),
        resolveConfig,
        maxContextTokens: budget,
      });
      expect(result.droppedLayers).toEqual(DROP_ORDER.slice(0, result.droppedLayers.length));
    }
  });

  it('partitions every message into either the burst or the tombstone (no loss)', async () => {
    const result = await buildHierarchicalContext({
      messages: build25MessageThread(),
      threadTitle: 'TODO API',
      currentUserMessage: CURRENT,
      maxContextTokens: 100_000,
    });
    expect(result.burst.length + (result.tombstone?.omittedCount ?? 0)).toBe(25);
  });

  it('fails open on a slow evidence store (no evidence lines, assembly still succeeds)', async () => {
    const slow: EvidenceRecaller = { search: () => new Promise<EvidenceSearchResult>(() => {}) };
    const result = await buildHierarchicalContext({
      messages: build25MessageThread(),
      threadTitle: 'TODO API',
      currentUserMessage: CURRENT,
      evidenceStore: slow,
      config: cfg({ evidenceRecallTimeoutMs: 20 }),
      maxContextTokens: 100_000,
    });
    expect(result.evidenceLines).toEqual([]);
    expect(result.contextText.length).toBeGreaterThan(0);
  });
});

describe('buildHierarchicalContext (adversarial)', () => {
  it('returns the empty result for a zero-message thread', async () => {
    const result = await buildHierarchicalContext({
      messages: [],
      threadTitle: 'TODO API',
      currentUserMessage: CURRENT,
    });
    expect(result.contextText).toBe('');
    expect(result.usedSmartWindow).toBe(false);
  });

  it('uses the plain window for a single-message thread', async () => {
    const result = await buildHierarchicalContext({
      messages: [makeMessage({ agentId: null, content: '@claude 写个 TODO API', offsetMin: 0 })],
      threadTitle: 'TODO API',
      currentUserMessage: CURRENT,
    });
    expect(result.usedSmartWindow).toBe(false);
  });

  it('handles a thread of only tool_use messages above the threshold without throwing', async () => {
    const messages = Array.from({ length: 16 }, (_, i) =>
      makeMessage({
        agentId: CLAUDE,
        content: `工具调用 #${i}`,
        offsetMin: i,
        toolEvents: [{ type: 'tool_use', label: 'bash' }],
      }),
    );
    const result = await buildHierarchicalContext({
      messages,
      threadTitle: 'TODO API',
      currentUserMessage: CURRENT,
      maxContextTokens: 100_000,
    });
    expect(result.usedSmartWindow).toBe(true);
  });

  it('engages the smart window for one enormous message and keeps it as the burst', async () => {
    const result = await buildHierarchicalContext({
      messages: [makeMessage({ agentId: CLAUDE, content: 'b'.repeat(45_000), offsetMin: 0 })],
      threadTitle: 'TODO API',
      currentUserMessage: CURRENT,
      maxContextTokens: 100_000,
    });
    expect(result.usedSmartWindow).toBe(true);
    expect(result.burst).toHaveLength(1);
  });

  it('does not throw on many duplicate-timestamp messages', async () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      makeMessage({ agentId: i % 2 === 0 ? null : CLAUDE, content: `同刻 #${i}`, offsetMin: 0 }),
    );
    const result = await buildHierarchicalContext({
      messages,
      threadTitle: 'TODO API',
      currentUserMessage: CURRENT,
      maxContextTokens: 100_000,
    });
    expect(result.usedSmartWindow).toBe(true);
  });

  it('covers all messages even when timestamps are out of order', async () => {
    const messages = Array.from({ length: 18 }, (_, i) =>
      makeMessage({ agentId: i % 2 === 0 ? null : CLAUDE, content: `乱序 #${i}`, offsetMin: 18 - i }),
    );
    const result = await buildHierarchicalContext({
      messages,
      threadTitle: 'TODO API',
      currentUserMessage: CURRENT,
      maxContextTokens: 100_000,
    });
    expect(result.burst.length + (result.tombstone?.omittedCount ?? 0)).toBe(18);
  });
});
