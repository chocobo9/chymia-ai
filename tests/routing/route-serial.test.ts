// tests/routing/route-serial.test.ts
// M4 DEV happy-path: serial chaining, serial context passing, A2A worklist
// expansion. Deterministic recording invoke seam, fixed clock.

import { describe, test, expect } from 'vitest';
import { routeSerial } from '@clowder/api/routing/route-serial';
import {
  makeRecordingInvoke,
  drain,
  fixedNow,
  CLAUDE,
  CODEX,
  GEMINI,
  ALL_CONFIGS,
} from './helpers';

const ENTRIES = ALL_CONFIGS.flatMap((c) =>
  c.mentionPatterns.map((pattern) => ({ agentId: c.id, pattern })),
);

function serialParams(
  targets: readonly typeof CLAUDE[],
  invoke: ReturnType<typeof makeRecordingInvoke>['invoke'],
): Parameters<typeof routeSerial>[0] {
  return {
    targets,
    threadId: 'thread-todo-api',
    prompt: 'write a TODO API with CRUD endpoints',
    invoke,
    mentionEntries: ENTRIES,
    teammates: targets,
    mcpAvailable: true,
    promptTags: [],
    now: fixedNow,
  };
}

describe('routeSerial — happy path (unit)', () => {
  test('single target routes serially with chain position 1/1', async () => {
    const rec = makeRecordingInvoke({
      [CLAUDE as string]: 'Here is your TODO API implementation.',
    });
    const events = await drain(routeSerial(serialParams([CLAUDE], rec.invoke)));

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.context.mode).toBe('serial');
    expect(rec.calls[0]?.context.chainIndex).toBe(1);
    expect(rec.calls[0]?.context.chainTotal).toBe(1);
    // Final done is re-stamped isFinal=true.
    const done = events.find((e) => e.type === 'done');
    expect(done?.isFinal).toBe(true);
  });

  test('"@claude @codex": codex prompt contains claude\'s reply (serial context)', async () => {
    const claudeReply = 'Implemented POST/GET/PUT/DELETE for /todos.';
    const rec = makeRecordingInvoke({ [CLAUDE as string]: claudeReply });
    await drain(routeSerial(serialParams([CLAUDE, CODEX], rec.invoke)));

    expect(rec.calls.map((c) => c.agentId)).toEqual([CLAUDE, CODEX]);
    // The hard evidence of serial context passing:
    expect(rec.calls[1]?.prompt).toContain(claudeReply);
    expect(rec.calls[0]?.context.chainTotal).toBe(2);
  });

  test('A2A: claude reply with line-start @gemini extends the worklist', async () => {
    const rec = makeRecordingInvoke({
      [CLAUDE as string]: 'Done with the API.\n@gemini please add a perf benchmark',
    });
    await drain(routeSerial(serialParams([CLAUDE], rec.invoke)));

    // Worklist grew from [claude] to [claude, gemini].
    expect(rec.calls.map((c) => c.agentId)).toEqual([CLAUDE, GEMINI]);
    // Gemini's turn records who handed off to it.
    expect(rec.calls[1]?.context.directMessageFrom).toBe(CLAUDE);
  });

  test('isFinal is true only on the last agent of the (expanded) chain', async () => {
    const rec = makeRecordingInvoke({
      [CLAUDE as string]: '@codex take the review',
    });
    const events = await drain(routeSerial(serialParams([CLAUDE], rec.invoke)));
    const dones = events.filter((e) => e.type === 'done');

    expect(dones).toHaveLength(2);
    expect(dones[0]?.isFinal).toBe(false);
    expect(dones[1]?.isFinal).toBe(true);
  });
});
