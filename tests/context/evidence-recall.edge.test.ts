// M7 QA — evidence-recall edge/adversarial gate. Probes the fail-open contract
// (timeout + error → []), the maxEvidenceHits cap, composite-query construction,
// and sync/async stores. Authored independently of M7 product code (dev≠QA).

import { describe, it, expect, vi, afterEach } from 'vitest';
import type {
  EvidenceItem,
  EvidenceSearchResult,
  HierarchicalContextConfig,
} from '@choco/shared';
import { DEFAULT_HIERARCHICAL_CONTEXT_CONFIG } from '@choco/shared';
import { recallEvidence, type EvidenceRecaller } from '@choco/api/context/evidence-recall';
import { makeMessage } from './fixtures';

function cfg(over?: Partial<HierarchicalContextConfig>): HierarchicalContextConfig {
  return { ...DEFAULT_HIERARCHICAL_CONTEXT_CONFIG, ...over };
}

function item(title: string, summary?: string): EvidenceItem {
  return {
    anchor: `decision:${title}`,
    kind: 'decision',
    status: 'active',
    title,
    ...(summary !== undefined ? { summary } : {}),
    updatedAt: '2026-05-30T14:00:00Z',
  };
}

function result(items: EvidenceItem[]): EvidenceSearchResult {
  return { items, meta: { effectiveMode: 'hybrid', degraded: false } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('recallEvidence (edge)', () => {
  it('returns [] when no evidence store is provided', async () => {
    expect(await recallEvidence(undefined, 'TODO API', '进度如何？', [], cfg())).toEqual([]);
  });

  it('returns [] when the composite query is empty', async () => {
    const store: EvidenceRecaller = { search: () => result([item('不该被查到')]) };
    expect(await recallEvidence(store, '', '', [], cfg())).toEqual([]);
  });

  it('formats sync-store hits as "[Evidence: title] summary" lines', async () => {
    const store: EvidenceRecaller = {
      search: () => result([item('API 框架选型：Fastify', 'Fastify 内置 schema 校验。')]),
    };
    const lines = await recallEvidence(store, 'TODO API', '用什么框架？', [], cfg());
    expect(lines).toEqual(['[Evidence: API 框架选型：Fastify] Fastify 内置 schema 校验。']);
  });

  it('caps results at config.maxEvidenceHits', async () => {
    const store: EvidenceRecaller = {
      search: () => result([item('一'), item('二'), item('三'), item('四'), item('五')]),
    };
    const lines = await recallEvidence(store, 'TODO API', 'database 设计', [], cfg({ maxEvidenceHits: 2 }));
    expect(lines).toHaveLength(2);
  });

  it('renders a hit without a summary as a trimmed "[Evidence: title]" line', async () => {
    const store: EvidenceRecaller = { search: () => result([item('无摘要决策')]) };
    const lines = await recallEvidence(store, 'TODO API', 'database 设计', [], cfg());
    expect(lines[0]).toBe('[Evidence: 无摘要决策]');
  });

  it('resolves an async store that returns within the timeout', async () => {
    const store: EvidenceRecaller = {
      search: () => Promise.resolve(result([item('异步命中', '及时返回。')])),
    };
    const lines = await recallEvidence(store, 'TODO API', 'database 设计', [], cfg());
    expect(lines).toEqual(['[Evidence: 异步命中] 及时返回。']);
  });

  it('builds the composite query from title + first 300 chars of the message + recent tail', async () => {
    let captured = '';
    const store: EvidenceRecaller = {
      search: (q) => {
        captured = q;
        return result([item('x')]);
      },
    };
    const recent = [
      makeMessage({ agentId: null, content: '较早的近消息', offsetMin: 0 }),
      makeMessage({ agentId: null, content: '最近一条标记 recent-tail-marker', offsetMin: 1 }),
    ];
    await recallEvidence(store, 'TODO API', 'A'.repeat(400), recent, cfg());
    expect(captured).toContain('TODO API');
    expect(captured).toContain('A'.repeat(300));
    expect(captured).not.toContain('A'.repeat(301)); // current message sliced to 300
    expect(captured).toContain('recent-tail-marker');
  });
});

describe('recallEvidence (adversarial)', () => {
  it('fails open to [] when the store throws synchronously', async () => {
    const store: EvidenceRecaller = {
      search: () => {
        throw new Error('sqlite is busy');
      },
    };
    expect(await recallEvidence(store, 'TODO API', 'database 设计', [], cfg())).toEqual([]);
  });

  it('fails open to [] when the store returns a rejected promise', async () => {
    const store: EvidenceRecaller = { search: () => Promise.reject(new Error('vec0 exploded')) };
    expect(await recallEvidence(store, 'TODO API', 'database 设计', [], cfg())).toEqual([]);
  });

  it('fails open to [] when the search exceeds evidenceRecallTimeoutMs', async () => {
    vi.useFakeTimers();
    const store: EvidenceRecaller = { search: () => new Promise<EvidenceSearchResult>(() => {}) };
    const pending = recallEvidence(store, 'TODO API', 'database 设计', [], cfg({ evidenceRecallTimeoutMs: 50 }));
    await vi.advanceTimersByTimeAsync(51);
    await expect(pending).resolves.toEqual([]);
  });

  it('excludes empty-content recent messages from the composite query', async () => {
    let captured = '';
    const store: EvidenceRecaller = {
      search: (q) => {
        captured = q;
        return result([item('x')]);
      },
    };
    const recent = [
      makeMessage({ agentId: null, content: '', offsetMin: 0 }),
      makeMessage({ agentId: null, content: '非空近消息内容', offsetMin: 1 }),
    ];
    await recallEvidence(store, 'TODO API', '进度？', recent, cfg());
    expect(captured).toContain('非空近消息内容');
  });
});
