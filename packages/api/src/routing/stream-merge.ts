// packages/api/src/routing/stream-merge.ts
// M4: mergeStreams — interleave several AsyncIterables, first-to-yield wins.
//
// Re-authored from clowder-architecture-design.md §6.1 (parallel path:
// "mergeStreams (Promise.race 池)"). One stream erroring must NOT kill the
// others — the failing stream is removed from the pool and reported via onError.
//
// Algorithm (Promise.race pool):
//   1. Take each iterable's AsyncIterator.
//   2. Arm every iterator: call .next() and tag the resulting promise by index.
//   3. race the pool; yield the winner's value, then re-arm only that iterator.
//   4. A done iterator is dropped from the pool.
//   5. A rejected iterator is dropped and surfaced via onError (others survive).
//   6. Pool empty → generator ends.

/** Tagged success so we know which stream produced the value. */
interface TaggedResult<T> {
  readonly index: number;
  readonly result: IteratorResult<T>;
}

/** Tagged failure so we know which stream rejected. */
interface TaggedError {
  readonly index: number;
  readonly error: unknown;
}

/** Discriminated outcome of a single iterator step. */
type TaggedOutcome<T> =
  | { readonly ok: true; readonly value: TaggedResult<T> }
  | { readonly ok: false; readonly value: TaggedError };

/**
 * Merge multiple async iterables, yielding values in arrival order.
 *
 * @param streams iterables to merge.
 * @param onError optional callback invoked when a stream rejects; that stream is
 *   removed from the pool and the rest keep flowing (one stream's failure never
 *   tears down the others).
 */
export async function* mergeStreams<T>(
  streams: readonly AsyncIterable<T>[],
  onError?: (index: number, error: unknown) => void,
): AsyncGenerator<T> {
  if (streams.length === 0) {
    return;
  }
  if (streams.length === 1) {
    yield* streams[0]!;
    return;
  }

  const iterators = streams.map((s) => s[Symbol.asyncIterator]());
  // Pattern from Clowder stream-merge.ts: a per-index map of in-flight .next()
  // promises; race their values and re-arm the winner.
  const pending = new Map<number, Promise<TaggedOutcome<T>>>();

  const arm = (index: number): void => {
    const it = iterators[index];
    if (it === undefined) {
      return;
    }
    pending.set(
      index,
      it.next().then(
        (result): TaggedOutcome<T> => ({ ok: true, value: { index, result } }),
        (error): TaggedOutcome<T> => ({ ok: false, value: { index, error } }),
      ),
    );
  };

  for (let i = 0; i < iterators.length; i += 1) {
    arm(i);
  }

  while (pending.size > 0) {
    const outcome = await Promise.race(pending.values());

    if (outcome.ok) {
      const { index, result } = outcome.value;
      if (result.done === true) {
        pending.delete(index);
      } else {
        yield result.value;
        arm(index);
      }
    } else {
      const { index, error } = outcome.value;
      pending.delete(index);
      onError?.(index, error);
    }
  }
}
