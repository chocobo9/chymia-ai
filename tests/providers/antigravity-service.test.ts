// tests/providers/antigravity-service.test.ts
// @gemini 后端换 Antigravity (agy CLI)：AntigravityAgentService 行为 + args 契约。
//
// 对齐 Clowder GeminiAgentService.invokeAntigravityCLI（agy 路径）：
//   agy --add-dir <cwd> --dangerously-skip-permissions [--print-timeout Ns]
//       --conversation <sessionId> --print <effectivePrompt>
// agy 是 plain-text 一次性输出（无 NDJSON、无 mid-stream done、无 MCP 子进程）：
// drain 全 stdout → await exit → 分类 → yield text/error → done。
// systemPrompt 仅首轮注入（保留身份死循环修复）；session_init 在进程真跑过时发
// （spawn_error 不发，会话没建）；abort 只 done 不报错（对齐 Clowder cancelled）。
// 用注入 fake spawn + 注入 genId 做确定性验证，不真拉起 agy。

import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@choco/shared';
import { createAgentId } from '@choco/shared';
import {
  AntigravityAgentService,
  buildArgs,
  formatAgyPrintTimeout,
} from '@choco/api/providers/antigravity/antigravity-service';
import type {
  CliExitInfo,
  CliLineStream,
  CliSpawnParams,
  spawnCliLineStream,
} from '@choco/api/providers/cli-spawn';

const AGENT = createAgentId('gemini-pro');
const FIXED_TS = 1_700_000_333_000;
const IDENTITY = '你是 Gemini，一只Gemini，由 Google 提供的 AI agent。';
const USER_MSG = '什么是离散数学的永真式';

/** Fake spawn: yield scripted stdout lines, resolve exit with the given info. */
function makeSpawn(cfg: {
  lines: readonly string[];
  exit: CliExitInfo;
  onSpawn?: (params: CliSpawnParams) => void;
}): typeof spawnCliLineStream {
  return (params: CliSpawnParams): CliLineStream => {
    cfg.onSpawn?.(params);
    async function* gen(): AsyncGenerator<string> {
      for (const line of cfg.lines) {
        yield line;
      }
    }
    return { lines: gen(), exit: Promise.resolve(cfg.exit), kill: () => {} };
  };
}

const exitOk = (): CliExitInfo => ({ reason: 'exit', code: 0, signal: null, stderr: '' });

async function drain(service: AntigravityAgentService, opts?: Parameters<AntigravityAgentService['invoke']>[1]): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const msg of service.invoke(USER_MSG, opts)) {
    out.push(msg);
  }
  return out;
}

function svc(spawn: ReturnType<typeof makeSpawn>): AntigravityAgentService {
  return new AntigravityAgentService({
    agentId: AGENT,
    now: () => FIXED_TS,
    genId: () => 'agy-fixed-1',
    spawn,
    transcriptFallback: () => undefined,
  });
}

// ── buildArgs (pure args contract) ──────────────────────────────────────────
describe('buildArgs (agy args contract)', () => {
  it('fresh turn builds the full agy print invocation in order', () => {
    const args = buildArgs(USER_MSG, undefined, 'agy-sess-1', 'D:\\proj\\choco-ai', 600_000);
    expect(args).toContain('--dangerously-skip-permissions');
    // --add-dir <cwd>
    expect(args[args.indexOf('--add-dir') + 1]).toBe('D:\\proj\\choco-ai');
    // --conversation <sessionId>
    expect(args).not.toContain('--conversation');
    // --print <prompt> (last positional value)
    expect(args[args.indexOf('--print') + 1]).toBe(USER_MSG);
    // --print-timeout Ns (600_000ms → 600s)
    expect(args[args.indexOf('--print-timeout') + 1]).toBe('600s');
  });

  it('omits --print-timeout when timeoutMs <= 0', () => {
    const args = buildArgs(USER_MSG, undefined, 'agy-sess-1', '/cwd', 0);
    expect(args).not.toContain('--print-timeout');
  });

  it('does NOT pass --model (account-side selected model, per Clowder alignment)', () => {
    const args = buildArgs(USER_MSG, { model: 'gemini-2.5-pro' }, 'agy-sess-1', '/cwd', 1000);
    expect(args).not.toContain('--model');
  });

  it('[first turn] prepends the identity system prompt (no sessionId)', () => {
    const args = buildArgs(USER_MSG, { systemPrompt: IDENTITY }, 'agy-fresh', '/cwd', 1000);
    const printed = args[args.indexOf('--print') + 1];
    expect(printed).toContain(IDENTITY);
    expect(printed).toContain(USER_MSG);
  });

  it('[stateless] prepends the identity even when a stale sessionId is present', () => {
    const args = buildArgs(USER_MSG, { systemPrompt: IDENTITY, sessionId: 'agy-resume-1' }, 'agy-resume-1', '/cwd', 1000);
    const printed = args[args.indexOf('--print') + 1];
    expect(printed).toContain(IDENTITY);
    expect(printed).toContain(USER_MSG);
  });

  it('appends text content blocks to the prompt', () => {
    const args = buildArgs(USER_MSG, { contentBlocks: [{ type: 'text', text: '附加上下文' }] }, 'agy-1', '/cwd', 1000);
    const printed = args[args.indexOf('--print') + 1];
    expect(printed).toContain(USER_MSG);
    expect(printed).toContain('附加上下文');
  });
});

