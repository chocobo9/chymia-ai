// tests/providers/system-prompt-resume.test.ts
// Non-native system prompt handling differs by provider:
// - Codex has resumable sessions, so identity is injected only on a fresh turn.
// - Antigravity `agy --print` is stateless here; it does not expose a stable
//   machine-readable session id, so every print invocation receives identity.
import { describe, it, expect } from 'vitest';
import { buildArgs as antigravityBuildArgs } from '@choco/api/providers/antigravity/antigravity-service';
import { buildStdinPrompt as codexBuildStdinPrompt } from '@choco/api/providers/codex/codex-service';

const IDENTITY = '你是 Gemini，一只Gemini，由 Google 提供的 AI agent。';
const USER_MSG = '什么是离散数学的永真式';

describe('non-native-L0 provider system prompt injection', () => {
  it('[antigravity/agy] fresh print prepends the identity system prompt', () => {
    const args = antigravityBuildArgs(USER_MSG, { systemPrompt: IDENTITY }, 'agy-fresh-1', '/cwd', 0);
    const joined = args.join('\n');
    expect(joined).toContain(IDENTITY);
    expect(joined).toContain(USER_MSG);
  });

  it('[antigravity/agy][stateless] a stale sessionId does not suppress identity injection', () => {
    const args = antigravityBuildArgs(
      USER_MSG,
      { systemPrompt: IDENTITY, sessionId: 'agy-resume-1' },
      'agy-resume-1',
      '/cwd',
      0,
    );
    const joined = args.join('\n');
    expect(joined).toContain(IDENTITY);
    expect(joined).toContain(USER_MSG);
    expect(joined).not.toContain('--conversation');
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
