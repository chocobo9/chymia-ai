// tests/routing/route-serial-relay.test.ts
// gap #4 Layer 4 — route-serial consumes the malformed relay signal (F215 AC-C3).
//
// Aligned-To: reference/clowder-ai-main/.../routing/route-serial.ts (:761-1149)
//   consume malformed_toolcall_relay_46 → push the backup model cat onto the
//   worklist + suppress the malformed final error.
//
// The invoke seam is a fake replaying the invoke-layer's relay output (relay card +
// relay signal + malformed error). routeSerial logic — consume / suppress / push —
// is real; this is the same evidence class as the rest of gap #4 (form A cannot be
// reliably real-spawned; claude #49747).

import { describe, test, expect } from 'vitest';
import type { AgentMessage } from '@choco/shared';
import { routeSerial, RELAY_AGENT_ID } from '@choco/api/routing/route-serial';
import type { RouteSerialParams } from '@choco/api/routing/route-serial';
import type { InvokeAgentFn } from '@choco/api/routing/agent-router';
import { drain, CLAUDE } from './helpers';

/** Fake invoke: claude replays the relay output; the relay cat replies normally. */
const relayInvoke: InvokeAgentFn = (args): AsyncIterable<AgentMessage> => {
  const agentId = args.agentId;
  return (async function* (): AsyncIterable<AgentMessage> {
    if (agentId === CLAUDE) {
      // invoke-layer relay sequence on malformed exhaustion (Layer 3 output).
      yield { type: 'text', agentId, content: '主模型多次输出无效，正在切换备用模型重试……', timestamp: 1 };
      yield {
        type: 'system_info',
        agentId,
        content: JSON.stringify({ type: 'malformed_toolcall_relay_46' }),
        timestamp: 1,
      };
      yield {
        type: 'error',
        agentId,
        content: 'malformed_toolcall: 主模型 fresh-context 重试仍失败',
        errorCode: 'malformed_toolcall',
        timestamp: 1,
      };
      yield { type: 'done', agentId, isFinal: true, timestamp: 1 };
      return;
    }
    if (agentId === RELAY_AGENT_ID) {
      yield { type: 'text', agentId, content: '备用模型的正常回复', timestamp: 1 };
      yield { type: 'done', agentId, isFinal: true, timestamp: 1 };
      return;
    }
    yield { type: 'done', agentId, isFinal: true, timestamp: 1 };
  })();
};

function baseParams(): RouteSerialParams {
  return {
    targets: [CLAUDE],
    threadId: 't-relay',
    prompt: 'x',
    invoke: relayInvoke,
    mentionEntries: [],
    teammates: [CLAUDE],
    mcpAvailable: false,
    promptTags: [],
    now: () => 1,
  };
}

describe('routeSerial — malformed relay (F215 Layer 4)', () => {
  test('relay target present: pushes backup cat, suppresses signal + error, keeps the card', async () => {
    const events = await drain(routeSerial({ ...baseParams(), relayAgentId: RELAY_AGENT_ID }));
    const agentIds = events.map((e) => e.agentId);

    // The backup cat was pushed onto the worklist and ran.
    expect(agentIds).toContain(RELAY_AGENT_ID);
    expect(
      events.some((e) => e.type === 'text' && e.agentId === RELAY_AGENT_ID && (e.content ?? '').includes('备用模型的正常回复')),
    ).toBe(true);
    // The internal relay signal is consumed (never forwarded).
    expect(events.some((e) => e.type === 'system_info' && (e.content ?? '').includes('malformed_toolcall_relay_46'))).toBe(false);
    // The malformed final error is suppressed (the backup takes over).
    expect(events.some((e) => e.type === 'error' && e.errorCode === 'malformed_toolcall')).toBe(false);
    // The user-visible relay card still shows.
    expect(events.some((e) => e.type === 'text' && (e.content ?? '').includes('切换备用模型'))).toBe(true);
  });

  test('no relay target: backup is NOT pushed and the malformed error surfaces', async () => {
    // relayAgentId omitted (relay cat unregistered/unavailable).
    const events = await drain(routeSerial(baseParams()));
    const agentIds = events.map((e) => e.agentId);

    expect(agentIds).not.toContain(RELAY_AGENT_ID);
    // Signal is still consumed (internal), but with no backup the error must surface
    // so the user is not left with a "switching" card and no recovery.
    expect(events.some((e) => e.type === 'system_info' && (e.content ?? '').includes('malformed_toolcall_relay_46'))).toBe(false);
    expect(events.some((e) => e.type === 'error' && e.errorCode === 'malformed_toolcall')).toBe(true);
  });
});
