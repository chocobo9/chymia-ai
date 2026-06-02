// tests/routing/mention-parser.edge.test.ts
// M4 QA — independent edge + adversarial gate for the @mention parsers.
// Targets the longest-match boundary logic, A2A line-start rule, code-fence
// shielding, self-filtering, ordering, dedup, and the MAX_A2A_MENTION_TARGETS cap.

import { describe, test, expect } from 'vitest';
import {
  parseUserMentions,
  parseA2AMentions,
  MAX_A2A_MENTION_TARGETS,
} from '@choco/api/routing/mention-parser';
import { CLAUDE, CODEX, GEMINI } from './helpers';
import { ENTRIES, PREFIX_ENTRIES, PLAIN_CLAUDE, CLAUDE_PRO } from './qa-helpers';

describe('parseUserMentions — edge', () => {
  test('(edge) longer handle wins: "@claude-pro" → only the long-handle agent', () => {
    expect(parseUserMentions('@claude-pro ship the release', PREFIX_ENTRIES)).toEqual([
      CLAUDE_PRO,
    ]);
  });

  test('(edge) bare "@claude" with a longer sibling registered → only the short agent', () => {
    expect(parseUserMentions('@claude take the first pass', PREFIX_ENTRIES)).toEqual([
      PLAIN_CLAUDE,
    ]);
  });

  test('(edge) mention wrapped in parentheses still matches', () => {
    expect(parseUserMentions('(@codex) please double-check the SQL', ENTRIES)).toEqual([
      CODEX,
    ]);
  });

  test('(edge) duplicate of the same agent collapses, earliest position kept', () => {
    expect(
      parseUserMentions('@codex start, then @claude, then @codex again', ENTRIES),
    ).toEqual([CODEX, CLAUDE]);
  });

  test('(edge) three mentions returned in order of first appearance', () => {
    expect(
      parseUserMentions('@gemini bench, @claude design, @codex implement', ENTRIES),
    ).toEqual([GEMINI, CLAUDE, CODEX]);
  });

  test('(edge) Chinese punctuation acts as a right boundary for @布偶', () => {
    expect(parseUserMentions('@布偶，帮我审一下 schema', ENTRIES)).toEqual([CLAUDE]);
  });
});

describe('parseUserMentions — adversarial', () => {
  test('(adversarial) empty string → no mentions', () => {
    expect(parseUserMentions('', ENTRIES)).toEqual([]);
  });

  test('(adversarial) handle embedded in an email-like token does NOT match', () => {
    expect(parseUserMentions('reach me at ops.dev@claude.io tonight', ENTRIES)).toEqual(
      [],
    );
  });

  test('(adversarial) "@claude@codex" — second mention is blocked by a left handle char', () => {
    // '@codex' is preceded by the trailing 'e' of claude → rejected; only claude routes.
    expect(parseUserMentions('@claude@codex', ENTRIES)).toEqual([CLAUDE]);
  });

  test('(adversarial) one mention at the end of a long prose body is still found', () => {
    const longProse =
      'We reviewed the migration plan and the indexing strategy in detail. '.repeat(
        80,
      );
    expect(parseUserMentions(`${longProse}\n@gemini please run the perf benchmark`, ENTRIES)).toEqual([
      GEMINI,
    ]);
  });
});

describe('parseA2AMentions — edge', () => {
  test('(edge) caps hand-off targets at MAX_A2A_MENTION_TARGETS', () => {
    expect(MAX_A2A_MENTION_TARGETS).toBe(2);
    const reply = '@claude @codex @gemini all of you, take a look';
    // No self filter here; only the first two distinct targets survive the cap.
    expect(parseA2AMentions(reply, ENTRIES)).toEqual([CLAUDE, CODEX]);
  });

  test('(edge) markdown list-item prefix before the @mention still routes', () => {
    expect(parseA2AMentions('- @codex review the diff above', ENTRIES, CLAUDE)).toEqual([
      CODEX,
    ]);
  });

  test('(edge) blockquote prefix before the @mention still routes', () => {
    expect(parseA2AMentions('> @gemini what about the cache hit rate?', ENTRIES, CLAUDE)).toEqual(
      [GEMINI],
    );
  });

  test('(edge) numbered list prefix before the @mention still routes', () => {
    expect(parseA2AMentions('1. @codex take the integration tests', ENTRIES, CLAUDE)).toEqual([
      CODEX,
    ]);
  });

  test('(edge) two line-start mentions on separate lines preserve order', () => {
    const reply = '@gemini benchmark this first\n@codex then review the result';
    expect(parseA2AMentions(reply, ENTRIES)).toEqual([GEMINI, CODEX]);
  });

  test('(edge) longest handle wins at a line-start A2A mention', () => {
    expect(parseA2AMentions('@claude-pro please continue', PREFIX_ENTRIES)).toEqual([
      CLAUDE_PRO,
    ]);
    expect(parseA2AMentions('@claude please continue', PREFIX_ENTRIES)).toEqual([
      PLAIN_CLAUDE,
    ]);
  });

  test('(edge) mention outside a fenced block routes; the fenced one does not', () => {
    const reply =
      'Here is the patch:\n```ts\nconst x = 1; // @gemini ignore me\n```\n@codex please review';
    expect(parseA2AMentions(reply, ENTRIES, CLAUDE)).toEqual([CODEX]);
  });
});

describe('parseA2AMentions — adversarial', () => {
  test('(adversarial) empty reply → no hand-off', () => {
    expect(parseA2AMentions('', ENTRIES, CLAUDE)).toEqual([]);
  });

  test('(adversarial) duplicate line-start mentions dedupe to one', () => {
    expect(parseA2AMentions('@codex first\n@codex again', ENTRIES, CLAUDE)).toEqual([
      CODEX,
    ]);
  });

  test('(adversarial) a reply that only self-mentions yields nothing', () => {
    expect(parseA2AMentions('@claude keep iterating on this', ENTRIES, CLAUDE)).toEqual([]);
  });

  test('(adversarial) maxTargets=0 short-circuits to an empty hand-off', () => {
    expect(parseA2AMentions('@codex @gemini go', ENTRIES, undefined, 0)).toEqual([]);
  });

  test('(adversarial) an UNclosed code fence does not shield a line-start mention', () => {
    // CODE_FENCE_RE only strips paired fences; an unterminated fence leaves the
    // following line at column 0, so the line-start rule still routes it.
    expect(parseA2AMentions('```\n@codex review the WIP', ENTRIES, CLAUDE)).toEqual([
      CODEX,
    ]);
  });
});
