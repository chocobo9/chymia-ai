// M8 ThreadSequencer — guarantee in-order broadcast within a single thread.
//
// Source: clowder-design-supplement.md §C2 (549–550): "ThreadSequencer — 保证
// 同一 thread 内消息按序广播".
//
// WHY: a thread's events come from an async stream; if we awaited the emit work
// without serialization, two near-simultaneous enqueues could interleave and
// reach clients out of order. The sequencer chains per-thread tasks on a promise
// so task N+1 for a thread starts only after task N settles. Different threads
// run independently (no cross-thread head-of-line blocking). Pure in-memory.

/** A unit of broadcast work; resolves when the emit completes. */
export type SequencedTask = () => void | Promise<void>;

/**
 * ThreadSequencer — per-thread FIFO task chain.
 *
 * `enqueue(threadId, task)` runs `task` after all previously enqueued tasks for
 * the same thread have settled, preserving order. A task that throws does not
 * break the chain — the next task still runs (fault isolation), and enqueue's
 * returned promise rejects so the caller can observe the failure if it cares.
 */
export class ThreadSequencer {
  // Pattern from Clowder ThreadSequencer: per-thread promise tail; each enqueue
  // appends to the tail and becomes the new tail.
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Enqueue `task` for `threadId`. Returns a promise that settles when this
   * task settles. Ordering within a thread is strictly FIFO by call order.
   */
  enqueue(threadId: string, task: SequencedTask): Promise<void> {
    const prior = this.tails.get(threadId) ?? Promise.resolve();

    // Run after the prior task settles (success OR failure) so one bad task does
    // not stall the chain. Capture this task's own outcome to return to caller.
    const run = prior.then(
      () => task(),
      () => task(),
    );

    // The tail must never reject (a rejected tail would make the NEXT enqueue's
    // `prior.then(onFulfilled)` skip), so we swallow on the tail only.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(threadId, tail);

    // Drop the entry once it is the settled tail, to bound memory across threads.
    void tail.finally(() => {
      if (this.tails.get(threadId) === tail) {
        this.tails.delete(threadId);
      }
    });

    return run;
  }

  /** Await all currently-queued work for a thread to drain (test/shutdown aid). */
  async drain(threadId: string): Promise<void> {
    await (this.tails.get(threadId) ?? Promise.resolve());
  }
}
