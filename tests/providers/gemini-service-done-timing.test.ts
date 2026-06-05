// tests/providers/gemini-service-done-timing.test.ts
// Regression: GeminiAgentService.invoke must finish a turn on the LOGICAL reply
// (result/status:success) — NOT block on the slow process exit. gemini-pro has
// mcpSupport:true (spawns the --config MCP child), so its process teardown is slow
// just like claude's. Before the fix, invoke did `for await(lines); await exit;
// finalizeStream`, so `done` came only on process exit → gemini's SessionMutex
// stayed held → the NEXT @gemini turn blocked on it ("网页端 @gemini 启动很慢").
//
// Same fix + same RED→GREEN shape as claude-service-done-timing.test.ts.

import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@choco/shared';
import { createAgentId } from '@choco/shared';
import { GeminiAgentService } from '@choco/api/providers/gemini/gemini-service';
import type { CliExitInfo, CliLineStream } from '@choco/api/providers/cli-spawn';

const GEMINI = createAgentId('gemini-pro');

/** A scripted gemini stream-json turn: init → assistant message → result/success. */
function turnLines(): readonly string[] {
  return [
    JSON.stringify({ type: 'init', session_id: 'sess-gem-timing', model: 'gemini-2.5-pro' }),
    JSON.stringify({ type: 'message', role: 'assistant', content: '已就绪，开始工作。' }),
    JSON.stringify({ type: 'result', status: 'success' }),
  ];
}

/** Fake spawn: yields the turn, then HANGS; `exit` only settles via `kill()`. */
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

describe('GeminiAgentService.invoke — finishes on logical reply, not on slow process exit', () => {
  it('[regression] emits done off result/success + reclaims the process WITHOUT awaiting exit', async () => {
    const { spawn, killed } = makeHangingSpawn();
    const svc = new GeminiAgentService({ agentId: GEMINI, spawn });

    const drain = (async (): Promise<AgentMessage[]> => {
      const events: AgentMessage[] = [];
      for await (const ev of svc.invoke('@gemini 起床')) {
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
    expect(types).toContain('text');
    expect(types).toContain('done');
    expect(killed()).toBe(true);
    expect(events.find((e) => e.type === 'done')?.isFinal).toBe(true);
    expect(types).not.toContain('error');
  });
});
