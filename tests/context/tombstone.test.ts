import { describe, it, expect } from 'vitest';
import { DEFAULT_HIERARCHICAL_CONTEXT_CONFIG } from '@clowder/shared';
import { buildTombstone, formatTombstone } from '@clowder/api/context/tombstone';
import { CLAUDE, CODEX, makeMessage, resolveConfig } from './fixtures';

describe('buildTombstone (unit, happy path)', () => {
  const omitted = [
    makeMessage({
      agentId: null,
      content: 'We must design the database schema. The database is important.',
      offsetMin: 0,
    }),
    makeMessage({
      agentId: CLAUDE,
      content: 'Database indexes and schema migrations need review.',
      offsetMin: 1,
    }),
    makeMessage({
      agentId: CODEX,
      content: 'API endpoints depend on the database layer.',
      offsetMin: 2,
    }),
  ];

  it('extracts frequency-sorted keywords, dropping stopwords and short words', () => {
    const tombstone = buildTombstone(omitted, 'TODO API 设计', DEFAULT_HIERARCHICAL_CONTEXT_CONFIG, {
      threadId: 'thread-todo-api',
      resolveConfig,
    });
    expect(tombstone).not.toBeNull();
    const keywords = tombstone!.keywords;

    // Highest frequency first.
    expect(keywords[0]).toBe('database');
    expect(keywords[1]).toBe('schema');
    // Capped by maxTombstoneKeywords (4).
    expect(keywords.length).toBeLessThanOrEqual(DEFAULT_HIERARCHICAL_CONTEXT_CONFIG.maxTombstoneKeywords);
    // No stopwords, no sub-3-char words.
    for (const kw of keywords) {
      expect(kw.length).toBeGreaterThanOrEqual(3);
    }
    expect(keywords).not.toContain('the');
    expect(keywords).not.toContain('is');
    expect(keywords).not.toContain('a');
  });

  it('records omitted count, participants, and a retrieval hint with threadId', () => {
    const tombstone = buildTombstone(omitted, 'TODO API 设计', DEFAULT_HIERARCHICAL_CONTEXT_CONFIG, {
      threadId: 'thread-todo-api',
      resolveConfig,
    });
    expect(tombstone!.omittedCount).toBe(3);
    // Participants come from agent messages (resolved display names).
    expect(tombstone!.participants).toContain('布偶猫');
    expect(tombstone!.participants).toContain('缅因猫');
    expect(tombstone!.retrievalHints[0]).toContain('search_evidence(');
    expect(tombstone!.retrievalHints[0]).toContain('thread-todo-api');
  });

  it('formats a compact one-line tombstone string', () => {
    const tombstone = buildTombstone(omitted, 'TODO API 设计', DEFAULT_HIERARCHICAL_CONTEXT_CONFIG);
    const line = formatTombstone(tombstone!);
    expect(line).toContain('[System: skipped 3 messages');
    expect(line).toContain('Keywords: database');
    expect(line).toContain('For details: search_evidence(');
  });

  it('returns null when nothing was omitted', () => {
    expect(buildTombstone([], 'TODO API 设计', DEFAULT_HIERARCHICAL_CONTEXT_CONFIG)).toBeNull();
  });
});
