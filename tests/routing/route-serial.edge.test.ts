// tests/routing/route-serial.edge.test.ts
// M4 QA — independent edge + adversarial gate for serial routing, the A2A
// dynamic worklist, ping-pong control, depth limits, and abort handling.
// Deterministic: fixed clock, recording invoke seams, no wall-clock sleeps.

import { describe, test, expect } from 'vitest';
import {
  routeSerial,
  createWorklist,
  tryPushMentions,
  updateStreak,
  PINGPONG_WARN_THRESHOLD,
  PINGPONG_BLOCK_THRESHOLD,
} from '@choco/api/routing/route-serial';
import { makeRecordingInvoke, drain, CLAUDE, CODEX, GEMINI } from './helpers';
import { serialParams, captureLogger, makeAbortingInvoke } from './qa-helpers';

describe('routeSerial — edge', () => {
  test('(edge) 3-chain: gemini prompt carries BOTH claude and codex replies', async () => {
    const claudeReply = 'Added POST/GET/PUT/DELETE for /todos with validation.';
    const codexReply = 'Reviewed: the DELETE handler is missing an auth check.';
    const rec = makeRecordingInvoke({
      [CLAUDE as string]: claudeReply,
      [CODEX as string]: codexReply,
    });
    await drain(routeSerial(serialParams([CLAUDE, CODEX, GEMINI], rec.invoke)));

    expect(rec.calls.map((c) => c.agentId)).toEqual([CLAUDE, CODEX, GEMINI]);
    const geminiPrompt = rec.calls[2]?.prompt ?? '';
    expect(geminiPrompt).toContain(claudeReply);
    expect(geminiPrompt).toContain(codexReply);
  });

  test('(edge) A2A beyond maxA2ADepth is ignored (depth=1 stops the second hop)', async () => {
    const rec = makeRecordingInvoke({
      [CLAUDE as string]: '@codex please review the diff above',
      [CODEX as string]: '@gemini please add a perf benchmark',
    });
    await drain(routeSerial(serialParams([CLAUDE], rec.invoke, { maxA2ADepth: 1 })));

    // claude → codex accepted (depth 1); codex → gemini rejected by depth limit.
    expect(rec.calls.map((c) => c.agentId)).toEqual([CLAUDE, CODEX]);
  });

  test('(edge) A2A at exactly maxA2ADepth=2 admits two hops then stops', async () => {
    const rec = makeRecordingInvoke({
      [CLAUDE as string]: '@codex review please',
      [CODEX as string]: '@gemini benchmark please',
      [GEMINI as string]: '@claude one more pass please',
    });
    await drain(routeSerial(serialParams([CLAUDE], rec.invoke, { maxA2ADepth: 2 })));

    expect(rec.calls.map((c) => c.agentId)).toEqual([CLAUDE, CODEX, GEMINI]);
  });

  test('(edge) chainTotal grows as the worklist expands via A2A', async () => {
    const rec = makeRecordingInvoke({
      [CLAUDE as string]: '@codex take the review',
    });
    await drain(routeSerial(serialParams([CLAUDE], rec.invoke)));

    expect(rec.calls[0]?.context.chainTotal).toBe(1); // before expansion
    expect(rec.calls[1]?.context.chainTotal).toBe(2); // codex sees the grown chain
    expect(rec.calls[1]?.context.directMessageFrom).toBe(CLAUDE);
  });

  test('(edge) ping-pong warning is injected on the target turn at streak ≥ 2', async () => {
    const rec = makeRecordingInvoke({
      [CLAUDE as string]: '@codex your turn',
      [CODEX as string]: '@claude back to you',
    });
    await drain(routeSerial(serialParams([CLAUDE], rec.invoke, { maxA2ADepth: 10 })));

    // 2nd claude turn (index 2) runs after the streak reached 2.
    expect(rec.calls[2]?.context.pingPongWarning).toEqual({
      pairedWith: CODEX,
      count: 2,
    });
  });

  test('(edge) ping-pong block terminates the chain at streak ≥ 4 and logs it', async () => {
    const rec = makeRecordingInvoke({
      [CLAUDE as string]: '@codex your turn',
      [CODEX as string]: '@claude back to you',
    });
    const cap = captureLogger();
    await drain(
      routeSerial(
        serialParams([CLAUDE], rec.invoke, { maxA2ADepth: 10, logger: cap.logger }),
      ),
    );

    // claude, codex, claude, codex — the 5th (blocked) hand-off never runs.
    expect(rec.calls.map((c) => c.agentId)).toEqual([CLAUDE, CODEX, CLAUDE, CODEX]);
    expect(
      cap.events.some(
        (e) => e.level === 'warn' && e.message.includes('ping-pong terminated'),
      ),
    ).toBe(true);
  });

  test('(edge) a signal already aborted before start invokes no agents', async () => {
    const controller = new AbortController();
    controller.abort();
    const rec = makeRecordingInvoke({ [CLAUDE as string]: 'should not run' });
    const events = await drain(
      routeSerial(serialParams([CLAUDE, CODEX], rec.invoke, { signal: controller.signal })),
    );

    expect(rec.calls).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe('routeSerial — adversarial', () => {
  test('(adversarial) aborting during the first agent stops the chain before the second', async () => {
    const controller = new AbortController();
    const scripted = makeAbortingInvoke(
      { [CLAUDE as string]: 'done with my part', [CODEX as string]: 'never reached' },
      CLAUDE,
      controller,
    );
    await drain(
      routeSerial(
        serialParams([CLAUDE, CODEX], scripted.invoke, { signal: controller.signal }),
      ),
    );

    expect(scripted.calls.map((c) => c.agentId)).toEqual([CLAUDE]);
  });

  test('(adversarial) a reply mentioning 3 agents is capped to 2 (self filtered) on expansion', async () => {
    const rec = makeRecordingInvoke({
      [CLAUDE as string]: '@codex @gemini @claude all of you please look',
    });
    await drain(routeSerial(serialParams([CLAUDE], rec.invoke)));

    expect(rec.calls.map((c) => c.agentId)).toEqual([CLAUDE, CODEX, GEMINI]);
  });

  test('(adversarial) an A2A mention already pending is deduped, not re-enqueued', async () => {
    const rec = makeRecordingInvoke({
      [CLAUDE as string]: '@codex review the diff above',
    });
    await drain(routeSerial(serialParams([CLAUDE, CODEX], rec.invoke)));

    // codex was already queued by the user; claude's @codex must not duplicate it.
    expect(rec.calls.map((c) => c.agentId)).toEqual([CLAUDE, CODEX]);
  });

  test('(adversarial) tryPushMentions reports depth_limit and all_duplicate precisely', () => {
    const depthZero = createWorklist([CLAUDE], 0);
    expect(tryPushMentions(depthZero, CLAUDE, [CODEX])).toEqual({
      added: [],
      reason: 'depth_limit',
    });

    const dup = createWorklist([CLAUDE, CODEX]);
    expect(tryPushMentions(dup, CLAUDE, [CODEX])).toEqual({
      added: [],
      reason: 'all_duplicate',
    });

    const none = createWorklist([CLAUDE]);
    expect(tryPushMentions(none, CLAUDE, [])).toEqual({ added: [] });
  });

  test('(adversarial) updateStreak boundaries: warn at exactly 2, block at exactly 4, reset on a new pair', () => {
    expect(PINGPONG_WARN_THRESHOLD).toBe(2);
    expect(PINGPONG_BLOCK_THRESHOLD).toBe(4);
    const entry = createWorklist([CLAUDE]);

    const s1 = updateStreak(entry, CLAUDE, CODEX);
    expect(s1).toEqual({ warnPingPong: false, blockPingPong: false, count: 1 });

    const s2 = updateStreak(entry, CODEX, CLAUDE); // same unordered pair
    expect(s2).toEqual({ warnPingPong: true, blockPingPong: false, count: 2 });

    const s3 = updateStreak(entry, CLAUDE, CODEX);
    expect(s3.count).toBe(3);
    expect(s3.warnPingPong).toBe(true);
    expect(s3.blockPingPong).toBe(false);

    const s4 = updateStreak(entry, CODEX, CLAUDE);
    expect(s4).toEqual({ warnPingPong: false, blockPingPong: true, count: 4 });

    // A different pair resets the streak to 1.
    const reset = updateStreak(entry, CLAUDE, GEMINI);
    expect(reset.count).toBe(1);
  });
});
