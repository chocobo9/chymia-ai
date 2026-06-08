// tests/providers/long-prompt-real.integration.test.ts
// REAL proof the spawn-ENAMETOOLONG fix works: a >32K prompt + long L0 through the
// REAL claude CLI no longer fails to spawn. Pre-fix, the prompt was an argv positional
// and the L0 an inline flag value, so on Windows the command line blew past the
// CreateProcess ~32K limit → `spawn ENAMETOOLONG`. Now the prompt is piped to stdin and
// the L0 written to a temp file (--append-system-prompt-file), so argv stays tiny.
//
// Gated: RUN_CLI_SMOKE=1 npx vitest run tests/providers/long-prompt-real.integration.test.ts

import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@choco/shared';
import { createAgentId } from '@choco/shared';
import { ClaudeAgentService } from '@choco/api/providers/claude/claude-service';

const SMOKE = process.env.RUN_CLI_SMOKE === '1';
const TIMEOUT = 120_000;

// >32K of padding so a pre-fix argv would exceed the Windows CreateProcess limit.
const LONG_PROMPT =
  `请只用一个词回答：1 加 1 等于几？（完全忽略下面这段无意义的填充文本）\n${'填充内容忽略之'.repeat(6000)}`;
const LONG_SYSTEM = `你是 Choco 的 claude agent，回答尽量简短。${'背景设定'.repeat(3000)}`;

describe.skipIf(!SMOKE)('real claude — a >32K prompt no longer spawn-ENAMETOOLONGs (integration)', () => {
  it('a >32K prompt + long system prompt spawns and yields output (no spawn error)', async () => {
    expect(LONG_PROMPT.length).toBeGreaterThan(32767); // would overflow argv pre-fix
    const svc = new ClaudeAgentService({ agentId: createAgentId('claude-opus') });
    const events: AgentMessage[] = [];
    for await (const ev of svc.invoke(LONG_PROMPT, { systemPrompt: LONG_SYSTEM, timeoutMs: TIMEOUT })) {
      events.push(ev);
    }
    // Pre-fix this was `spawn ENAMETOOLONG` (errorCode 'spawn_error'). The fix means the
    // turn spawns fine and produces real output.
    const spawnErr = events.find(
      (e) => e.type === 'error' && (e as { errorCode?: string }).errorCode === 'spawn_error',
    );
    expect(spawnErr).toBeUndefined();
    expect(events.some((e) => e.type === 'text' || e.type === 'done')).toBe(true);
  }, TIMEOUT + 30_000);
});
