// tests/routing/real-cli-route-smoke.integration.test.ts
// P0-1 真证据地基：真 spawn 多 provider 路由端到端 smoke。撕开 router 层 FakeAgentService
// 坑——单测全用 recording invoke 证路由决策契约，此处用真 AgentRouter → invokeSingleAgent
// → 真 claude/codex/gemini CLI 证「路由内核在真 CLI 下端到端成立」。
//
// 覆盖路由内核三大路径：
//   1. 串行(#execute)：@claude @codex → claude 真回 → 其回复经 composeSerialPrompt 注入
//      codex 的 prompt（串行上下文传递）→ codex 真回。
//   2. 并行(@all)：广播 → 所有 available provider 并行真回。
//   3. fallback：无 mention 无 history → default(claude) 真回。
//   4. participant：@codex 真回 → 路由时把 codex 写回 thread.participants；后续无 mention
//      turn 经 participant fallback 真 spawn 回 codex（不是 default claude）。真 CLI 端到端
//      证 gap #1（路由时持久化）+ participant-based fallback，不靠 recording fake。
//
// gated：RUN_CLI_SMOKE=1 npx vitest run tests/routing/real-cli-route-smoke.integration.test.ts
// 需真实安装 claude/codex/gemini CLI + 凭证；未开启时整组 SKIP（绝不 fail）。

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@choco/shared';
import { AgentRouter, type InvokeAgentFn } from '@choco/api/routing/agent-router';
import { AgentRegistryImpl } from '@choco/api/routing/agent-registry';
import { invokeSingleAgent } from '@choco/api/invocation/invoke-single-agent';
import { SessionStore } from '@choco/api/invocation/session-store';
import { SqliteMessageStore } from '@choco/api/stores/sqlite-message-store';
import { SqliteThreadStore } from '@choco/api/stores/sqlite-thread-store';
import { SqliteToolEventLog } from '@choco/api/stores/sqlite-tool-event-log';
import { SessionMutex } from '@choco/api/invocation/session-mutex';
import { ClaudeAgentService } from '@choco/api/providers/claude/claude-service';
import { CodexAgentService } from '@choco/api/providers/codex/codex-service';
import { GeminiAgentService } from '@choco/api/providers/gemini/gemini-service';
import {
  CLAUDE,
  CODEX,
  GEMINI,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  GEMINI_CONFIG,
  drain,
} from './helpers';

const SMOKE_ENABLED = process.env.RUN_CLI_SMOKE === '1';
const SMOKE_TIMEOUT_MS = 120_000;
const PER_TEST_TIMEOUT = SMOKE_TIMEOUT_MS * 3 + 60_000;

interface RouterHarness {
  router: AgentRouter;
  threadStore: SqliteThreadStore;
  seenPrompts: { agentId: string; prompt: string }[];
  db: Database.Database;
}

