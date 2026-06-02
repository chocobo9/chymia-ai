import { describe, it, expect } from 'vitest';
import { scoreImportance, selectAnchors, formatAnchors } from '@choco/api/context/anchor-selector';
import { CLAUDE, CODEX, makeMessage, resolveConfig } from './fixtures';

describe('anchor selection (unit, happy path)', () => {
  const omitted = [
    // index 0: thread opener with code block + @mention → high structural + primacy.
    makeMessage({
      agentId: null,
      content:
        '@claude 搭 TODO API，schema 如下：\n```sql\nCREATE TABLE todos (id TEXT PRIMARY KEY);\n```',
      mentions: [CLAUDE],
      offsetMin: 0,
    }),
    makeMessage({ agentId: CLAUDE, content: '布偶猫：收到，先写 schema。', offsetMin: 1 }),
    makeMessage({ agentId: null, content: '索引怎么建？', offsetMin: 2 }),
    makeMessage({
      agentId: CODEX,
      content: 'review 结论：database 索引缺 created_at。'.repeat(20),
      offsetMin: 3,
      toolEvents: [{ type: 'tool_result', label: 'read_file' }],
    }),
  ];

  it('scores structural + positional + relevance signals', () => {
    const scored = scoreImportance(omitted[0]!, 0, omitted.length, ['todo', 'schema']);
    expect(scored.isPrimacy).toBe(true);
    expect(scored.signals.positional).toBe(5); // primacy
    expect(scored.signals.structural).toBeGreaterThanOrEqual(5); // code block(3) + mention(2)
    expect(scored.score).toBeGreaterThan(5);
  });

  it('guarantees the primacy anchor and returns chronological order', () => {
    const anchors = selectAnchors(omitted, ['database', 'created_at'], 3);
    expect(anchors.length).toBeLessThanOrEqual(3);
    expect(anchors.some((a) => a.isPrimacy)).toBe(true);
    // Output preserves chronological (original-index) order.
    const times = anchors.map((a) => a.message.timestamp);
    expect([...times]).toEqual([...times].sort((x, y) => x - y));
  });

  it('formats labeled anchor lines with sender and id', () => {
    const anchors = selectAnchors(omitted, ['database'], 2);
    const lines = formatAnchors(anchors, { resolveConfig });
    expect(lines[0]).toContain('Thread opener');
    expect(lines.join('\n')).toContain('用户'); // user sender label
  });

  it('returns no anchors for empty omitted set', () => {
    expect(selectAnchors([], ['x'], 3)).toEqual([]);
  });
});
