// tests/providers/gemini-stdin-prompt.test.ts
// Regression: Windows "The command line is too long" — Gemini CLI prompt must
// be passed via stdin, not as a --prompt CLI argument, to avoid the ~32K
// Windows command-line length limit.

import { describe, it, expect } from 'vitest';
import {
  buildArgs,
  buildStdinPrompt,
} from '@choco/api/providers/gemini/gemini-service';

const MODEL = 'gemini-2.5-pro';
const SYSTEM = '你是 Gemini (Pro)，一只暹罗猫。';
const USER_MSG = '什么是离散数学的永真式';

describe('gemini buildArgs omits --prompt (stdin instead)', () => {
  it('does not include --prompt in the returned args', () => {
    const args = buildArgs({ systemPrompt: SYSTEM }, MODEL);
    expect(args).not.toContain('--prompt');
    expect(args.join(' ')).not.toContain(USER_MSG);
    expect(args.join(' ')).not.toContain(SYSTEM);
  });

  it('includes --model, --yolo, --output-format, and other flags', () => {
    const args = buildArgs({ systemPrompt: SYSTEM, sessionId: 'sess-1' }, MODEL);
    expect(args).toContain('--model');
    expect(args).toContain(MODEL);
    expect(args).toContain('--yolo');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--resume');
    expect(args).toContain('sess-1');
  });
});

describe('gemini buildStdinPrompt', () => {
  it('returns the user prompt when no system prompt', () => {
    const text = buildStdinPrompt(USER_MSG, undefined);
    expect(text).toBe(USER_MSG);
  });

  it('prepends system prompt on first turn (no sessionId)', () => {
    const text = buildStdinPrompt(USER_MSG, { systemPrompt: SYSTEM });
    expect(text).toContain(SYSTEM);
    expect(text).toContain(USER_MSG);
    expect(text.indexOf(SYSTEM)).toBeLessThan(text.indexOf(USER_MSG));
  });

  it('does NOT prepend system prompt on resumed turn (sessionId set)', () => {
    const text = buildStdinPrompt(USER_MSG, {
      systemPrompt: SYSTEM,
      sessionId: 'sess-resume-1',
    });
    expect(text).not.toContain(SYSTEM);
    expect(text).toContain(USER_MSG);
  });

  it('appends text content blocks', () => {
    const text = buildStdinPrompt(USER_MSG, {
      contentBlocks: [{ type: 'text', text: 'extra context' }],
    });
    expect(text).toContain(USER_MSG);
    expect(text).toContain('extra context');
  });
});
