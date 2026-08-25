// tests/providers/real-cli-smoke.integration.test.ts
// M2 NON-GATING integration smoke: 真实 spawn claude/codex/agy CLI 跑一轮。
// 需真实安装 CLI + 凭证。缺 CLI / 未开启时 SKIP（绝不 fail）。
// 门控（hand-off / Wave 解锁）不依赖此文件（PROJECT_SPEC M2）。
//
// 启用：RUN_CLI_SMOKE=1 npx vitest run tests/providers/real-cli-smoke.integration.test.ts

import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@choco/shared';
import { createAgentId } from '@choco/shared';
import { ClaudeAgentService } from '@choco/api/providers/claude/claude-service';
import { CodexAgentService } from '@choco/api/providers/codex/codex-service';
import { AntigravityAgentService } from '@choco/api/providers/antigravity/antigravity-service';
import type { AgentService } from '@choco/api/providers/base';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '@choco/api/invocation/session-store';
import { SqliteMessageStore } from '@choco/api/stores/sqlite-message-store';
import { SqliteToolEventLog } from '@choco/api/stores/sqlite-tool-event-log';
import { SessionMutex } from '@choco/api/invocation/session-mutex';
import { invokeSingleAgent } from '@choco/api/invocation/invoke-single-agent';

const SMOKE_ENABLED = process.env.RUN_CLI_SMOKE === '1';
const SMOKE_PROMPT = '用一句话说明 1+1 等于几（仅回答，无需工具）。';
const SMOKE_TIMEOUT_MS = 120_000;

async function drain(service: AgentService): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const msg of service.invoke(SMOKE_PROMPT, { timeoutMs: SMOKE_TIMEOUT_MS })) {
    out.push(msg);
  }
  return out;
}

// describe.skipIf 在未开启 smoke 时整组跳过，不计入失败。
describe.skipIf(!SMOKE_ENABLED)('real-cli-smoke (integration, non-gating)', () => {
  it('claude CLI spawns and yields at least one parsed message', async () => {
    const svc = new ClaudeAgentService({ agentId: createAgentId('claude-opus') });
    const messages = await drain(svc);
    expect(messages.length).toBeGreaterThan(0);
  }, SMOKE_TIMEOUT_MS + 30_000);

  it('codex CLI spawns and yields at least one parsed message', async () => {
    const svc = new CodexAgentService({ agentId: createAgentId('codex') });
    const messages = await drain(svc);
    expect(messages.length).toBeGreaterThan(0);
  }, SMOKE_TIMEOUT_MS + 30_000);

  it('agy (Antigravity) CLI spawns and yields at least one parsed message', async () => {
    const svc = new AntigravityAgentService({ agentId: createAgentId('gemini-pro') });
    const messages = await drain(svc);
    expect(messages.length).toBeGreaterThan(0);
  }, SMOKE_TIMEOUT_MS + 30_000);

  // gap #4 Layer 1: the relay cat (claude-opus-relay) is a claude provider on the
  // sonnet model. Prove the configured model id (claude-sonnet-4-6) really spawns —
  // a config-truth check so we never relay to a non-existent model.
  it('relay cat (claude-opus-relay, sonnet model) spawns and yields at least one parsed message', async () => {
    const svc = new ClaudeAgentService({
      agentId: createAgentId('claude-opus-relay'),
      defaultModel: 'claude-sonnet-4-6',
    });
    const messages = await drain(svc);
    expect(messages.length).toBeGreaterThan(0);
  }, SMOKE_TIMEOUT_MS + 30_000);
});

// 端到端：真 CLI 经 invokeSingleAgent + 真 SessionStore。验证 FakeAgentService 之外的
// 真实会话状态机——session_init→SessionStore 持久化、resume 注入上一轮真 sessionId。
// P0-2 真证据地基：单测全用 fake 证契约，此处用支持持久会话的 claude/codex
// provider 证端到端成立（gated，非门控）。Antigravity `agy` 是无会话 print 路径，
// 其真实 spawn 由上面的 smoke 覆盖，不套用此 session 恢复断言。
describe.skipIf(!SMOKE_ENABLED)('real-cli end-to-end: invoke + session (integration, non-gating)', () => {
  function makeSessionStore(db: Database.Database): SessionStore {
    return new SessionStore(db, {
      messageReader: new SqliteMessageStore(db),
      toolEventReader: new SqliteToolEventLog(db),
    });
  }
  async function drainGen(gen: AsyncIterable<AgentMessage>): Promise<AgentMessage[]> {
    const out: AgentMessage[] = [];
    for await (const m of gen) out.push(m);
    return out;
  }

  // 三 provider 共用：turn1 验 session_init→SessionStore 持久化；turn2 验 resume 注入
  // 上一轮持久化的真 sessionId（onSessionId 首次上报 = invoke 调 CLI 前的 resume 注入值）。
  async function assertPersistAndResume(
    agentId: ReturnType<typeof createAgentId>,
    svc: AgentService,
    extraEnv?: Record<string, string>,
  ): Promise<void> {
    const db = new Database(':memory:');
    const sessionStore = makeSessionStore(db);
    const sessionMutex = new SessionMutex();
    // 干净 cwd：避免子进程吃进 workspace 的 project .claude（hook/MCP/memory）。
    const cwd = mkdtempSync(join(tmpdir(), 'choco-cli-smoke-'));
    const threadId = `smoke-e2e-${agentId as string}`;
    const common = {
      sessionStore,
      sessionMutex,
      agentId,
      workingDirectory: cwd,
      timeoutMs: SMOKE_TIMEOUT_MS,
      ...(extraEnv ? { callbackEnv: extraEnv } : {}),
    };
    try {
      // Turn 1（fresh）
      const turn1 = await drainGen(
        invokeSingleAgent({ ...common, agentService: svc, threadId, prompt: SMOKE_PROMPT }),
      );
      expect(turn1.some((m) => m.type === 'done')).toBe(true);
      const sid1 = sessionStore.getActiveSessionId(agentId, threadId);
      expect(sid1, 'session_init should persist a session id to SessionStore').toBeTruthy();

      // Turn 2（resume）
      let firstReported: string | undefined;
      const turn2 = await drainGen(
        invokeSingleAgent({
          ...common,
          agentService: svc,
          threadId,
          prompt: '再用一句话重复刚才的答案。',
          onSessionId: (s) => {
            if (firstReported === undefined) firstReported = s;
          },
        }),
      );
      expect(turn2.some((m) => m.type === 'done')).toBe(true);
      expect(firstReported, 'resume should inject the prior persisted sessionId').toBe(sid1);
    } finally {
      db.close();
    }
  }

  const PER_TEST_TIMEOUT = SMOKE_TIMEOUT_MS * 2 + 60_000;

  it('claude: session_init persists + resume injects prior sessionId', async () => {
    const agentId = createAgentId('claude-opus');
    await assertPersistAndResume(agentId, new ClaudeAgentService({ agentId }));
  }, PER_TEST_TIMEOUT);

  it('codex: session_init persists + resume injects prior sessionId', async () => {
    const agentId = createAgentId('codex');
    await assertPersistAndResume(agentId, new CodexAgentService({ agentId }));
  }, PER_TEST_TIMEOUT);
});
