// tests/providers/system-prompt-resume.test.ts
// Regression: providers with NO native system-prompt slot (gemini, codex —
// injectsL0Natively=false) must inject the identity system prompt ONLY on the
// FIRST turn of a session (no sessionId), NOT on every resumed turn.
//
// The bug (user 2026-06-05, real Feishu): the identity ("你是 Gemini Pro 暹罗猫…")
// was prepended to the user prompt EVERY turn. On a resumed session the CLI already
// carries that identity, so re-prepending it made gemini read the user as repeating
// its own persona — it counted the repetitions, demanded a verification code
// (0xDEADBEEF), and entered a "loop-break" deadlock. Gating the prepend on
// first-turn (sessionId === undefined) stops the identity from leaking into the
// user channel on resume. Claude is unaffected (native --append-system-prompt).

import { describe, it, expect } from 'vitest';
import { buildStdinPrompt as geminiBuildPrompt } from '@choco/api/providers/gemini/gemini-service';
import { buildStdinPrompt as codexBuildStdinPrompt } from '@choco/api/providers/codex/codex-service';

const IDENTITY = '你是 Gemini (Pro)，一只暹罗猫，由 Google 提供的 AI agent。';
const USER_MSG = '什么是离散数学的永真式';

describe('non-native-L0 providers inject identity only on the first turn (not on resume)', () => {
  it('[gemini] first turn (no sessionId) prepends the identity system prompt', () => {
    const prompt = geminiBuildPrompt(USER_MSG, { systemPrompt: IDENTITY });
    expect(prompt).toContain(IDENTITY);
    expect(prompt).toContain(USER_MSG);
  });

  it('[gemini][regression] a RESUMED turn (sessionId set) does NOT re-prepend the identity', () => {
    const prompt = geminiBuildPrompt(USER_MSG, { systemPrompt: IDENTITY, sessionId: 'sess-resume-1' });
    expect(prompt).not.toContain(IDENTITY);
    expect(prompt).toContain(USER_MSG);
  });

  it('[codex] first turn prepends identity; resumed turn does not', () => {
    const fresh = codexBuildStdinPrompt(USER_MSG, { systemPrompt: IDENTITY });
    expect(fresh).toContain(IDENTITY);
    expect(fresh).toContain(USER_MSG);

    const resumed = codexBuildStdinPrompt(USER_MSG, { systemPrompt: IDENTITY, sessionId: 'sess-resume-2' });
    expect(resumed).not.toContain(IDENTITY);
    expect(resumed).toContain(USER_MSG);
  });
});
