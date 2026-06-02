// tests/routing/agent-router.test.ts
// M4 DEV happy-path: end-to-end routing decisions — mention routing, intent-driven
// strategy selection, and fallback to recent mention history.

import { describe, test, expect } from 'vitest';
import type { StoredMessage } from '@choco/shared';
import { AgentRouter } from '@choco/api/routing/agent-router';
import type { RecentMessageReader } from '@choco/api/routing/agent-router';
import {
  makeRegistry,
  makeRecordingInvoke,
  drain,
  fixedNow,
  FIXED_TS,
  CLAUDE,
  CODEX,
} from './helpers';

function makeHistory(messages: StoredMessage[]): RecentMessageReader {
  return {
    getByThread: async (_threadId, limit) =>
      messages.slice(0, limit ?? messages.length),
  };
}

describe('AgentRouter.resolveTargets — happy path (unit)', () => {
  test('explicit @mention resolves directly', async () => {
    const router = new AgentRouter({ registry: makeRegistry(), invoke: makeRecordingInvoke().invoke, now: fixedNow });
    expect(await router.resolveTargets('@codex review the parser', 't1')).toEqual([
      CODEX,
    ]);
  });

  test('no mention → fallback to most recent prior user message with mentions', async () => {
    const history = makeHistory([
      {
        id: 'm1',
        threadId: 't1',
        userId: 'user',
        agentId: null,
        content: '@claude design the schema',
        mentions: [CLAUDE],
        timestamp: FIXED_TS - 60_000,
      },
    ]);
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: makeRecordingInvoke().invoke,
      history,
      now: fixedNow,
    });
    expect(await router.resolveTargets('keep going please', 't1')).toEqual([CLAUDE]);
  });

  test('no mention and no history → default agent', async () => {
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: makeRecordingInvoke().invoke,
      history: makeHistory([]),
      now: fixedNow,
    });
    expect(await router.resolveTargets('hello team', 't1')).toEqual([CLAUDE]);
  });
});

describe('AgentRouter.route — happy path (unit)', () => {
  test('single @mention → serial strategy', async () => {
    const rec = makeRecordingInvoke({ [CLAUDE as string]: 'On it.' });
    const router = new AgentRouter({ registry: makeRegistry(), invoke: rec.invoke, now: fixedNow });
    await drain(router.route('user', '@claude write the auth middleware', 't1'));

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.context.mode).toBe('serial');
  });

  test('two @mentions → ideate → parallel strategy', async () => {
    const rec = makeRecordingInvoke({
      [CLAUDE as string]: 'Option A',
      [CODEX as string]: 'Option B',
    });
    const router = new AgentRouter({ registry: makeRegistry(), invoke: rec.invoke, now: fixedNow });
    await drain(
      router.route('user', '@claude @codex how should we shard the DB?', 't1'),
    );

    expect(rec.calls).toHaveLength(2);
    for (const call of rec.calls) {
      expect(call.context.mode).toBe('parallel');
    }
  });

  test('#execute forces serial even with two targets, and tags are stripped', async () => {
    const rec = makeRecordingInvoke({ [CLAUDE as string]: 'step 1' });
    const router = new AgentRouter({ registry: makeRegistry(), invoke: rec.invoke, now: fixedNow });
    await drain(
      router.route('user', '@claude @codex #execute ship the migration', 't1'),
    );

    expect(rec.calls[0]?.context.mode).toBe('serial');
    // Intent tag removed from the prompt the agent actually receives.
    expect(rec.calls[0]?.prompt).not.toContain('#execute');
    expect(rec.calls[0]?.prompt).toContain('ship the migration');
  });
});
