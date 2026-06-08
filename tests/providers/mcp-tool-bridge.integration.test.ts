// tests/providers/mcp-tool-bridge.integration.test.ts
// P0-4 真证据：@codex / @gemini 真 spawn 经 buildApp 真正拿到 choco MCP 工具集，
// 一次工具调用经真 MCP server → 真 HTTP 回调 → callback 路由鉴权 → evidence 落库。
// 这是「codex 0.137 接受我们 --config mcp_servers.* TOML 格式」+「gemini 读项目级
// .gemini/settings.json」的端到端 GREEN 证明（单测/wiring 证格式，此处证真 CLI 贯通）。
//
// gated：RUN_CLI_SMOKE=1 npx vitest run tests/providers/mcp-tool-bridge.integration.test.ts
// 需真实安装 codex/gemini CLI + 凭证；未开启时整组 SKIP（绝不 fail）。
//
// 端口说明：MCP 子进程经 CHOCO_API_URL 发真 HTTP 回调，必须命中 LISTEN 中的 server，
// 而 apiBaseUrl 在 build 时定死（先于 listen）——故用固定端口让二者一致。

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '@choco/api/app-factory';
import { CodexAgentService } from '@choco/api/providers/codex/codex-service';
import { GeminiAgentService } from '@choco/api/providers/gemini/gemini-service';
import { createAgentId } from '@choco/shared';

const SMOKE_ENABLED = process.env.RUN_CLI_SMOKE === '1';
const TIMEOUT = 180_000;

/** Unique anchor per run (Date.now is fine here — gated manual smoke, not deterministic). */
function freshAnchor(tag: string): string {
  return `mcp-bridge-proof-${tag}-${Date.now()}`;
}

describe.skipIf(!SMOKE_ENABLED)('MCP tool bridge (real CLI, integration, non-gating)', () => {
  it('codex receives choco MCP via --config and a tool call round-trips to the callback', async () => {
    const port = 3219;
    const apiBaseUrl = `http://127.0.0.1:${port}`;
    const db = new Database(':memory:');
    const app = buildApp({
      db,
      agentServices: { 'codex-gpt': new CodexAgentService({ agentId: createAgentId('codex-gpt') }) },
      apiBaseUrl,
    });
    await app.api.listen({ port, host: '127.0.0.1' });
    try {
      const anchor = freshAnchor('codex');
      await app.api.inject({
        method: 'POST',
        url: '/api/threads/thread-codex-bridge/messages',
        payload: {
          content:
            `@codex 立刻调用 evidence_upsert 工具，参数：anchor="${anchor}" kind="decision" ` +
            `title="bridge proof" summary="codex mcp bridge ok"。只调用这一个工具，调用成功后用一句话确认即可。`,
          userId: 'user-proof',
        },
      });

      // The message route awaits the full turn; codex blocks on the tool result, so by
      // the time it returns the callback (evidence_upsert → POST /api/callback/...) has run.
      const item = app.stores.evidenceStore.getByAnchor(anchor);
      expect(item).not.toBeNull();
    } finally {
      await app.close();
    }
  }, TIMEOUT);

  it('gemini receives choco MCP via .gemini/settings.json and a tool call round-trips', async () => {
    const port = 3221;
    const apiBaseUrl = `http://127.0.0.1:${port}`;
    const workspace = mkdtempSync(join(tmpdir(), 'choco-gem-bridge-'));
    // gemini-cli 受信目录门：mkdtemp 未信任，需 trust env（spawn 继承 process.env）。
    const prevTrust = process.env['GEMINI_CLI_TRUST_WORKSPACE'];
    process.env['GEMINI_CLI_TRUST_WORKSPACE'] = 'true';
    const db = new Database(':memory:');
    const app = buildApp({
      db,
      agentServices: { 'gemini-pro': new GeminiAgentService({ agentId: createAgentId('gemini-pro') }) },
      apiBaseUrl,
      defaultWorkspace: workspace, // → app-factory writes <workspace>/.gemini/settings.json
    });
    await app.api.listen({ port, host: '127.0.0.1' });
    try {
      const anchor = freshAnchor('gemini');
      await app.api.inject({
        method: 'POST',
        url: '/api/threads/thread-gemini-bridge/messages',
        payload: {
          content:
            `@gemini 立刻调用 evidence_upsert 工具，参数：anchor="${anchor}" kind="decision" ` +
            `title="bridge proof" summary="gemini mcp bridge ok"。只调用这一个工具，调用成功后用一句话确认即可。`,
          userId: 'user-proof',
        },
      });

      const item = app.stores.evidenceStore.getByAnchor(anchor);
      expect(item).not.toBeNull();
    } finally {
      await app.close();
      if (prevTrust === undefined) delete process.env['GEMINI_CLI_TRUST_WORKSPACE'];
      else process.env['GEMINI_CLI_TRUST_WORKSPACE'] = prevTrust;
      // Best-effort: on Windows the just-killed gemini MCP child can briefly hold a
      // handle on the temp workspace → EBUSY. A leaked temp dir is harmless (OS-cleaned);
      // never let cleanup failure mask the real (already-asserted) MCP round-trip result.
      try {
        rmSync(workspace, { recursive: true, force: true });
      } catch {
        /* temp dir still locked by the exiting child — leave it for the OS */
      }
    }
  }, TIMEOUT);
});
