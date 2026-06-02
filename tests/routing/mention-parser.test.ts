// tests/routing/mention-parser.test.ts
// M4 DEV happy-path: user @mention parsing + line-start A2A mention parsing.

import { describe, test, expect } from 'vitest';
import {
  parseUserMentions,
  parseA2AMentions,
} from '@choco/api/routing/mention-parser';
import { CLAUDE, CODEX, GEMINI, ALL_CONFIGS } from './helpers';

const ENTRIES = ALL_CONFIGS.flatMap((c) =>
  c.mentionPatterns.map((pattern) => ({ agentId: c.id, pattern })),
);

describe('parseUserMentions — happy path (unit)', () => {
  test('"@claude write the auth middleware" → [claude]', () => {
    expect(parseUserMentions('@claude write the auth middleware', ENTRIES)).toEqual([
      CLAUDE,
    ]);
  });

  test('"@claude @codex pair on the parser" → [claude, codex] in order', () => {
    expect(
      parseUserMentions('@claude @codex pair on the parser', ENTRIES),
    ).toEqual([CLAUDE, CODEX]);
  });

  test('matches a Chinese mention pattern (@布偶)', () => {
    expect(parseUserMentions('@布偶 帮我设计数据库 schema', ENTRIES)).toEqual([CLAUDE]);
  });

  test('no @mention → empty list', () => {
    expect(parseUserMentions('please refactor the retry policy', ENTRIES)).toEqual(
      [],
    );
  });
});

describe('parseA2AMentions — happy path (unit)', () => {
  test('line-start "@codex review the diff above" hands off to codex', () => {
    const reply = 'I finished the implementation.\n@codex review the diff above';
    expect(parseA2AMentions(reply, ENTRIES, CLAUDE)).toEqual([CODEX]);
  });

  test('self-mention is filtered out', () => {
    const reply = '@claude keep going\n@gemini take the perf pass';
    expect(parseA2AMentions(reply, ENTRIES, CLAUDE)).toEqual([GEMINI]);
  });

  test('mid-line mention in prose does NOT route', () => {
    const reply = 'We should probably ask @codex about this later.';
    expect(parseA2AMentions(reply, ENTRIES, CLAUDE)).toEqual([]);
  });

  test('@mention inside a fenced code block is ignored', () => {
    const reply = '```md\n@codex this is documentation, not a handoff\n```';
    expect(parseA2AMentions(reply, ENTRIES, CLAUDE)).toEqual([]);
  });
});
