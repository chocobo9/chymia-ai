// tests/routing/route-parallel.test.ts
// M4 DEV happy-path: parallel fan-out interleaves independent agent streams.

import { describe, test, expect } from 'vitest';
import { routeParallel } from '@choco/api/routing/route-parallel';
import { makeRecordingInvoke, drain, CLAUDE, CODEX, GEMINI } from './helpers';

describe('routeParallel — happy path (unit)', () => {
  test('fans out to all targets in parallel mode (no prior-reply context)', async () => {
    const rec = makeRecordingInvoke({
      [CLAUDE as string]: 'Approach A: event sourcing.',
      [CODEX as string]: 'Approach B: CRUD + outbox.',
      [GEMINI as string]: 'Approach C: CQRS.',
    });

    const events = await drain(
      routeParallel({
        targets: [CLAUDE, CODEX, GEMINI],
        threadId: 'thread-ideate',
        prompt: 'propose an architecture for the orders service',
        invoke: rec.invoke,
        teammates: [CLAUDE, CODEX, GEMINI],
        mcpAvailable: true,
        promptTags: [],
      }),
    );

    // Every agent ran, all in parallel mode, each gets the same base prompt.
    expect(rec.calls).toHaveLength(3);
    for (const call of rec.calls) {
      expect(call.context.mode).toBe('parallel');
      expect(call.prompt).toBe('propose an architecture for the orders service');
    }

    // All three text replies + three dones are interleaved into the merged stream.
    const texts = events.filter((e) => e.type === 'text').map((e) => e.content);
    expect(texts.sort()).toEqual([
      'Approach A: event sourcing.',
      'Approach B: CRUD + outbox.',
      'Approach C: CQRS.',
    ]);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(3);
  });
});
