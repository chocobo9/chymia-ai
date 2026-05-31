// M7 QA — anchor-selector edge/adversarial gate. Probes importance signal weights,
// the primacy guarantee, maxAnchors cap, chronological ordering, and anchor
// formatting. Authored independently of M7 product code (dev≠QA).

import { describe, it, expect } from 'vitest';
import { formatAnchors, scoreImportance, selectAnchors } from '@clowder/api/context/anchor-selector';
import { CLAUDE, CODEX, makeMessage, resolveConfig } from './fixtures';

describe('scoreImportance (edge)', () => {
  it('awards +3 for a fenced code block', () => {
    const msg = makeMessage({
      agentId: CLAUDE,
      content: '方案：\n```sql\nCREATE TABLE todos (id TEXT PRIMARY KEY);\n```',
      offsetMin: 1,
    });
    expect(scoreImportance(msg, 1, 5, []).signals.structural).toBe(3);
  });

  it('awards +2 for an @mention', () => {
    const msg = makeMessage({ agentId: null, content: '@codex 帮我看看', mentions: [CODEX], offsetMin: 1 });
    expect(scoreImportance(msg, 1, 5, []).signals.structural).toBe(2);
  });

  it('awards +2 for a tool event', () => {
    const msg = makeMessage({
      agentId: CODEX,
      content: '读取文件',
      offsetMin: 1,
      toolEvents: [{ type: 'tool_use', label: 'read_file' }],
    });
    expect(scoreImportance(msg, 1, 5, []).signals.structural).toBe(2);
  });

  it('awards +1 for long content (> 500 chars)', () => {
    const msg = makeMessage({ agentId: CLAUDE, content: 'x'.repeat(501), offsetMin: 1 });
    expect(scoreImportance(msg, 1, 5, []).signals.structural).toBe(1);
  });

  it('awards +5 positional for the thread opener (index 0)', () => {
    const msg = makeMessage({ agentId: null, content: '简单开场', offsetMin: 0 });
    const scored = scoreImportance(msg, 0, 5, []);
    expect(scored.signals.positional).toBe(5);
    expect(scored.isPrimacy).toBe(true);
    expect(scored.score).toBe(5);
  });

  it('awards +1 relevance per distinct matched query term', () => {
    const msg = makeMessage({ agentId: CLAUDE, content: 'database schema 已定，索引待补', offsetMin: 1 });
    const scored = scoreImportance(msg, 1, 5, ['database', 'schema', 'unused']);
    expect(scored.signals.relevance).toBe(2);
  });
});

describe('selectAnchors (edge)', () => {
  it('caps the number of anchors at maxAnchors', () => {
    const omitted = Array.from({ length: 5 }, (_, i) =>
      makeMessage({ agentId: CLAUDE, content: `候选 #${i} @codex`, mentions: [CODEX], offsetMin: i }),
    );
    expect(selectAnchors(omitted, [], 2)).toHaveLength(2);
  });

  it('guarantees the primacy message even when it would not make the top-N by score', () => {
    const omitted = [
      makeMessage({ agentId: null, content: '低分开场', offsetMin: 0 }), // primacy, score 5
      makeMessage({
        agentId: CODEX,
        content: '高分一：\n```ts\nx\n```\n@claude',
        mentions: [CLAUDE],
        offsetMin: 1,
        toolEvents: [{ type: 'tool_use', label: 'edit' }],
      }), // code3+mention2+tool2 = 7
      makeMessage({
        agentId: CODEX,
        content: '高分二：\n```ts\ny\n```\n@claude',
        mentions: [CLAUDE],
        offsetMin: 2,
        toolEvents: [{ type: 'tool_use', label: 'edit' }],
      }), // 7
    ];
    const anchors = selectAnchors(omitted, [], 2);
    expect(anchors).toHaveLength(2);
    expect(anchors.some((a) => a.isPrimacy)).toBe(true);
    expect(anchors[0]?.isPrimacy).toBe(true); // chronological → opener first
  });

  it('returns anchors in chronological (original-index) order', () => {
    const omitted = [
      makeMessage({ agentId: null, content: '@codex 开场', mentions: [CODEX], offsetMin: 0 }),
      makeMessage({ agentId: CLAUDE, content: '```ts\ncode\n```', offsetMin: 1 }),
      makeMessage({ agentId: CODEX, content: '@claude 跟进', mentions: [CLAUDE], offsetMin: 2 }),
    ];
    const anchors = selectAnchors(omitted, [], 3);
    const ids = anchors.map((a) => a.message.id);
    expect(ids).toEqual([omitted[0]?.id, omitted[1]?.id, omitted[2]?.id]);
  });
});

describe('formatAnchors (edge)', () => {
  it('labels the primacy anchor "Thread opener" and truncates long content', () => {
    const omitted = [
      makeMessage({ agentId: null, content: '开场说明 '.repeat(60), offsetMin: 0 }), // > 200 chars
      makeMessage({ agentId: CLAUDE, content: '```ts\ncode\n```', offsetMin: 1 }),
    ];
    const anchors = selectAnchors(omitted, [], 2);
    const lines = formatAnchors(anchors, { resolveConfig });
    expect(lines[0]).toContain('Thread opener');
    expect(lines[0]).toContain('...'); // truncated at 200 chars
    expect(lines[1]).toContain('Anchor 2/2');
  });
});

describe('anchor-selector (adversarial)', () => {
  it('returns [] for empty omitted', () => {
    expect(selectAnchors([], [], 3)).toEqual([]);
  });

  it('returns [] when maxAnchors is 0', () => {
    const omitted = [makeMessage({ agentId: CLAUDE, content: '```ts\nx\n```', offsetMin: 0 })];
    expect(selectAnchors(omitted, [], 0)).toEqual([]);
  });

  it('returns [] when maxAnchors is negative', () => {
    const omitted = [makeMessage({ agentId: CLAUDE, content: '```ts\nx\n```', offsetMin: 0 })];
    expect(selectAnchors(omitted, [], -1)).toEqual([]);
  });

  it('scores zero relevance when there are no query terms', () => {
    const msg = makeMessage({ agentId: CLAUDE, content: 'database schema 都在这里', offsetMin: 1 });
    expect(scoreImportance(msg, 1, 5, []).signals.relevance).toBe(0);
  });
});
