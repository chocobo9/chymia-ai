// tests/routing/intent-parser.edge.test.ts
// M4 QA — independent edge + adversarial gate for deterministic intent parsing.
// Targets tag-in-text, multiple/duplicate tags (last-wins), case-insensitivity,
// CJK hashtag preservation, and clean stripping.

import { describe, test, expect } from 'vitest';
import { parseIntent, stripIntentTags } from '@choco/api/routing/intent-parser';

describe('parseIntent — edge', () => {
  test('(edge) intent tag embedded mid-message is still detected', () => {
    const result = parseIntent('please @claude #ideate explore cache eviction options', 1);
    expect(result).toEqual({ intent: 'ideate', explicit: true, promptTags: [] });
  });

  test('(edge) two conflicting intent tags → the last one wins (#ideate then #execute)', () => {
    const result = parseIntent('@claude #ideate then actually #execute the plan', 2);
    expect(result.intent).toBe('execute');
    expect(result.explicit).toBe(true);
  });

  test('(edge) reversed order also follows last-wins (#execute then #ideate)', () => {
    const result = parseIntent('@claude #execute no wait #ideate first', 1);
    expect(result.intent).toBe('ideate');
    expect(result.explicit).toBe(true);
  });

  test('(edge) intent tags are case-insensitive (#IDEATE)', () => {
    expect(parseIntent('@claude #IDEATE brainstorm options', 1).intent).toBe('ideate');
  });

  test('(edge) duplicate prompt tag is captured (not silently dropped)', () => {
    const result = parseIntent('@claude #critique #critique tear this apart', 1);
    expect(result.promptTags).toContain('critique');
    expect(result.intent).toBe('execute');
  });

  test('(edge) intent + prompt tag together: routing intent + thinking tag both parsed', () => {
    const result = parseIntent('@claude @codex #execute #critique review and ship', 2);
    expect(result.intent).toBe('execute');
    expect(result.explicit).toBe(true);
    expect(result.promptTags).toEqual(['critique']);
  });
});

describe('parseIntent — adversarial', () => {
  test('(adversarial) empty message with zero targets → execute, not explicit', () => {
    expect(parseIntent('', 0)).toEqual({
      intent: 'execute',
      explicit: false,
      promptTags: [],
    });
  });

  test('(adversarial) unknown hashtag is neither an intent nor a prompt tag', () => {
    const result = parseIntent('@claude #refactor the storage layer', 1);
    expect(result.intent).toBe('execute');
    expect(result.explicit).toBe(false);
    expect(result.promptTags).toEqual([]);
  });

  test('(adversarial) explicit #ideate overrides a zero-target count', () => {
    const result = parseIntent('#ideate', 0);
    expect(result.intent).toBe('ideate');
    expect(result.explicit).toBe(true);
  });
});

describe('stripIntentTags — edge', () => {
  test('(edge) strips every known tag and collapses the gaps into a clean prompt', () => {
    expect(
      stripIntentTags('@claude @codex #execute #critique ship the migration'),
    ).toBe('@claude @codex ship the migration');
  });

  test('(edge) a CJK hashtag is preserved verbatim (\\w never matches CJK)', () => {
    expect(stripIntentTags('修复 #数据库 的连接泄漏')).toBe('修复 #数据库 的连接泄漏');
  });

  test('(edge) a trailing intent tag is removed and the prompt is trimmed', () => {
    expect(stripIntentTags('@claude design the evidence schema #execute')).toBe(
      '@claude design the evidence schema',
    );
  });
});

describe('stripIntentTags — adversarial', () => {
  test('(adversarial) a message that is only a tag collapses to empty', () => {
    expect(stripIntentTags('#ideate')).toBe('');
  });

  test('(adversarial) empty string stays empty', () => {
    expect(stripIntentTags('')).toBe('');
  });

  test('(adversarial) back-to-back tags with wide gaps collapse whitespace', () => {
    expect(stripIntentTags('#ideate    #execute   go')).toBe('go');
  });
});
