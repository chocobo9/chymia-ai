// tests/invocation/session-mutex.edge.test.ts
// M3 QA (independent) — edge + adversarial coverage for SessionMutex.
//
// Author: QA subagent (did NOT write the SessionMutex product code nor the dev
// happy-path tests). Per CLAUDE.md §0.5.3 these gating tests are written by an
// agent that did not implement the module.
//
// All tests are DETERMINISTIC: an injected fake clock drives timeout behavior
// (no real wall-clock timers / sleeps), and observable interleaving is asserted
// via a shared mutation log. Real (agentId:threadId) style keys are used, never
// placeholder tokens like "foo".

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  SessionMutex,
  SessionMutexAcquireError,
} from '@clowder/api/invocation/session-mutex';

// Real per-invocation mutex keys mirror invoke-single-agent's sessionKey():
// `${agentId}:${threadId}`.
const KEY_CLAUDE_REVIEW = 'claude-opus:thread-review-pipeline';
const KEY_CODEX_REVIEW = 'codex:thread-review-pipeline';

/** Let all currently-queued microtasks (promise continuations) drain. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('SessionMutex — edge: strict same-key ordering', () => {
  it('runs three same-key acquires strictly in call order (observable interleave log)', async () => {
    // Edge: more than two waiters must drain in FIFO order, each fully inside its
    // own critical section, never interleaving with the next holder's body.
    const mutex = new SessionMutex();
    const log: string[] = [];

    const r1 = await mutex.acquire(KEY_CLAUDE_REVIEW);

    const p2 = mutex.acquire(KEY_CLAUDE_REVIEW).then(async (rel) => {
      log.push('enter-2');
      await flushMicrotasks();
      log.push('exit-2');
      rel();
    });
    const p3 = mutex.acquire(KEY_CLAUDE_REVIEW).then(async (rel) => {
      log.push('enter-3');
      await flushMicrotasks();
      log.push('exit-3');
      rel();
    });

    log.push('enter-1');
    await flushMicrotasks();
    log.push('exit-1');
    r1();

    await Promise.all([p2, p3]);

    // Each critical section is atomic w.r.t. the others, and order is FIFO.
    expect(log).toEqual([
      'enter-1',
      'exit-1',
      'enter-2',
      'exit-2',
      'enter-3',
      'exit-3',
    ]);
  });

  it('serializes acquires issued across separate ticks (await between each)', async () => {
    // Edge: chain extension is synchronous at call time, so even acquires issued
    // in different ticks queue behind the still-held lock.
    const mutex = new SessionMutex();
    const order: string[] = [];

    const first = await mutex.acquire(KEY_CLAUDE_REVIEW);
    order.push('hold-first');

    let secondGranted = false;
    const second = mutex.acquire(KEY_CLAUDE_REVIEW).then((rel) => {
      secondGranted = true;
      order.push('grant-second');
      rel();
    });

    // Give the queued acquire every chance to (wrongly) resolve while held.
    await flushMicrotasks();
    expect(secondGranted).toBe(false);

    first();
    await second;
    expect(order).toEqual(['hold-first', 'grant-second']);
  });
});

describe('SessionMutex — edge: different keys do not block each other', () => {
  it('grants two different keys concurrently while one is still held', async () => {
    // Edge: per-key isolation — holding claude's key must not delay codex's key.
    const mutex = new SessionMutex();

    const claudeHold = await mutex.acquire(KEY_CLAUDE_REVIEW);

    // A different key must resolve without waiting for claudeHold to release.
    const codexRelease = await mutex.acquire(KEY_CODEX_REVIEW);
    expect(typeof codexRelease).toBe('function');

    codexRelease();
    claudeHold();
  });

  it('a busy key never starves an unrelated free key', async () => {
    // Edge: queueing many waiters on one key leaves another key instantly grantable.
    const mutex = new SessionMutex();
    const busyHold = await mutex.acquire(KEY_CLAUDE_REVIEW);

    const queued = [
      mutex.acquire(KEY_CLAUDE_REVIEW),
      mutex.acquire(KEY_CLAUDE_REVIEW),
    ];

    // Unrelated key resolves immediately despite the backlog on the busy key.
    const otherRelease = await mutex.acquire(KEY_CODEX_REVIEW);
    expect(typeof otherRelease).toBe('function');
    otherRelease();

    busyHold();
    for (const p of queued) {
      (await p)();
    }
  });
});

describe('SessionMutex — adversarial: abort mid-wait', () => {
  it('adversarial: rejects an aborted waiter AND still drains the chain for the next acquirer', async () => {
    // Adversarial: a waiter cancels mid-queue. Its acquire must reject, and the
    // abandoned chain node must NOT deadlock the acquirer queued behind it.
    const mutex = new SessionMutex();
    const log: string[] = [];

    const holder = await mutex.acquire(KEY_CLAUDE_REVIEW);

    const controller = new AbortController();
    const abortedWaiter = mutex.acquire(KEY_CLAUDE_REVIEW, {
      signal: controller.signal,
    });

    // A third acquirer queued AFTER the soon-to-abort waiter.
    const survivor = mutex.acquire(KEY_CLAUDE_REVIEW).then((rel) => {
      log.push('survivor-granted');
      rel();
    });

    await expect(
      (async (): Promise<void> => {
        controller.abort();
        await abortedWaiter;
      })(),
    ).rejects.toBeInstanceOf(SessionMutexAcquireError);

    // The holder releases; the chain must flow past the abandoned (aborted) node.
    holder();
    await survivor;
    expect(log).toEqual(['survivor-granted']);
  });

  it('adversarial: rejects immediately when the signal is already aborted before acquire', async () => {
    // Adversarial: pre-aborted signal must short-circuit, never join the queue,
    // and must not leave a dangling node that blocks a later acquirer.
    const mutex = new SessionMutex();
    const controller = new AbortController();
    controller.abort();

    let caught: unknown;
    try {
      await mutex.acquire(KEY_CLAUDE_REVIEW, { signal: controller.signal });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SessionMutexAcquireError);
    if (caught instanceof SessionMutexAcquireError) {
      expect(caught.reason).toBe('aborted');
    }

    // The key must still be acquirable afterwards (no leaked/locked node).
    const release = await mutex.acquire(KEY_CLAUDE_REVIEW);
    expect(typeof release).toBe('function');
    release();
  });
});

describe('SessionMutex — adversarial: timeout via injected clock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adversarial: rejects a waiter after timeoutMs elapses, then lets the next acquirer proceed', async () => {
    // Adversarial: a waiter sits behind a never-releasing-in-time holder and hits
    // its timeout. Clock is advanced deterministically (fake timers), never slept.
    const mutex = new SessionMutex();
    const TIMEOUT_MS = 1_500;

    const holder = await mutex.acquire(KEY_CLAUDE_REVIEW);

    const timedOut = mutex.acquire(KEY_CLAUDE_REVIEW, { timeoutMs: TIMEOUT_MS });
    const assertion = expect(timedOut).rejects.toMatchObject({
      reason: 'timeout',
    });

    // Advance the injected clock past the timeout to fire the rejection.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
    await assertion;

    // After the timed-out node is abandoned, the holder's release must reach the
    // next acquirer (no deadlock from the dropped node).
    let nextGranted = false;
    const next = mutex.acquire(KEY_CLAUDE_REVIEW).then((rel) => {
      nextGranted = true;
      rel();
    });
    holder();
    await next;
    expect(nextGranted).toBe(true);
  });

  it('does not reject a fast holder before its own timeout window', async () => {
    // Edge: a waiter whose predecessor releases before the timeout must succeed,
    // not spuriously time out.
    const mutex = new SessionMutex();
    const holder = await mutex.acquire(KEY_CLAUDE_REVIEW);

    let granted = false;
    const waiter = mutex.acquire(KEY_CLAUDE_REVIEW, { timeoutMs: 10_000 }).then(
      (rel) => {
        granted = true;
        rel();
      },
    );

    // Release well before the timeout, advancing only a small slice of time.
    holder();
    await vi.advanceTimersByTimeAsync(5);
    await waiter;
    expect(granted).toBe(true);
  });
});
