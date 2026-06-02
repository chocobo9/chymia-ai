import { describe, it, expect } from 'vitest';
import type { EvidenceSearchResult } from '@choco/shared';
import { DEFAULT_HIERARCHICAL_CONTEXT_CONFIG } from '@choco/shared';
import {
  buildHierarchicalContext,
  extractQueryTerms,
} from '@choco/api/context/hierarchical-context';
import type { EvidenceRecaller } from '@choco/api/context/evidence-recall';
import { build25MessageThread, CLAUDE, makeMessage, resolveConfig, THREAD_ID } from './fixtures';

function evidenceStore(): EvidenceRecaller {
  const result: EvidenceSearchResult = {
    items: [
      {
        anchor: 'decision:2026-05-30-fastify',
        kind: 'decision',
        status: 'active',
        title: 'API 框架选型：Fastify',
        summary: 'Fastify 内置 schema 校验，确定用于 TODO API。',
        updatedAt: '2026-05-30T14:00:00Z',
      },
    ],
    meta: { effectiveMode: 'hybrid', degraded: false },
  };
  return { search: () => result };
}

describe('buildHierarchicalContext (happy path)', () => {
  const currentUserMessage = '现在 database schema 怎么样了？indexes 都齐了吗？';

  it('assembles burst + tombstone + anchors + evidence for a 25-message thread', async () => {
    const result = await buildHierarchicalContext({
      messages: build25MessageThread(),
      threadTitle: 'TODO API 设计',
      currentUserMessage,
      threadId: THREAD_ID,
      evidenceStore: evidenceStore(),
      resolveConfig,
      maxContextTokens: 100_000, // generous: nothing should be dropped
    });

    expect(result.usedSmartWindow).toBe(true);
    expect(result.burst).toHaveLength(7);
    expect(result.tombstone?.omittedCount).toBe(18);
    expect(result.anchors.length).toBeGreaterThan(0);
    expect(result.anchors.some((a) => a.isPrimacy)).toBe(true); // primacy guaranteed
    expect(result.evidenceLines.length).toBeGreaterThan(0);
    expect(result.droppedLayers).toEqual([]);

    // The single contextText threads all layers together in B1 order.
    expect(result.contextText).toContain('智能窗口: 18 条已摘要, 7 条详细');
    expect(result.contextText).toContain('[System: skipped 18 messages');
    expect(result.contextText).toContain('[Related evidence]');
    expect(result.contextText).toContain('[Evidence: API 框架选型：Fastify]');
    expect(result.contextText).toContain('[/对话历史]');
  });

  it('scrubs non-terminal tool_result payloads in the burst, keeps the last verbatim', async () => {
    const result = await buildHierarchicalContext({
      messages: build25MessageThread(),
      threadTitle: 'TODO API 设计',
      currentUserMessage,
      threadId: THREAD_ID,
      resolveConfig,
      maxContextTokens: 100_000,
    });
    // The codex tool_result message is mid-burst → its content is digested.
    const scrubbed = result.burst.find((m) => m.content.includes('<tool_result truncated'));
    expect(scrubbed).toBeDefined();
    expect(scrubbed?.content).toContain('read_file executed');
  });

  it('drops layers in order evidence → coverageMap → anchors → tombstone → burst under a tiny budget', async () => {
    const result = await buildHierarchicalContext({
      messages: build25MessageThread(),
      threadTitle: 'TODO API 设计',
      currentUserMessage,
      threadId: THREAD_ID,
      evidenceStore: evidenceStore(),
      resolveConfig,
      maxContextTokens: 5, // forces every layer to be cut
    });
    expect(result.droppedLayers).toEqual([
      'evidence',
      'coverageMap',
      'anchors',
      'tombstone',
      'burst',
    ]);
  });

  it('uses the plain recent-history window below the cold-mention threshold', async () => {
    const small = [
      makeMessage({ agentId: null, content: '@claude 写一个 TODO API。', offsetMin: 0 }),
      makeMessage({ agentId: CLAUDE, content: '布偶猫：好的，我来写。', offsetMin: 1 }),
    ];
    const result = await buildHierarchicalContext({
      messages: small,
      threadTitle: 'TODO API 设计',
      currentUserMessage: '进度如何？',
      resolveConfig,
    });
    expect(result.usedSmartWindow).toBe(false);
    expect(result.tombstone).toBeNull();
    expect(result.contextText).toContain('对话历史');
  });

  it('extractQueryTerms keeps dedup terms of length ≥ 3', () => {
    const terms = extractQueryTerms('database schema 和 indexes 怎么设计 database');
    expect(terms).toContain('database');
    expect(terms).toContain('schema');
    expect(terms).toContain('indexes');
    // dedup
    expect(terms.filter((t) => t === 'database')).toHaveLength(1);
  });

  it('returns an empty result for an empty thread', async () => {
    const result = await buildHierarchicalContext({
      messages: [],
      threadTitle: 'TODO API 设计',
      currentUserMessage,
    });
    expect(result.contextText).toBe('');
    expect(result.usedSmartWindow).toBe(false);
  });
});

describe('config defaults sanity (unit)', () => {
  it('matches the frozen M1 hierarchical context defaults', () => {
    expect(DEFAULT_HIERARCHICAL_CONTEXT_CONFIG.coldMentionThreshold).toBe(15);
    expect(DEFAULT_HIERARCHICAL_CONTEXT_CONFIG.maxAnchors).toBe(3);
    expect(DEFAULT_HIERARCHICAL_CONTEXT_CONFIG.maxEvidenceHits).toBe(3);
  });
});
