// tests/providers/real-cli-smoke.integration.test.ts
// M2 NON-GATING integration smoke: 真实 spawn claude/codex/gemini CLI 跑一轮。
// 需真实安装 CLI + 凭证。缺 CLI / 未开启时 SKIP（绝不 fail）。
// 门控（hand-off / Wave 解锁）不依赖此文件（PROJECT_SPEC M2）。
//
// 启用：RUN_CLI_SMOKE=1 npx vitest run tests/providers/real-cli-smoke.integration.test.ts

import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@clowder/shared';
import { createAgentId } from '@clowder/shared';
import { ClaudeAgentService } from '@clowder/api/providers/claude/claude-service';
import { CodexAgentService } from '@clowder/api/providers/codex/codex-service';
import { GeminiAgentService } from '@clowder/api/providers/gemini/gemini-service';
import type { AgentService } from '@clowder/api/providers/base';

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

  it('gemini CLI spawns and yields at least one parsed message', async () => {
    const svc = new GeminiAgentService({ agentId: createAgentId('gemini') });
    const messages = await drain(svc);
    expect(messages.length).toBeGreaterThan(0);
  }, SMOKE_TIMEOUT_MS + 30_000);
});
