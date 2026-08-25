// tests/api/malformed-relay-e2e.integration.test.ts
// gap #4 end-to-end — form A (injected) → REAL-spawn relay cat takes over.
//
// Why injected form A: thinking-only (form A) is claude #49747 — it cannot be
// reliably real-spawned (a real claude almost always replies normally). So the
// ONLY non-real piece is the claude-opus provider, which is faked to emit a form A
// turn. EVERYTHING ELSE is real: the HTTP route, handleThreadMessage, AgentRouter,
// routeSerial worklist, invoke-single-agent suppress+fresh-retry+relay, and the
// relay cat (claude-opus-relay) which is a REAL ClaudeAgentService that really
// spawns `claude --model claude-sonnet-4-6` to produce the actual answer.
//
// This closes the gap the layer unit tests left: the relay HANDOFF + backup
// execution end-to-end over the real chain (only form A's *manufacture* is faked).
//
// gated：RUN_CLI_SMOKE=1 npx vitest run tests/api/malformed-relay-e2e.integration.test.ts
// 需真实安装 claude CLI + 凭证（relay cat 真 spawn sonnet）；未开启时 SKIP。

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@choco/shared';
import { createAgentId } from '@choco/shared';
import type { AgentService } from '@choco/api/providers/base';
import { buildApp } from '@choco/api/app-factory';
import { ClaudeAgentService } from '@choco/api/providers/claude/claude-service';

const SMOKE_ENABLED = process.env.RUN_CLI_SMOKE === '1';
const PER_TEST_TIMEOUT = 300_000;

const CLAUDE = createAgentId('claude-opus');
const RELAY = createAgentId('claude-opus-relay');

interface ReplyShape {
  readonly agentId: string | null;
  readonly content: string;
}

/** Fake claude-opus provider: every invoke emits a form A (thinking-only) turn. */
class FormAClaudeService implements AgentService {
  invoke(): AsyncIterable<AgentMessage> {
    return (async function* (): AsyncIterable<AgentMessage> {
      yield { type: 'session_init', agentId: CLAUDE, content: 's-formA', timestamp: 1 };
      yield { type: 'thinking', agentId: CLAUDE, content: '只想不说，没有产出……', timestamp: 1 };
      yield {
        type: 'system_info',
        agentId: CLAUDE,
        content: JSON.stringify({ type: 'malformed_toolcall_detected', form: 'A' }),
        timestamp: 1,
      };
      yield {
        type: 'error',
        agentId: CLAUDE,
        content: 'malformed_toolcall: thinking-only 炸毛',
        errorCode: 'malformed_toolcall',
        timestamp: 1,
      };
      yield { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: 1 };
    })();
  }
}

describe.skipIf(!SMOKE_ENABLED)('gap #4 e2e — form A → real-spawn relay takes over', () => {
  it('@claude form A (fresh-retry exhausted) relays to the backup cat which REALLY spawns and answers', async () => {
    const db = new Database(':memory:');
    // clean (non-git) cwd so the relay spawn does not inherit the workspace .claude.
    const cwd = mkdtempSync(join(tmpdir(), 'choco-relay-e2e-'));
    const app = buildApp({
      db,
      defaultWorkspace: cwd,
      agentServices: {
        // claude-opus always form A (injected — #49747 can't be real-spawned)
        'claude-opus': new FormAClaudeService(),
        // the relay target is a REAL claude service on sonnet — it really spawns.
        'claude-opus-relay': new ClaudeAgentService({ agentId: RELAY, defaultModel: 'claude-sonnet-4-6' }),
      },
    });
    try {
      const res = await app.api.inject({
        method: 'POST',
        url: '/api/threads/t-relay-e2e/messages',
        payload: { content: '@claude 只回一个词：OK' },
      });
      expect(res.statusCode).toBe(200);
      const replies = (res.json() as { replies: ReplyShape[] }).replies;

      // The backup cat really spawned (sonnet) and produced the actual answer —
      // proving the full chain (route → invoke suppress+fresh-retry+relay → route
      // push backup → real spawn) holds end-to-end.
      expect(replies.some((r) => r.agentId === (RELAY as string) && r.content.length > 0)).toBe(true);
      // The raw malformed error did NOT leak to the user (suppressed; relay took over).
      expect(
        replies.some((r) => r.agentId === (CLAUDE as string) && r.content.startsWith('malformed_toolcall:')),
      ).toBe(false);
    } finally {
      await app.close();
    }
  }, PER_TEST_TIMEOUT);
});
