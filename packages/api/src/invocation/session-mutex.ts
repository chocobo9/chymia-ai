// packages/api/src/invocation/session-mutex.ts
// M3: SessionMutex — serialize concurrent invocations on the same key.
//
// Re-authored from clowder-design-supplement.md §A4 (ISessionMutex). Pure
// in-memory: a per-key promise chain. Each acquire appends to the tail; the
// returned release resolves the current node so the next waiter proceeds.
// Optional abort signal and timeout let a waiter bail out of the queue without
// deadlocking the holders behind it.

/**
 * Default upper bound on how long a single `acquire` will wait in the queue
 * before rejecting, when the caller does not pass an explicit `timeoutMs`.
 *
 * 2 hours — matches the InvocationRecord TTL (clowder-architecture-design.md
 * §4.6: "TTL 2 小时"): a waiter should never sit queued longer than the
 * invocation it belongs to could possibly stay live.
 */
const DEFAULT_ACQUIRE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Options for a single {@link SessionMutex.acquire} call. */
export interface AcquireOptions {
  /** Abort the wait: if the signal fires (or is already aborted), acquire rejects. */
  readonly signal?: AbortSignal;
  /** Reject the wait after this many ms (anti-deadlock). Defaults to {@link DEFAULT_ACQUIRE_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** Reason tag carried on the Error thrown when an acquire wait is interrupted. */
export type AcquireFailureReason = 'aborted' | 'timeout';

/**
 * Error thrown when an `acquire` wait is interrupted by abort or timeout.
 * Carries a discriminating `reason` so callers can distinguish the two.
 */
export class SessionMutexAcquireError extends Error {
  readonly reason: AcquireFailureReason;

  constructor(reason: AcquireFailureReason) {
    super(`SessionMutex acquire ${reason}`);
    this.name = 'SessionMutexAcquireError';
    this.reason = reason;
  }
}

/** Function returned by acquire that releases the lock for the next waiter. */
export type ReleaseFn = () => void;

/**
 * SessionMutex — per-key serialization via a promise chain.
 * Implements clowder-design-supplement.md §A4 ISessionMutex.
 *
 * Each `acquire(key)` appends a fresh "holder" promise to that key's chain and
 * waits for all prior holders. The returned release resolves the holder so the
 * next waiter proceeds. Abort/timeout race the wait; the loser cleans up its own
 * chain node so it never deadlocks the queue behind it.
 */
export class SessionMutex {
  // Pattern from SessionMutex.ts: per-key promise chain; the stored value is the
  // tail of the chain (resolves when the current holder releases).
  private readonly chains = new Map<string, Promise<void>>();

  /**
   * Acquire the lock for `key`. Resolves with a release function once all prior
   * holders of `key` have released. Rejects with {@link SessionMutexAcquireError}
   * if `opts.signal` aborts or `opts.timeoutMs` elapses while still waiting.
   *
   * Same-key acquires run strictly in call order (FIFO): the chain is extended
   * synchronously before awaiting, so a later acquire always queues behind an
   * earlier one issued in the same tick.
   */
  async acquire(key: string, opts?: AcquireOptions): Promise<ReleaseFn> {
    const prior = this.chains.get(key) ?? Promise.resolve();

    // Build this holder's node. `current` resolves when the caller releases.
    let releaseHolder!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    // Extend the chain synchronously so ordering is fixed at call time.
    const newTail = prior.then(() => current);
    this.chains.set(key, newTail);

    // When this holder's node settles (whether released normally or after the
    // waiter bailed), drop the key from the map iff we are still the tail — keeps
    // the map from growing without bound across many one-shot keys.
    void newTail.finally(() => {
      if (this.chains.get(key) === newTail) {
        this.chains.delete(key);
      }
    });

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
    const signal = opts?.signal;

    // Fast-path: already aborted → never join the wait.
    if (signal?.aborted === true) {
      releaseHolder();
      throw new SessionMutexAcquireError('aborted');
    }

    // Race prior-holders against abort/timeout. Loser path resolves `current` so
    // the next waiter is not blocked behind an abandoned node.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const losers: Promise<never>[] = [];

    losers.push(
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SessionMutexAcquireError('timeout')),
          timeoutMs,
        );
      }),
    );

    if (signal !== undefined) {
      losers.push(
        new Promise<never>((_, reject) => {
          onAbort = (): void => reject(new SessionMutexAcquireError('aborted'));
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      );
    }

    try {
      await Promise.race([prior, ...losers]);
    } catch (err) {
      // Lost the race: release our chain node so we don't deadlock followers.
      releaseHolder();
      throw err;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (signal !== undefined && onAbort !== undefined) {
        signal.removeEventListener('abort', onAbort);
      }
    }

    return releaseHolder;
  }
}
