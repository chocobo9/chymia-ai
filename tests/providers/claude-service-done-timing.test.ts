// tests/providers/claude-service-done-timing.test.ts
// Regression: ClaudeAgentService.invoke must finish a turn when the LOGICAL reply
// completes (the CLI's result/success line) — NOT block on the slow process exit.
//
// The bug (confirmed root cause of "@all 多 agent 只有 claude 回 / 飞书后续消息卡死"):
// invoke did `for await(lines); await exit; finalizeStream` and cli-spawn's line
// stream itself `await waitForClose()` — so the generator hung until the claude CLI
// process actually exited. With `--mcp-config` the MCP subprocess teardown is slow,
// so `done` came minutes late → the SessionMutex stayed held and route-serial's
// `for await` over this generator stalled, blocking the next agent in an @all chain.
//
// This test injects a fake spawn whose line stream yields a normal turn ending in
// result/success and THEN HANGS (models the lingering process + waitForClose), with
// an `exit` that never resolves on its own. The fixed service emits `done` off the
// result line and reclaims the process via `kill()` — it must complete promptly
// WITHOUT awaiting that exit. On the pre-fix code this times out (RED).

import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@choco/shared';
import { createAgentId } from '@choco/shared';
import { ClaudeAgentService } from '@choco/api/providers/claude/claude-service';
import type { CliExitInfo, CliLineStream } from '@choco/api/providers/cli-spawn';

const CLAUDE = createAgentId('claude-opus');

/** A scripted claude stream-json turn: init → assistant text → result/success. */
function turnLines(): readonly string[] {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-timing', model: 'claude-opus-4-6' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '永真式：在所有赋值下恒为真的复合命题。' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success' }),
  ];
}

/**
 * Fake spawn: yields the turn's lines, then HANGS (the real cli-spawn `await
 * waitForClose()` while the claude process lingers). `exit` never resolves on its
 * own — only `kill()` settles it (mirrors SIGTERM → 'close' → settleExit).
 */
function makeHangingSpawn(): { spawn: () => CliLineStream; killed: () => boolean } {
  let wasKilled = false;
  let resolveExit!: (info: CliExitInfo) => void;
  const exit = new Promise<CliExitInfo>((resolve) => {
    resolveExit = resolve;
  });
  async function* lines(): AsyncGenerator<string> {
    for (const line of turnLines()) {
      yield line;
    }
    await new Promise<void>(() => {}); // process lingering — never closes on its own
  }
  const spawn = (): CliLineStream => ({
    lines: lines(),
    exit,
    kill: () => {
      wasKilled = true;
      resolveExit({ reason: 'exit', code: 0, signal: null, stderr: '' });
    },
  });
  return { spawn, killed: () => wasKilled };
}

describe('ClaudeAgentService.invoke — finishes on logical reply, not on slow process exit', () => {
  it('[regression] emits done off result/success + reclaims the process WITHOUT awaiting exit', async () => {
    const { spawn, killed } = makeHangingSpawn();
    const svc = new ClaudeAgentService({ agentId: CLAUDE, spawn });

    // Drain with a hard deadline: the fixed service returns immediately after the
    // result line; the pre-fix service hangs forever awaiting the (never-resolving)
    // process exit → this rejects, which IS the RED signal.
    const drain = (async (): Promise<AgentMessage[]> => {
      const events: AgentMessage[] = [];
      for await (const ev of svc.invoke('@claude 什么是永真式')) {
        events.push(ev);
      }
      return events;
    })();
    const events = await Promise.race([
      drain,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('invoke did not complete — still awaiting process exit')), 800),
      ),
    ]);

    const types = events.map((e) => e.type);
    expect(types).toContain('text'); // the reply streamed
    expect(types).toContain('done'); // turn completed off result/success
    expect(killed()).toBe(true); // process proactively reclaimed (not left for slow exit)
    // done is final and there is no error in a clean turn.
    expect(events.find((e) => e.type === 'done')?.isFinal).toBe(true);
    expect(types).not.toContain('error');
  });
});
