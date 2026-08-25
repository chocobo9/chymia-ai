// tests/routing/agent-router-participants.integration.test.ts
// P0-1 gap #1 + #3 — Clowder participant model alignment.
//
// Aligned-To: reference/clowder-ai-main/.../routing/AgentRouter.ts
//   - resolveTargets (line ~818): mention 命中 → addParticipants(threadId, mentioned)
//   - peekTargets (line ~758): 只读，NOT mutate participants
//   - getParticipantsWithActivity (line ~790): participant-based three-tier fallback
//
// Real evidence class: 真 SqliteThreadStore + 真 SqliteMessageStore round-trip
// (NOT FakeAgentService). The invoke seam is a recording fake because the unit
// under test is ROUTING + PARTICIPANT PERSISTENCE, not the CLI invocation — the
// participant model is independent of whether a provider CLI actually ran.

import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { AgentRouter } from '@choco/api/routing/agent-router';
import { SqliteThreadStore } from '@choco/api/stores/sqlite-thread-store';
import { SqliteMessageStore } from '@choco/api/stores/sqlite-message-store';
import { AgentRegistryImpl } from '@choco/api/routing/agent-registry';
import type { AgentService } from '@choco/api/providers/base';
import type { AgentMessage } from '@choco/shared';
import {
  makeRegistry,
  makeRecordingInvoke,
  drain,
  fixedNow,
  FIXED_TS,
  ALL_CONFIGS,
  CLAUDE,
  CODEX,
  GEMINI,
} from './helpers';

/** Fresh in-memory db + real stores per test (hermetic). */
function build(): { threadStore: SqliteThreadStore; messageStore: SqliteMessageStore } {
  const db = new Database(':memory:');
  const threadStore = new SqliteThreadStore(db);
  const messageStore = new SqliteMessageStore(db);
  return { threadStore, messageStore };
}

/** A no-op AgentService (these tests drive the invoke seam, not real services). */
const noopService: AgentService = {
  invoke(): AsyncIterable<AgentMessage> {
    return (async function* (): AsyncIterable<AgentMessage> {})();
  },
};

/** Registry over the standard roster with an explicit availability map. */
function registryWith(availability: Record<string, boolean>): AgentRegistryImpl {
  const services: Record<string, AgentService> = {};
  for (const c of ALL_CONFIGS) services[c.id as string] = noopService;
  return new AgentRegistryImpl(ALL_CONFIGS, services, { availability, defaultAgentId: CLAUDE });
}

