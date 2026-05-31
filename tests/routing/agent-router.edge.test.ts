// tests/routing/agent-router.edge.test.ts
// M4 QA — independent edge + adversarial gate for AgentRouter target resolution
// (the Z5 fallback) and intent-driven strategy selection. Deterministic clock.

import { describe, test, expect } from 'vitest';
import type { StoredMessage } from '@clowder/shared';
import { AgentRouter } from '@clowder/api/routing/agent-router';
import type { RecentMessageReader } from '@clowder/api/routing/agent-router';
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

const HOUR_MS = 60 * 60 * 1000;

function userMsg(
  id: string,
  mentions: typeof CLAUDE[],
  timestamp: number,
): StoredMessage {
  return {
    id,
    threadId: 't1',
    userId: 'user',
    agentId: null,
    content: mentions.length > 0 ? `${mentions[0] as string} please continue` : 'please continue',
    mentions: [...mentions],
    timestamp,
  };
}

/** A store-like reader: most-recent first, honouring the requested limit. */
function recentReader(messages: StoredMessage[]): RecentMessageReader {
  return {
    getByThread: async (_threadId, limit) =>
      [...messages]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit ?? messages.length),
  };
}

describe('AgentRouter fallback — edge', () => {
  test('(edge) a mention older than the 1h window expires → default agent, not the stale one', async () => {
    const history = recentReader([userMsg('m1', [GEMINI], FIXED_TS - 2 * HOUR_MS)]);
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: makeRecordingInvoke().invoke,
      history,
      now: fixedNow,
    });
    // Stale GEMINI mention is dropped → falls through to the default (claude).
    expect(await router.resolveTargets('keep going', 't1')).toEqual([CLAUDE]);
  });

  test('(edge) a mention exactly at the window boundary is still honoured', async () => {
    const history = recentReader([userMsg('m1', [GEMINI], FIXED_TS - HOUR_MS)]);
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: makeRecordingInvoke().invoke,
      history,
      now: fixedNow,
    });
    expect(await router.resolveTargets('keep going', 't1')).toEqual([GEMINI]);
  });

  test('(edge) the freshest message carrying mentions wins', async () => {
    const history = recentReader([
      userMsg('older', [CLAUDE], FIXED_TS - 2000),
      userMsg('newer', [CODEX], FIXED_TS - 1000),
    ]);
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: makeRecordingInvoke().invoke,
      history,
      now: fixedNow,
    });
    expect(await router.resolveTargets('continue', 't1')).toEqual([CODEX]);
  });

  test('(edge) agent-authored messages are ignored by mention fallback', async () => {
    const agentMsg: StoredMessage = {
      id: 'a1',
      threadId: 't1',
      userId: 'agent',
      agentId: CLAUDE,
      content: '@gemini take the next step',
      mentions: [GEMINI],
      timestamp: FIXED_TS - 1000,
    };
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: makeRecordingInvoke().invoke,
      history: recentReader([agentMsg]),
      now: fixedNow,
    });
    expect(await router.resolveTargets('next please', 't1')).toEqual([CLAUDE]);
  });

  test('(edge) a mention beyond the fallback message limit is not consulted', async () => {
    const history = recentReader([
      userMsg('oldest-has-mention', [GEMINI], FIXED_TS - 3000),
      userMsg('recent-1', [], FIXED_TS - 2000),
      userMsg('recent-2', [], FIXED_TS - 1000),
    ]);
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: makeRecordingInvoke().invoke,
      history,
      now: fixedNow,
      config: { fallbackMessageLimit: 2 },
    });
    // Only the two most-recent (mention-less) messages are scanned → default.
    expect(await router.resolveTargets('keep going', 't1')).toEqual([CLAUDE]);
  });

  test('(edge) #ideate forces parallel even for a single explicit target', async () => {
    const rec = makeRecordingInvoke({ [CLAUDE as string]: 'idea one' });
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: rec.invoke,
      now: fixedNow,
    });
    await drain(router.route('user', '@claude #ideate brainstorm cache keys', 't1'));
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.context.mode).toBe('parallel');
  });
});

describe('AgentRouter fallback — adversarial', () => {
  test('(adversarial) no history reader configured → default agent, no throw', async () => {
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: makeRecordingInvoke().invoke,
      now: fixedNow,
    });
    expect(await router.resolveTargets('hello team', 't1')).toEqual([CLAUDE]);
  });

  test('(adversarial) history with no mentions at all → default agent', async () => {
    const history = recentReader([
      userMsg('m1', [], FIXED_TS - 1000),
      userMsg('m2', [], FIXED_TS - 2000),
    ]);
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: makeRecordingInvoke().invoke,
      history,
      now: fixedNow,
    });
    expect(await router.resolveTargets('keep going', 't1')).toEqual([CLAUDE]);
  });

  test('(adversarial) no mention + no history routes the default once, serially', async () => {
    const rec = makeRecordingInvoke({ [CLAUDE as string]: 'on it' });
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: rec.invoke,
      now: fixedNow,
    });
    await drain(router.route('user', 'status update please', 't1'));
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.context.mode).toBe('serial');
  });

  test('(adversarial) a message that is only #ideate (no mention) → default agent, parallel', async () => {
    const rec = makeRecordingInvoke({ [CLAUDE as string]: 'idea' });
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: rec.invoke,
      now: fixedNow,
    });
    await drain(router.route('user', '#ideate', 't1'));
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.context.mode).toBe('parallel');
  });
});
