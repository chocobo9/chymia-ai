// tests/routing/intent-parser.test.ts
// M4 DEV happy-path: deterministic intent + prompt-tag parsing.

import { describe, test, expect } from 'vitest';
import { parseIntent, stripIntentTags } from '@choco/api/routing/intent-parser';

describe('parseIntent — happy path (unit)', () => {
  test('explicit #ideate wins regardless of target count', () => {
    const result = parseIntent('@claude #ideate brainstorm cache strategies', 1);
    expect(result).toEqual({ intent: 'ideate', explicit: true, promptTags: [] });
  });

  test('explicit #execute wins even with multiple targets', () => {
    const result = parseIntent('@claude @codex #execute ship the migration', 2);
    expect(result).toEqual({ intent: 'execute', explicit: true, promptTags: [] });
  });

  test('auto-infer: 2 targets → ideate', () => {
    expect(parseIntent('@claude @codex what is the best schema?', 2).intent).toBe(
      'ideate',
    );
  });

  test('auto-infer: 1 target → execute', () => {
    expect(parseIntent('@claude implement the WAL flush', 1).intent).toBe('execute');
  });

  test('#critique is captured as a prompt tag, not an intent', () => {
    const result = parseIntent('@claude #critique review the routing design', 1);
    expect(result.promptTags).toEqual(['critique']);
    expect(result.intent).toBe('execute');
  });
});

describe('stripIntentTags — happy path (unit)', () => {
  test('removes known intent + prompt tags and collapses whitespace', () => {
    expect(
      stripIntentTags('@claude #ideate #critique design the evidence store'),
    ).toBe('@claude design the evidence store');
  });

  test('preserves unknown #tags (they may be real content)', () => {
    expect(stripIntentTags('fix the #bug in #execute path')).toBe('fix the #bug in path');
  });
});
