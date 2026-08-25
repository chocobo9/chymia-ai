// tests/routing/thread-routing-policy.integration.test.ts
// P0-1 gap #2 — thread routing policy (F042).
//
// Aligned-To: reference/clowder-ai-main/.../routing/AgentRouter.ts
//   - applyThreadRoutingPolicy (line ~448): fallback-only avoid/prefer shaping
//   - inferRoutingScope (line ~119): review / architecture cue detection
// Aligned-To: reference/clowder-ai-main/.../stores/ports/ThreadStore.ts
//   - updateRoutingPolicy (line ~712): set / clear (null / non-v1 / empty scopes)
//
// Real evidence class: 真 SqliteThreadStore round-trip + 真 AgentRouter decision.
// invoke = recording fake — a routing POLICY is a pure routing decision + SQLite
// persistence, NOT a CLI path, so a real spawn adds no signal to these branches.

import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { ThreadRoutingPolicyV1 } from '@choco/shared';
import { AgentRouter } from '@choco/api/routing/agent-router';
import { SqliteThreadStore } from '@choco/api/stores/sqlite-thread-store';
import { SqliteMessageStore } from '@choco/api/stores/sqlite-message-store';
import {
  makeRegistry,
  makeRecordingInvoke,
  drain,
  fixedNow,
  FIXED_TS,
  CLAUDE,
  CODEX,
  GEMINI,
} from './helpers';

function build(): { threadStore: SqliteThreadStore; messageStore: SqliteMessageStore } {
  const db = new Database(':memory:');
  return { threadStore: new SqliteThreadStore(db), messageStore: new SqliteMessageStore(db) };
}

/** Seed a thread whose sole healthy participant-replier is CODEX. */
async function seedCodexParticipant(
  threadStore: SqliteThreadStore,
  messageStore: SqliteMessageStore,
): Promise<void> {
  await threadStore.ensureThread('t1', 'x');
  await threadStore.addParticipants('t1', [CODEX]);
  await messageStore.append({
    threadId: 't1',
    userId: 'user',
    agentId: CODEX,
    content: 'previous reply',
    mentions: [],
    origin: 'stream',
    timestamp: FIXED_TS - 1000,
  });
}

describe('SqliteThreadStore.updateRoutingPolicy (F042)', () => {
  test('set then get round-trips the policy', async () => {
    const { threadStore } = build();
    await threadStore.ensureThread('t1', 'x');
    const policy: ThreadRoutingPolicyV1 = { v: 1, scopes: { review: { avoidCats: [CODEX] } } };

    await threadStore.updateRoutingPolicy('t1', policy);

    const t = await threadStore.get('t1');
    expect(t?.routingPolicy?.scopes?.review?.avoidCats).toEqual([CODEX]);
  });

  test('null clears the policy', async () => {
    const { threadStore } = build();
    await threadStore.ensureThread('t1', 'x');
    await threadStore.updateRoutingPolicy('t1', { v: 1, scopes: { review: { avoidCats: [CODEX] } } });

    await threadStore.updateRoutingPolicy('t1', null);

    expect((await threadStore.get('t1'))?.routingPolicy).toBeUndefined();
  });

  test('empty scopes clears the policy', async () => {
    const { threadStore } = build();
    await threadStore.ensureThread('t1', 'x');
    await threadStore.updateRoutingPolicy('t1', { v: 1, scopes: { review: { avoidCats: [CODEX] } } });

    await threadStore.updateRoutingPolicy('t1', { v: 1, scopes: {} });

    expect((await threadStore.get('t1'))?.routingPolicy).toBeUndefined();
  });
});

describe('AgentRouter routing policy (F042) — fallback only', () => {
  test('review-scope avoidCats skips the avoided agent on fallback', async () => {
    const { threadStore, messageStore } = build();
    await seedCodexParticipant(threadStore, messageStore);
    await threadStore.updateRoutingPolicy('t1', { v: 1, scopes: { review: { avoidCats: [CODEX] } } });
    const rec = makeRecordingInvoke({ [CLAUDE as string]: 'ok' });
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: rec.invoke,
      history: messageStore,
      threadStore,
      now: fixedNow,
    });

    // No @mention + review cue → participant fallback would pick CODEX, but the
    // policy avoids it → pickFallbackExcluding(avoid) lands on the default (CLAUDE).
    await drain(router.route('user', 'please review this PR', 't1'));

    expect(rec.calls.map((c) => c.agentId)).toEqual([CLAUDE]);
  });

  test('explicit @mention is NOT policy-filtered (avoidCats ignored for explicit @)', async () => {
    const { threadStore, messageStore } = build();
    await threadStore.ensureThread('t1', 'x');
    await threadStore.updateRoutingPolicy('t1', { v: 1, scopes: { review: { avoidCats: [CODEX] } } });
    const rec = makeRecordingInvoke({ [CODEX as string]: 'ok' });
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: rec.invoke,
      history: messageStore,
      threadStore,
      now: fixedNow,
    });

    // Explicit @codex in a review message → policy does NOT filter it (avoidCats:
    // "unless explicitly @mentioned").
    await drain(router.route('user', '@codex please review this', 't1'));

    expect(rec.calls.map((c) => c.agentId)).toEqual([CODEX]);
  });

  test('expired rule is ignored (avoid no longer applies)', async () => {
    const { threadStore, messageStore } = build();
    await seedCodexParticipant(threadStore, messageStore);
    await threadStore.updateRoutingPolicy('t1', {
      v: 1,
      scopes: { review: { avoidCats: [CODEX], expiresAt: FIXED_TS - 1 } },
    });
    const rec = makeRecordingInvoke({ [CODEX as string]: 'ok' });
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: rec.invoke,
      history: messageStore,
      threadStore,
      now: fixedNow,
    });

    await drain(router.route('user', 'please review this PR', 't1'));

    expect(rec.calls.map((c) => c.agentId)).toEqual([CODEX]);
  });

  test('a message with no review/architecture cue does not apply the policy', async () => {
    const { threadStore, messageStore } = build();
    await seedCodexParticipant(threadStore, messageStore);
    await threadStore.updateRoutingPolicy('t1', { v: 1, scopes: { review: { avoidCats: [CODEX] } } });
    const rec = makeRecordingInvoke({ [CODEX as string]: 'ok' });
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: rec.invoke,
      history: messageStore,
      threadStore,
      now: fixedNow,
    });

    // 'keep going' has no review/arch cue → scope null → CODEX not avoided.
    await drain(router.route('user', 'keep going', 't1'));

    expect(rec.calls.map((c) => c.agentId)).toEqual([CODEX]);
  });

  test('preferCats fronts (and injects) the preferred agent on fallback', async () => {
    const { threadStore, messageStore } = build();
    await seedCodexParticipant(threadStore, messageStore);
    await threadStore.updateRoutingPolicy('t1', {
      v: 1,
      scopes: { architecture: { preferCats: [GEMINI] } },
    });
    const rec = makeRecordingInvoke({ [GEMINI as string]: 'a', [CODEX as string]: 'b' });
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: rec.invoke,
      history: messageStore,
      threadStore,
      now: fixedNow,
    });

    // architecture cue → preferCats[GEMINI] goes first (injected even though it was
    // not a participant), then the original fallback candidate (CODEX). #execute
    // forces serial so the call order is deterministic.
    await drain(router.route('user', '讨论架构设计 #execute', 't1'));

    expect(rec.calls[0]?.agentId).toBe(GEMINI);
    expect(rec.calls.map((c) => c.agentId)).toContain(CODEX);
  });
});
