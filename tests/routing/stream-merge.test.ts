// tests/routing/stream-merge.test.ts
// M4 DEV happy-path: mergeStreams interleaves multiple streams; one stream
// erroring does not kill the others.

import { describe, test, expect } from 'vitest';
import { mergeStreams } from '@clowder/api/routing/stream-merge';

/** Yield values with awaited microtask gaps so interleaving is observable. */
async function* labeled(label: string, count: number): AsyncGenerator<string> {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
    yield `${label}${i}`;
  }
}

async function* erroringAfterOne(label: string): AsyncGenerator<string> {
  await Promise.resolve();
  yield `${label}0`;
  throw new Error(`${label} stream blew up`);
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) {
    out.push(v);
  }
  return out;
}

describe('mergeStreams — happy path (unit)', () => {
  test('interleaves 3 streams and yields every value exactly once', async () => {
    const merged = mergeStreams<string>([
      labeled('a', 3),
      labeled('b', 3),
      labeled('c', 3),
    ]);
    const values = await collect(merged);

    expect(values).toHaveLength(9);
    expect([...values].sort()).toEqual([
      'a0', 'a1', 'a2', 'b0', 'b1', 'b2', 'c0', 'c1', 'c2',
    ]);
  });

  test('one stream erroring does not kill the others; onError is notified', async () => {
    const errors: Array<{ index: number; message: string }> = [];
    const merged = mergeStreams<string>(
      [labeled('a', 3), erroringAfterOne('b'), labeled('c', 3)],
      (index, error) => {
        errors.push({
          index,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    const values = await collect(merged);

    // Both healthy streams complete fully; the failing stream yielded once.
    expect(values.filter((v) => v.startsWith('a'))).toEqual(['a0', 'a1', 'a2']);
    expect(values.filter((v) => v.startsWith('c'))).toEqual(['c0', 'c1', 'c2']);
    expect(values).toContain('b0');
    expect(errors).toEqual([{ index: 1, message: 'b stream blew up' }]);
  });

  test('single stream is passed through unchanged', async () => {
    const values = await collect(mergeStreams<string>([labeled('solo', 2)]));
    expect(values).toEqual(['solo0', 'solo1']);
  });
});
