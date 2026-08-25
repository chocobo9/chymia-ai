// tests/providers/claude-stdin-systemfile.test.ts
// Regression (spawn ENAMETOOLONG fix): ClaudeAgentService.invoke pipes the long turn
// prompt via STDIN (never argv) and writes the L0 system prompt to a temp file passed
// as --append-system-prompt-file — so a long prompt + long L0 never push the command
// line past the Windows CreateProcess ~32K limit. Verified by capturing the injected
// spawn params (args + stdin) and reading the temp file AT SPAWN TIME (before invoke's
// finally removes it).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ClaudeAgentService } from '@choco/api/providers/claude/claude-service';
import type { CliSpawnParams, CliLineStream } from '@choco/api/providers/cli-spawn';
import { createAgentId } from '@choco/shared';

interface Capture {
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly systemFileContent?: string;
}

function recordingSpawn(): { spawn: (p: CliSpawnParams) => CliLineStream; calls: Capture[] } {
  const calls: Capture[] = [];
  const spawn = (params: CliSpawnParams): CliLineStream => {
    // Read the L0 temp file NOW (invoke wrote it before spawn; the finally removes it after).
    let systemFileContent: string | undefined;
    const i = params.args.indexOf('--append-system-prompt-file');
    if (i >= 0) {
      try {
        systemFileContent = readFileSync(params.args[i + 1] as string, 'utf8');
      } catch {
        systemFileContent = undefined;
      }
    }
    calls.push({ args: params.args, stdin: params.stdin, systemFileContent });
    async function* lines(): AsyncGenerator<string> {
      yield JSON.stringify({ type: 'result', subtype: 'success' });
    }
    return {
      lines: lines(),
      exit: Promise.resolve({ reason: 'exit', code: 0, signal: null, stderr: '' }),
      kill: () => {},
    };
  };
  return { spawn, calls };
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const line of stream) {
    void line; // consume
  }
}

// > Windows CreateProcess ~32767-char limit — these would ENAMETOOLONG via argv.
const LONG_PROMPT = `@claude ${'指令很长'.repeat(8000)}`;
const LONG_SYSTEM = `你是 Choco 架构师。${'人设很长'.repeat(4000)}`;

describe('ClaudeAgentService.invoke — prompt via stdin + L0 via temp file (ENAMETOOLONG fix)', () => {
  it('pipes the long prompt to stdin (never argv) and writes the L0 to --append-system-prompt-file', async () => {
    const { spawn, calls } = recordingSpawn();
    const svc = new ClaudeAgentService({ agentId: createAgentId('claude-opus'), spawn });

    await drain(svc.invoke(LONG_PROMPT, { systemPrompt: LONG_SYSTEM }));

    expect(calls).toHaveLength(1);
    const { args, stdin, systemFileContent } = calls[0]!;
    // Prompt goes to stdin, NOT argv.
    expect(stdin).toBe(LONG_PROMPT);
    expect(args).not.toContain(LONG_PROMPT);
    // System prompt goes to a temp file, NOT argv.
    expect(args).not.toContain(LONG_SYSTEM);
    expect(args).toContain('--append-system-prompt-file');
    expect(systemFileContent).toBe(LONG_SYSTEM);
    // The whole argv is comfortably under the Windows limit now (flags only).
    expect(args.join(' ').length).toBeLessThan(2000);
  });

  it('no systemPrompt → no --append-system-prompt-file flag; the prompt still goes via stdin', async () => {
    const { spawn, calls } = recordingSpawn();
    const svc = new ClaudeAgentService({ agentId: createAgentId('claude-opus'), spawn });

    await drain(svc.invoke('hello', {}));

    expect(calls[0]?.stdin).toBe('hello');
    expect(calls[0]?.args).not.toContain('--append-system-prompt-file');
  });
});
