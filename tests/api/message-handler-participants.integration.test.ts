// tests/api/message-handler-participants.integration.test.ts
// P0-1 gap #1 — participant model through the FULL handler chain, real CLI.
//
// The other participant evidence drives router.route() directly. This closes the
// last gap: a real HTTP POST → handleThreadMessage → AgentRouter.route() →
// invokeSingleAgent → real codex CLI, asserting the @mention is persisted as a
// thread participant across the entire web request path (ensureThread → append →
// route() route-time persistence → persistReplies → updateLastActive), and that
// the handler's convergence holds (it no longer post-hoc logs every speaker — an
// un-mentioned agent that never ran does not become a participant).
//
// gated：RUN_CLI_SMOKE=1 npx vitest run tests/api/message-handler-participants.integration.test.ts
// 需真实安装 codex CLI + 凭证；未开启时 SKIP（绝不 fail）。

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentId } from '@choco/shared';
import { buildApp } from '@choco/api/app-factory';
import { ClaudeAgentService } from '@choco/api/providers/claude/claude-service';
import { CodexAgentService } from '@choco/api/providers/codex/codex-service';
import { GeminiAgentService } from '@choco/api/providers/gemini/gemini-service';

const SMOKE_ENABLED = process.env.RUN_CLI_SMOKE === '1';
const PER_TEST_TIMEOUT = 300_000;

const CLAUDE = createAgentId('claude-opus');
const CODEX = createAgentId('codex-gpt');
const GEMINI = createAgentId('gemini-pro');

interface ReplyShape {
  readonly agentId: string | null;
  readonly content: string;
}

describe.skipIf(!SMOKE_ENABLED)('handler full-chain participant model (real CLI)', () => {
  it('POST @codex persists codex as a participant via the full HTTP→handler→CLI chain; un-mentioned agents stay out; a no-mention follow-up continues with codex', async () => {
    const db = new Database(':memory:');
    // Clean (non-git) cwd so codex auto-adds --skip-git-repo-check and the spawn
    // does not inherit the workspace's own .claude/CLAUDE.md context.
    const cwd = mkdtempSync(join(tmpdir(), 'choco-handler-participant-'));
    const app = buildApp({
      db,
      defaultWorkspace: cwd,
      agentServices: {
        [CLAUDE as string]: new ClaudeAgentService({ agentId: CLAUDE }),
        [CODEX as string]: new CodexAgentService({ agentId: CODEX }),
        [GEMINI as string]: new GeminiAgentService({ agentId: GEMINI }),
      },
    });
    const threadId = 'handler-participant-thread';
    try {
      // 1. @codex through the REAL web route. handleThreadMessage → router.route()
      //    persists codex at routing time, then real-spawns codex.
      const r1 = await app.api.inject({
        method: 'POST',
        url: `/api/threads/${threadId}/messages`,
        payload: { content: '@codex 只回一个词：OK' },
      });
      expect(r1.statusCode).toBe(200);
      const replies1 = (r1.json() as { replies: ReplyShape[] }).replies;
      expect(replies1.some((m) => m.agentId === (CODEX as string) && m.content.length > 0)).toBe(true);

      // Persisted as a participant across the full chain.
      const t1 = await app.stores.threadStore.get(threadId);
      expect(t1?.participants).toContain(CODEX);
      // Convergence: only the @mentioned agent joins. claude/gemini never ran, so
      // the handler (which no longer post-hoc logs speakers) leaves them out.
      expect(t1?.participants).not.toContain(CLAUDE);
      expect(t1?.participants).not.toContain(GEMINI);

      // 2. A no-mention follow-up continues with codex (NOT the default claude) and
      //    real-spawns it — the conversation stays with the established agent.
      const r2 = await app.api.inject({
        method: 'POST',
        url: `/api/threads/${threadId}/messages`,
        payload: { content: '只回一个词：OK' },
      });
      expect(r2.statusCode).toBe(200);
      const replies2 = (r2.json() as { replies: ReplyShape[] }).replies;
      expect(replies2.some((m) => m.agentId === (CODEX as string) && m.content.length > 0)).toBe(true);
      expect(replies2.some((m) => m.agentId === (CLAUDE as string))).toBe(false);
    } finally {
      await app.close();
    }
  }, PER_TEST_TIMEOUT);
});
