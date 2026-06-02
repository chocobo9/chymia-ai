import { describe, it, expect } from 'vitest';
import type {
  EvidenceSearchOptions,
  EvidenceSearchResult,
  HierarchicalContextConfig,
} from '@choco/shared';
import { DEFAULT_HIERARCHICAL_CONTEXT_CONFIG } from '@choco/shared';
import { recallEvidence, type EvidenceRecaller } from '@choco/api/context/evidence-recall';
import { CLAUDE, makeMessage } from './fixtures';

function searchResult(): EvidenceSearchResult {
  return {
    items: [
      {
        anchor: 'decision:2026-05-30-sqlite',
        kind: 'decision',
        status: 'active',
        title: 'API 框架选型：Fastify',
        summary: 'Fastify 性能优于 Express，schema 校验内置，确定用于 TODO API。',
        updatedAt: '2026-05-30T14:00:00Z',
      },
      {
        anchor: 'lesson:2026-05-29-index',
        kind: 'lesson',
        status: 'active',
        title: 'database 索引经验',
        summary: 'created_at 上要建索引，否则按时间排序会全表扫描。',
        updatedAt: '2026-05-29T10:00:00Z',
      },
    ],
    meta: { effectiveMode: 'hybrid', degraded: false },
  };
}

const recentMessages = [
  makeMessage({ agentId: null, content: 'TODO API 的 database schema 怎么定？', offsetMin: 0 }),
  makeMessage({ agentId: CLAUDE, content: '布偶猫：用 SQLite + WAL，schema 见上。', offsetMin: 1 }),
];

describe('recallEvidence (unit, happy path)', () => {
  it('formats hits as [Evidence: title] summary, capped by maxEvidenceHits', async () => {
    const store: EvidenceRecaller = { search: () => searchResult() };
    const lines = await recallEvidence(
      store,
      'TODO API 设计',
      'database schema 和索引怎么设计？',
      recentMessages,
      DEFAULT_HIERARCHICAL_CONTEXT_CONFIG,
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(DEFAULT_HIERARCHICAL_CONTEXT_CONFIG.maxEvidenceHits);
    expect(lines[0]).toContain('[Evidence: API 框架选型：Fastify]');
    expect(lines[0]).toContain('Fastify');
  });

  it('passes a composite query (title + message + recent) to the store', async () => {
    let received = '';
    const store: EvidenceRecaller = {
      search: (query: string, _options?: EvidenceSearchOptions) => {
        received = query;
        return searchResult();
      },
    };
    await recallEvidence(
      store,
      'TODO API 设计',
      'database schema 和索引怎么设计？',
      recentMessages,
      DEFAULT_HIERARCHICAL_CONTEXT_CONFIG,
    );
    expect(received).toContain('TODO API 设计');
    expect(received).toContain('database schema');
    expect(received).toContain('WAL'); // from recent message tail
  });

  it('fails open (returns []) when the search exceeds the recall timeout', async () => {
    const fastTimeout: HierarchicalContextConfig = {
      ...DEFAULT_HIERARCHICAL_CONTEXT_CONFIG,
      evidenceRecallTimeoutMs: 20,
    };
    const slowStore: EvidenceRecaller = {
      search: () =>
        new Promise<EvidenceSearchResult>((resolve) => setTimeout(() => resolve(searchResult()), 120)),
    };
    const lines = await recallEvidence(
      slowStore,
      'TODO API 设计',
      'database schema 和索引怎么设计？',
      recentMessages,
      fastTimeout,
    );
    expect(lines).toEqual([]);
  });

  it('returns [] when no evidence store is provided', async () => {
    const lines = await recallEvidence(
      undefined,
      'TODO API 设计',
      'database schema 怎么设计？',
      recentMessages,
      DEFAULT_HIERARCHICAL_CONTEXT_CONFIG,
    );
    expect(lines).toEqual([]);
  });
});