/** Build an AgentRouter wired to REAL provider services via a real invokeSingleAgent seam. */
function makeRealRouterHarness(): RouterHarness {
  const db = new Database(':memory:');
  const sessionStore = new SessionStore(db, {
    messageReader: new SqliteMessageStore(db),
    toolEventReader: new SqliteToolEventLog(db),
  });
  const sessionMutex = new SessionMutex();
  // 干净 cwd（非 git）：codex-service 自动补 --skip-git-repo-check；避免吃 workspace .claude。
  const cwd = mkdtempSync(join(tmpdir(), 'choco-route-smoke-'));

  // Real thread store on the SAME db — backs route-time participant persistence
  // (Clowder resolveTargets → addParticipants) + the participant-based fallback.
  const threadStore = new SqliteThreadStore(db);

  const registry = new AgentRegistryImpl(
    [CLAUDE_CONFIG, CODEX_CONFIG, GEMINI_CONFIG],
    {
      [CLAUDE as string]: new ClaudeAgentService({ agentId: CLAUDE }),
      [CODEX as string]: new CodexAgentService({ agentId: CODEX }),
      [GEMINI as string]: new GeminiAgentService({ agentId: GEMINI }),
    },
    { defaultAgentId: CLAUDE },
  );

  const seenPrompts: { agentId: string; prompt: string }[] = [];
  const invoke: InvokeAgentFn = (args): AsyncIterable<AgentMessage> => {
    seenPrompts.push({ agentId: args.agentId as string, prompt: args.prompt });
    // gemini 受信目录门：mkdtemp 未信任目录需显式 trust env，否则 exit 55 收不到流。
    const extraEnv = args.agentId === GEMINI ? { GEMINI_CLI_TRUST_WORKSPACE: 'true' } : undefined;
    return invokeSingleAgent({
      agentService: registry.getService(args.agentId),
      sessionStore,
      sessionMutex,
      agentId: args.agentId,
      threadId: args.threadId,
      prompt: args.prompt,
      workingDirectory: cwd,
      timeoutMs: SMOKE_TIMEOUT_MS,
      ...(extraEnv ? { callbackEnv: extraEnv } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
    });
  };

  return { router: new AgentRouter({ registry, invoke, threadStore }), threadStore, seenPrompts, db };
}

describe.skipIf(!SMOKE_ENABLED)('real-cli route smoke (integration, non-gating)', () => {
  it('serial (#execute): claude → codex, codex prompt carries claude reply', async () => {
    const { router, seenPrompts, db } = makeRealRouterHarness();
    try {
      const events = await drain(
        router.route('user', '@claude @codex #execute 只回一个词：OK', 'route-serial-thread'),
      );
      // 串行：两个 agent 都真回（各产 text + done）。
      expect(events.some((e) => e.type === 'done' && e.agentId === CLAUDE)).toBe(true);
      expect(events.some((e) => e.type === 'text' && e.agentId === CODEX)).toBe(true);
      // 串行上下文传递：codex 的 prompt 必须带上前序 claude 回复块（composeSerialPrompt
      // 用 `[claude-opus]: ...`）。这是路由→串行→真回→注入下游 的真 CLI 证据。
      const codexPrompt = seenPrompts.find((p) => p.agentId === (CODEX as string))?.prompt ?? '';
      expect(codexPrompt).toContain(CLAUDE as string);
    } finally {
      db.close();
    }
  }, PER_TEST_TIMEOUT);

  it('parallel (@all): all available providers reply + join participants', async () => {
    const { router, threadStore, seenPrompts, db } = makeRealRouterHarness();
    try {
      await threadStore.ensureThread('route-all-thread', 'all smoke');
      const events = await drain(
        router.route('user', '@all 只回一个词：OK', 'route-all-thread'),
      );
      const invoked = new Set(seenPrompts.map((p) => p.agentId));
      expect(invoked.has(CLAUDE as string)).toBe(true);
      expect(invoked.has(CODEX as string)).toBe(true);
      expect(invoked.has(GEMINI as string)).toBe(true);
      // 三 provider 各一个 done。
      expect(events.filter((e) => e.type === 'done').length).toBeGreaterThanOrEqual(3);
      // @all 展开为全 roster → 全部写回 participants（gap #1 广播分支，真 CLI）。
      const thread = await threadStore.get('route-all-thread');
      expect(thread?.participants).toEqual(
        expect.arrayContaining([CLAUDE, CODEX, GEMINI]),
      );
    } finally {
      db.close();
    }
  }, PER_TEST_TIMEOUT);

  it('fallback: no mention, no history → default agent (claude) replies', async () => {
    const { router, seenPrompts, db } = makeRealRouterHarness();
    try {
      const events = await drain(
        router.route('user', '只回一个词：OK', 'route-fallback-thread'),
      );
      // 无 mention 无 history → pickFallback = default(claude)；只有 claude 被调。
      expect(seenPrompts.length).toBeGreaterThan(0);
      expect(seenPrompts.every((p) => p.agentId === (CLAUDE as string))).toBe(true);
      expect(events.some((e) => e.type === 'text' && e.agentId === CLAUDE)).toBe(true);
    } finally {
      db.close();
    }
  }, PER_TEST_TIMEOUT);

  it('participant: @codex real-spawn joins participants, then a no-mention turn continues with codex', async () => {
    const { router, threadStore, seenPrompts, db } = makeRealRouterHarness();
    const threadId = 'route-participant-thread';
    try {
      // addParticipants is a no-op on an unknown thread → the thread must exist first.
      await threadStore.ensureThread(threadId, 'participant smoke');

      // 1. Real-spawn @codex. route() persists the @mention as a participant BEFORE
      //    dispatch (Clowder resolveTargets → addParticipants). gap #1 真 CLI 端到端.
      const first = await drain(router.route('user', '@codex 只回一个词：OK', threadId));
      expect(first.some((e) => e.type === 'text' && e.agentId === CODEX)).toBe(true);
      const afterMention = await threadStore.get(threadId);
      expect(afterMention?.participants).toContain(CODEX);

      // 2. A no-mention follow-up: no history reader is wired, so recent-user-mention
      //    fallback yields nothing → participant fallback must continue with codex
      //    (the sole participant), NOT the default agent (claude). Real-spawned.
      seenPrompts.length = 0;
      const second = await drain(router.route('user', '只回一个词：OK', threadId));
      expect(seenPrompts.length).toBeGreaterThan(0);
      expect(seenPrompts.every((p) => p.agentId === (CODEX as string))).toBe(true);
      expect(second.some((e) => e.type === 'text' && e.agentId === CODEX)).toBe(true);
    } finally {
      db.close();
    }
  }, PER_TEST_TIMEOUT);
});
