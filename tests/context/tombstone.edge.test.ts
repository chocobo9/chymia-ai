// M7 QA — tombstone edge/adversarial gate. Probes keyword extraction (stopwords,
// length filter, frequency sort, tie-break, cap), participants, retrieval hints,
// and the formatted output. Authored independently of M7 product code (dev≠QA).

import { describe, it, expect } from 'vitest';
import type { HierarchicalContextConfig } from '@choco/shared';
import { DEFAULT_HIERARCHICAL_CONTEXT_CONFIG } from '@choco/shared';
import { buildTombstone, formatTombstone } from '@choco/api/context/tombstone';
import { CLAUDE, CODEX, makeMessage, resolveConfig, THREAD_ID } from './fixtures';

function cfg(over?: Partial<HierarchicalContextConfig>): HierarchicalContextConfig {
  return { ...DEFAULT_HIERARCHICAL_CONTEXT_CONFIG, ...over };
}

describe('buildTombstone (edge)', () => {
  it('returns null when no messages were omitted', () => {
    expect(buildTombstone([], 'TODO API 设计', cfg())).toBeNull();
  });

  it('drops English stopwords and sub-3-char tokens from keywords', () => {
    const omitted = [
      makeMessage({
        agentId: CLAUDE,
        content: 'the database schema is good with migration',
        offsetMin: 0,
      }),
    ];
    const ts = buildTombstone(omitted, 'TODO API', cfg());
    expect(ts?.keywords).toContain('database');
    expect(ts?.keywords).toContain('migration');
    expect(ts?.keywords).not.toContain('the');
    expect(ts?.keywords).not.toContain('with');
    expect(ts?.keywords).not.toContain('is');
  });

  it('ranks keywords by descending frequency', () => {
    const omitted = [
      makeMessage({
        agentId: CLAUDE,
        content: 'schema schema schema database database migration',
        offsetMin: 0,
      }),
    ];
    const ts = buildTombstone(omitted, 'TODO API', cfg());
    expect(ts?.keywords).toEqual(['schema', 'database', 'migration']);
  });

  it('breaks frequency ties alphabetically (localeCompare asc)', () => {
    const omitted = [makeMessage({ agentId: CLAUDE, content: 'zebra alpha', offsetMin: 0 })];
    const ts = buildTombstone(omitted, 'TODO API', cfg());
    expect(ts?.keywords).toEqual(['alpha', 'zebra']);
  });

  it('caps keywords at config.maxTombstoneKeywords', () => {
    const omitted = [
      makeMessage({
        agentId: CLAUDE,
        content: 'alpha bravo charlie delta echo foxtrot',
        offsetMin: 0,
      }),
    ];
    const ts = buildTombstone(omitted, 'TODO API', cfg({ maxTombstoneKeywords: 2 }));
    expect(ts?.keywords).toHaveLength(2);
  });

  it('extracts CJK keyword runs of length >= 3', () => {
    const omitted = [
      makeMessage({ agentId: CLAUDE, content: '数据库选型 数据库选型 接口设计', offsetMin: 0 }),
    ];
    const ts = buildTombstone(omitted, 'TODO API', cfg());
    expect(ts?.keywords).toEqual(['数据库选型', '接口设计']);
  });

  it('lists unique agent participants and excludes the user', () => {
    const omitted = [
      makeMessage({ agentId: null, content: '用户提问', offsetMin: 0 }),
      makeMessage({ agentId: CLAUDE, content: 'Claude reply one', offsetMin: 1 }),
      makeMessage({ agentId: CLAUDE, content: 'Claude reply two', offsetMin: 2 }),
      makeMessage({ agentId: CODEX, content: 'Codex review', offsetMin: 3 }),
    ];
    const ts = buildTombstone(omitted, 'TODO API', cfg(), { resolveConfig });
    expect(ts?.participants).toEqual(['Claude', 'Codex']);
  });

  it('embeds the threadId into the retrieval hint when provided', () => {
    const omitted = [makeMessage({ agentId: CLAUDE, content: 'database schema migration', offsetMin: 0 })];
    const ts = buildTombstone(omitted, 'TODO API', cfg(), { threadId: THREAD_ID });
    expect(ts?.retrievalHints[0]).toContain(`threadId="${THREAD_ID}"`);
    expect(ts?.retrievalHints[0]).toContain('search_evidence(');
  });

  it('omits threadId from the retrieval hint when not provided', () => {
    const omitted = [makeMessage({ agentId: CLAUDE, content: 'database schema', offsetMin: 0 })];
    const ts = buildTombstone(omitted, 'TODO API', cfg());
    expect(ts?.retrievalHints[0]).not.toContain('threadId=');
    expect(ts?.retrievalHints[0]).toContain('search_evidence("');
  });

  it('falls back to the thread title for the hint when no keywords survive', () => {
    const omitted = [makeMessage({ agentId: CLAUDE, content: 'is to be a an', offsetMin: 0 })];
    const ts = buildTombstone(omitted, '数据库选型讨论', cfg());
    expect(ts?.keywords).toEqual([]);
    expect(ts?.retrievalHints[0]).toContain('数据库选型讨论');
  });

  it('records the time range from the first and last omitted messages', () => {
    const first = makeMessage({ agentId: CLAUDE, content: 'database 起点', offsetMin: 0 });
    const last = makeMessage({ agentId: CODEX, content: 'database 终点', offsetMin: 5 });
    const ts = buildTombstone([first, last], 'TODO API', cfg());
    expect(ts?.timeRange.from).toBe(first.timestamp);
    expect(ts?.timeRange.to).toBe(last.timestamp);
  });
});

describe('buildTombstone / formatTombstone (adversarial)', () => {
  it('shows "用户" as participants when only the user was omitted', () => {
    const omitted = [
      makeMessage({ agentId: null, content: 'database 怎么选？', offsetMin: 0 }),
      makeMessage({ agentId: null, content: 'schema 怎么定？', offsetMin: 1 }),
    ];
    const ts = buildTombstone(omitted, 'TODO API', cfg(), { resolveConfig });
    if (ts === null) throw new Error('expected a tombstone');
    expect(ts.participants).toEqual([]);
    expect(formatTombstone(ts)).toContain('Participants: 用户.');
  });

  it('renders "N/A" keywords for whitespace/punctuation-only content', () => {
    const omitted = [makeMessage({ agentId: CLAUDE, content: '   ！！！ ——— ???   ', offsetMin: 0 })];
    const ts = buildTombstone(omitted, 'TODO API', cfg());
    if (ts === null) throw new Error('expected a tombstone');
    expect(ts.keywords).toEqual([]);
    expect(formatTombstone(ts)).toContain('Keywords: N/A.');
  });

  it('reports the omitted count and a HH:MM–HH:MM range in the formatted line', () => {
    const omitted = [
      makeMessage({ agentId: CLAUDE, content: 'database schema', offsetMin: 0 }),
      makeMessage({ agentId: CLAUDE, content: 'migration script', offsetMin: 30 }),
    ];
    const ts = buildTombstone(omitted, 'TODO API', cfg());
    if (ts === null) throw new Error('expected a tombstone');
    const line = formatTombstone(ts);
    expect(line).toContain('skipped 2 messages');
    expect(line).toMatch(/\d{2}:\d{2}–\d{2}:\d{2}/);
  });
});
