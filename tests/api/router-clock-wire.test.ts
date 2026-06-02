// H1 QA gate (dev≠QA): the AgentRouter clock-wire fix.
//
// buildApp() resolves an injectable clock `now` and threads it into the stores
// (so persisted messages are stamped with the INJECTED clock). The AgentRouter
// uses `now()` for its recent-mention fallback cutoff
// (agent-router.ts: `cutoff = this.now() - this.fallbackWindowMs`). The bug: the
// factory built the router WITHOUT passing `now`, so the router defaulted to
// Date.now while messages were stamped with the injected clock. Under a divergent
// injected clock (a fixed epoch far from wall-clock), every persisted mention fell
// OUTSIDE the router's wall-clock window, so the recent-mention fallback dropped
// them and resolveTargets returned the DEFAULT agent instead of the just-mentioned
// one. The fix wires the SAME `now` into `new AgentRouter({ ... now })`.
//
// These tests build a real buildApp() over a :memory: db with an injected
// divergent clock, persist real user messages through the M5 message store, and
// assert AgentRouter.resolveTargets resolves the recent-mention fallback against
// the SAME clock the messages were stamped with. No real CLI, no network port.
//
// Roster (packages/api/src/config/agents.yaml): claude-opus = DEFAULT (first
// entry), codex-gpt = @codex/@橘猫/@阿橘, gemini-pro = @gemini/@暹罗/@小罗.

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentId } from '@choco/shared';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { CLAUDE, CODEX, GEMINI } from './helpers.js';

/**
 * A fixed epoch deliberately FAR from wall-clock (2023-11-14T22:13:20Z). Pre-fix
 * the router used Date.now (~2025+) while messages were stamped with this clock,
 * so a mention stamped "now" landed ~2 years outside the router's 1h window and
 * the fallback silently dropped it. The injected clock makes the divergence
 * deterministic regardless of when the suite runs.
 */
const FIXED_NOW = 1_700_000_000_000;

/** The router's default recent-mention fallback window — 1 hour (DEFAULT_FALLBACK_WINDOW_MS). */
const FALLBACK_WINDOW_MS = 60 * 60 * 1000;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

/** Build a buildApp() over a :memory: db with the divergent clock injected. */
function appWithFixedClock(): BuiltApp {
  const db = new Database(':memory:');
  const app = buildApp({ db, now: () => FIXED_NOW });
  cleanups.push(app.close);
  return app;
}

/**
 * Persist a real user message that @mentions one agent, stamped at the given
 * timestamp. agentId:null marks it a user message; the router's fallback only
 * considers user messages whose `mentions` is non-empty within the window.
 */
async function appendUserMention(
  app: BuiltApp,
  threadId: string,
  content: string,
  mentions: readonly AgentId[],
  timestamp: number,
): Promise<void> {
  await app.stores.messageStore.append({
    threadId,
    userId: 'user-makima',
    agentId: null,
    content,
    mentions: [...mentions],
    origin: 'user',
    timestamp,
  });
}

describe('AgentRouter clock wire — recent-mention fallback under an injected clock', () => {
  it('BUG-EXPOSER: a fresh @codex mention falls back to codex-gpt (not the default) when the router shares the injected clock', async () => {
    // Arrange: a prior user message that @mentions @codex, stamped at the
    // injected "now" — fresh relative to the SAME clock the router must use.
    const app = appWithFixedClock();
    const threadId = 'thread-recent-codex';
    await appendUserMention(
      app,
      threadId,
      '@codex 把这个登录接口的重试逻辑补上，加上指数退避',
      [CODEX],
      FIXED_NOW,
    );

    // Act: a follow-up with NO @mention — must resolve via recent-mention fallback.
    const targets = await app.router.resolveTargets('继续，把单测也补齐', threadId);

    // Assert: the recent mention wins. Pre-fix (router on Date.now) this message
    // is ~2 years outside the 1h window, so it dropped to the default claude-opus.
    expect(targets).toEqual([CODEX]);
    expect(targets).not.toEqual([CLAUDE]);
  });

  it('BOUNDARY EDGE: a mention stamped just OUTSIDE the 1h window falls through to the default claude-opus (window still bounds correctly)', async () => {
    // Arrange: the mention is 1ms older than the fallback window relative to the
    // injected now — it must NOT be picked up (proves the fix didn't disable the window).
    const app = appWithFixedClock();
    const threadId = 'thread-stale-codex';
    await appendUserMention(
      app,
      threadId,
      '@codex 昨天那个迁移脚本你跑完了吗',
      [CODEX],
      FIXED_NOW - FALLBACK_WINDOW_MS - 1,
    );

    // Act
    const targets = await app.router.resolveTargets('现在还有什么要做的', threadId);

    // Assert: outside the window → no fallback hit → the roster default.
    expect(targets).toEqual([CLAUDE]);
  });

  it('BOUNDARY EDGE: a mention stamped exactly AT the window edge is still in-window and wins', async () => {
    // Arrange: timestamp == cutoff (now - windowMs). The router uses `>= cutoff`,
    // so the edge is inclusive — it must resolve to codex-gpt.
    const app = appWithFixedClock();
    const threadId = 'thread-edge-codex';
    await appendUserMention(
      app,
      threadId,
      '@codex 帮我把这个并发池的上限调成可配置',
      [CODEX],
      FIXED_NOW - FALLBACK_WINDOW_MS,
    );

    // Act
    const targets = await app.router.resolveTargets('记得加注释说明来源', threadId);

    // Assert: inclusive edge → fallback still fires.
    expect(targets).toEqual([CODEX]);
  });

  it('ADVERSARIAL: no prior mention at all resolves to the default claude-opus', async () => {
    // Arrange: a thread with a user message that carries NO mentions, plus an
    // empty follow-up. There is no recent mention to fall back to.
    const app = appWithFixedClock();
    const threadId = 'thread-no-mention';
    await appendUserMention(
      app,
      threadId,
      '我们今天先把数据库迁移的回滚方案理一理',
      [],
      FIXED_NOW,
    );

    // Act
    const targets = await app.router.resolveTargets('从哪开始比较好', threadId);

    // Assert: nothing to fall back to → roster default.
    expect(targets).toEqual([CLAUDE]);
  });

  it('ADVERSARIAL: an explicit @gemini in the current message wins over an in-window @codex fallback (explicit precedence)', async () => {
    // Arrange: a fresh in-window @codex mention exists, but the current message
    // explicitly @mentions @gemini — explicit mentions take precedence over fallback.
    const app = appWithFixedClock();
    const threadId = 'thread-explicit-wins';
    await appendUserMention(
      app,
      threadId,
      '@codex 先把脚手架搭好',
      [CODEX],
      FIXED_NOW,
    );

    // Act
    const targets = await app.router.resolveTargets('@gemini 帮我评审一下这个方案的边界条件', threadId);

    // Assert: explicit mention wins; the codex fallback is NOT consulted.
    expect(targets).toEqual([GEMINI]);
    expect(targets).not.toEqual([CODEX]);
  });
});