describe('AgentRouter — Clowder participant model (gap #1 + #3)', () => {
  test('route persists an explicit @mention to thread participants (gap #1)', async () => {
    const { threadStore, messageStore } = build();
    await threadStore.ensureThread('t1', 'x');
    const rec = makeRecordingInvoke({ [CODEX as string]: 'on it' });
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: rec.invoke,
      history: messageStore,
      threadStore,
      now: fixedNow,
    });

    await drain(router.route('user', '@codex review the parser', 't1'));

    const thread = await threadStore.get('t1');
    expect(thread?.participants).toContain(CODEX);
  });

  test('route persists an @all broadcast expansion to participants', async () => {
    const { threadStore, messageStore } = build();
    await threadStore.ensureThread('t1', 'x');
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: makeRecordingInvoke().invoke,
      history: messageStore,
      threadStore,
      now: fixedNow,
    });

    await drain(router.route('user', '@all brainstorm the schema', 't1'));

    const thread = await threadStore.get('t1');
    expect(thread?.participants).toEqual(expect.arrayContaining([CLAUDE, CODEX, GEMINI]));
  });

  test('peek (resolveRouting) does NOT mutate participants (gap #3 — read-only)', async () => {
    const { threadStore, messageStore } = build();
    await threadStore.ensureThread('t1', 'x');
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: makeRecordingInvoke().invoke,
      history: messageStore,
      threadStore,
      now: fixedNow,
    });

    await router.resolveRouting('@codex review', 't1');

    const thread = await threadStore.get('t1');
    expect(thread?.participants).toEqual([]);
  });

  test('fallback routing (no explicit mention) does NOT persist participants', async () => {
    const { threadStore, messageStore } = build();
    await threadStore.ensureThread('t1', 'x');
    // A prior user @claude makes recent-mention fallback resolve to claude…
    await messageStore.append({
      threadId: 't1',
      userId: 'user',
      agentId: null,
      content: '@claude design the schema',
      mentions: [CLAUDE],
      origin: 'user',
      timestamp: FIXED_TS - 60_000,
    });
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: makeRecordingInvoke({ [CLAUDE as string]: 'ok' }).invoke,
      history: messageStore,
      threadStore,
      now: fixedNow,
    });

    await drain(router.route('user', 'keep going please', 't1'));

    // …but a fallback target is NOT written back as a participant (Clowder:
    // addParticipants only on the explicit-mention branch of resolveTargets).
    const thread = await threadStore.get('t1');
    expect(thread?.participants).toEqual([]);
  });

  test('no-mention falls back to a healthy participant replier (participant activity)', async () => {
    const { threadStore, messageStore } = build();
    await threadStore.ensureThread('t1', 'x');
    // CODEX is a thread participant who has actually spoken (messageCount > 0)…
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
    const rec = makeRecordingInvoke({ [CODEX as string]: 'continue' });
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: rec.invoke,
      history: messageStore,
      threadStore,
      now: fixedNow,
    });

    // No explicit mention + no recent USER @mention → participant-activity
    // fallback should continue with CODEX, NOT the default agent (CLAUDE).
    await drain(router.route('user', 'keep going', 't1'));

    expect(rec.calls.map((c) => c.agentId)).toEqual([CODEX]);
  });

  test('getParticipantsWithActivity reports per-participant messageCount', async () => {
    const { threadStore, messageStore } = build();
    await threadStore.ensureThread('t1', 'x');
    await threadStore.addParticipants('t1', [CODEX, CLAUDE]);
    await messageStore.append({
      threadId: 't1',
      userId: 'user',
      agentId: CODEX,
      content: 'a',
      mentions: [],
      origin: 'stream',
      timestamp: FIXED_TS,
    });
    await messageStore.append({
      threadId: 't1',
      userId: 'user',
      agentId: CODEX,
      content: 'b',
      mentions: [],
      origin: 'stream',
      timestamp: FIXED_TS + 1,
    });

    const activity = await threadStore.getParticipantsWithActivity('t1');

    expect(activity.find((p) => p.agentId === CODEX)?.messageCount).toBe(2);
    expect(activity.find((p) => p.agentId === CLAUDE)?.messageCount).toBe(0);
  });

  test('an @mention of an UNAVAILABLE agent is NOT persisted as a participant', async () => {
    const { threadStore, messageStore } = build();
    await threadStore.ensureThread('t1', 'x');
    const router = new AgentRouter({
      registry: registryWith({ [CODEX as string]: false }),
      invoke: makeRecordingInvoke().invoke,
      history: messageStore,
      threadStore,
      now: fixedNow,
    });

    // @codex is unavailable → mentioned set is its AVAILABLE subset (empty) → route
    // persists nothing (an unavailable mention never joins participants).
    await drain(router.route('user', '@codex review', 't1'));

    const thread = await threadStore.get('t1');
    expect(thread?.participants).not.toContain(CODEX);
    expect(thread?.participants).toEqual([]);
  });

  test('participant fallback prefers a replier (messageCount>0) over a silent participant', async () => {
    const { threadStore, messageStore } = build();
    await threadStore.ensureThread('t1', 'x');
    // Both are participants, but only CODEX has actually replied (messageCount > 0);
    // CLAUDE (also the default agent + first participant) has stayed silent.
    await threadStore.addParticipants('t1', [CLAUDE, CODEX]);
    await messageStore.append({
      threadId: 't1',
      userId: 'user',
      agentId: CODEX,
      content: 'previous reply',
      mentions: [],
      origin: 'stream',
      timestamp: FIXED_TS - 1000,
    });
    const rec = makeRecordingInvoke({ [CODEX as string]: 'continue' });
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: rec.invoke,
      history: messageStore,
      threadStore,
      now: fixedNow,
    });

    // healthyReplier tier (messageCount>0) must win over the silent CLAUDE, even
    // though CLAUDE is the default agent and the first participant.
    await drain(router.route('user', 'keep going', 't1'));

    expect(rec.calls.map((c) => c.agentId)).toEqual([CODEX]);
  });
});