describe('formatAgyPrintTimeout', () => {
  it('rounds up to whole seconds', () => {
    expect(formatAgyPrintTimeout(600_000)).toBe('600s');
    expect(formatAgyPrintTimeout(1500)).toBe('2s'); // ceil
  });
  it('returns undefined for non-positive timeout', () => {
    expect(formatAgyPrintTimeout(0)).toBeUndefined();
    expect(formatAgyPrintTimeout(-5)).toBeUndefined();
  });
});

// ── invoke (drain → await exit → classify) ──────────────────────────────────
describe('AntigravityAgentService.invoke', () => {
  it('fresh plain-text turn: session_init(generated id) → text → done', async () => {
    const out = await drain(svc(makeSpawn({ lines: ['1 + 1 = 2。'], exit: exitOk() })));
    const types = out.map((m) => m.type);
    expect(types).toEqual(['text', 'done']);
    expect(out[0].content).toBe('1 + 1 = 2。');
    expect(out[1].isFinal).toBe(true);
    expect(out.every((m) => m.metadata?.provider === 'antigravity')).toBe(true);
  });

  it('passes the generated sessionId to --conversation on a fresh turn', async () => {
    let captured: readonly string[] = [];
    await drain(svc(makeSpawn({ lines: ['ok'], exit: exitOk(), onSpawn: (p) => { captured = p.args; } })));
    expect(captured).not.toContain('--conversation');
  });

  it('resume turn reuses options.sessionId for --conversation (no new id)', async () => {
    let captured: readonly string[] = [];
    await drain(
      svc(makeSpawn({ lines: ['ok'], exit: exitOk(), onSpawn: (p) => { captured = p.args; } })),
      { sessionId: 'agy-prior-7' },
    );
    expect(captured).not.toContain('--conversation');
  });

  it('empty stdout: session_init → done, NO text event', async () => {
    const out = await drain(svc(makeSpawn({ lines: [], exit: exitOk() })));
    expect(out.map((m) => m.type)).toEqual(['done']);
  });

  it('missing-model stdout → error(missing_model), no text, still session_init + done', async () => {
    const out = await drain(
      svc(makeSpawn({ lines: ['Error: neither PlanModel nor RequestedModel specified'], exit: exitOk() })),
    );
    expect(out.map((m) => m.type)).toEqual(['error', 'done']);
    const err = out.find((m) => m.type === 'error');
    expect(err?.errorCode).toBe('missing_model');
    expect(out.some((m) => m.type === 'text')).toBe(false);
  });

  it('timeout reason → error(timeout)', async () => {
    const out = await drain(
      svc(makeSpawn({ lines: [], exit: { reason: 'timeout', code: null, signal: 'SIGTERM', stderr: '' } })),
    );
    const err = out.find((m) => m.type === 'error');
    expect(err?.errorCode).toBe('timeout');
    expect(out.at(-1)?.type).toBe('done');
  });

  it('aborted reason → done WITHOUT error (cancellation clears loading, not a failure)', async () => {
    const out = await drain(
      svc(makeSpawn({ lines: ['half written'], exit: { reason: 'aborted', code: null, signal: 'SIGTERM', stderr: '' } })),
    );
    expect(out.some((m) => m.type === 'error')).toBe(false);
    expect(out.at(-1)?.type).toBe('done');
  });

  it('spawn_error (agy not installed) → error(spawn_error) and NO session_init (conversation never created)', async () => {
    const out = await drain(
      svc(makeSpawn({
        lines: [],
        exit: { reason: 'spawn_error', code: null, signal: null, stderr: '', spawnError: new Error('spawn agy ENOENT') },
      })),
    );
    expect(out.some((m) => m.type === 'session_init')).toBe(false);
    const err = out.find((m) => m.type === 'error');
    expect(err?.errorCode).toBe('spawn_error');
    expect(err?.content).toMatch(/agy ENOENT/);
    expect(out.at(-1)?.type).toBe('done');
  });

  it('non-zero exit → error(exit_<code>) even if stdout had text', async () => {
    const out = await drain(
      svc(makeSpawn({ lines: ['partial output'], exit: { reason: 'exit', code: 2, signal: null, stderr: 'boom' } })),
    );
    expect(out.some((m) => m.type === 'text')).toBe(false);
    const err = out.find((m) => m.type === 'error');
    expect(err?.errorCode).toBe('exit_2');
    expect(err?.content).toBe('boom');
  });
});

describe('AntigravityAgentService metadata seams', () => {
  it('[regression] empty stdout with agy DB fallback yields text instead of a zero-output invocation', async () => {
    const service = new AntigravityAgentService({
      agentId: AGENT,
      now: () => FIXED_TS,
      genId: () => 'agy-fixed-1',
      spawn: makeSpawn({ lines: [], exit: exitOk() }),
      transcriptFallback: () => 'fallback answer from agy conversation db',
    });
    const out = await drain(service);
    expect(out.map((m) => m.type)).toEqual(['text', 'done']);
    expect(out[0].content).toBe('fallback answer from agy conversation db');
  });

  it('cliCommand() defaults to "agy"', () => {
    expect(new AntigravityAgentService({ agentId: AGENT }).cliCommand()).toBe('agy');
  });
  it('cliCommand() honors a command override (off-PATH absolute path)', () => {
    const path = 'C:\\Users\\zihan\\AppData\\Local\\agy\\bin\\agy.exe';
    expect(new AntigravityAgentService({ agentId: AGENT, command: path }).cliCommand()).toBe(path);
  });
  it('injectsL0Natively() is false (agy has no native system-prompt slot)', () => {
    expect(new AntigravityAgentService({ agentId: AGENT }).injectsL0Natively()).toBe(false);
  });
});
