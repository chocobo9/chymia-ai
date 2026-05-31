// tests/routing/stream-merge.edge.test.ts
// M4 QA — independent edge + adversarial gate for mergeStreams.
// Targets the Promise.race pool: empty/single pools, per-stream ordering, and
// the crucial "one stream's rejection must not tear down the others" property,
// including a stream that rejects BEFORE its first yield and multiple failures.

import { describe, test, expect } from 'vitest';
import { mergeStreams } from '@clowder/api/routing/stream-merge';

async function* labeled(label: string, count: number): AsyncGenerator<string> {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
    yield `${label}${i}`;
  }
}

async function* empty(): AsyncGenerator<string> {
  // yields nothing
}

// eslint-disable-next-line require-yield -- intentionally rejects before its first yield (tests fault isolation)
async function* throwsBeforeYield(message: string): AsyncGenerator<string> {
  await Promise.resolve();
  throw new Error(message);
}

async function* throwsAfterOne(label: string): AsyncGenerator<string> {
  await Promise.resolve();
  yield `${label}0`;
  throw new Error(`${label} blew up`);
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) {
    out.push(v);
  }
  return out;
}

describe('mergeStreams — edge', () => {
  test('(edge) empty pool yields nothing and completes', async () => {
    expect(await collect(mergeStreams<string>([]))).toEqual([]);
  });

  test('(edge) an empty stream alongside healthy ones is simply drained out', async () => {
    const values = await collect(
      mergeStreams<string>([labeled('a', 2), empty(), labeled('c', 2)]),
    );
    expect([...values].sort()).toEqual(['a0', 'a1', 'c0', 'c1']);
  });

  test('(edge) all-empty pool yields nothing', async () => {
    expect(await collect(mergeStreams<string>([empty(), empty()]))).toEqual([]);
  });

  test('(edge) values from a single stream keep their relative order', async () => {
    const values = await collect(
      mergeStreams<string>([labeled('a', 4), labeled('b', 4)]),
    );
    expect(values.filter((v) => v.startsWith('a'))).toEqual(['a0', 'a1', 'a2', 'a3']);
    expect(values.filter((v) => v.startsWith('b'))).toEqual(['b0', 'b1', 'b2', 'b3']);
  });
});

describe('mergeStreams — adversarial', () => {
  test('(adversarial) a stream that rejects before its first yield is dropped; others fully drain', async () => {
    const errors: number[] = [];
    const values = await collect(
      mergeStreams<string>(
        [labeled('a', 3), throwsBeforeYield('cold failure'), labeled('c', 3)],
        (index) => errors.push(index),
      ),
    );
    expect(values.filter((v) => v.startsWith('a'))).toEqual(['a0', 'a1', 'a2']);
    expect(values.filter((v) => v.startsWith('c'))).toEqual(['c0', 'c1', 'c2']);
    expect(errors).toEqual([1]);
  });

  test('(adversarial) two failing streams are both reported; the healthy one survives', async () => {
    const errors: Array<{ index: number; message: string }> = [];
    const values = await collect(
      mergeStreams<string>(
        [throwsAfterOne('a'), labeled('b', 3), throwsAfterOne('c')],
        (index, error) =>
          errors.push({
            index,
            message: error instanceof Error ? error.message : String(error),
          }),
      ),
    );
    expect(values.filter((v) => v.startsWith('b'))).toEqual(['b0', 'b1', 'b2']);
    expect(values).toContain('a0');
    expect(values).toContain('c0');
    expect(errors.map((e) => e.index).sort()).toEqual([0, 2]);
  });

  test('(adversarial) a failing stream with the other healthy stream still completes', async () => {
    const errors: number[] = [];
    const values = await collect(
      mergeStreams<string>([throwsAfterOne('x'), labeled('y', 3)], (index) =>
        errors.push(index),
      ),
    );
    expect(values.filter((v) => v.startsWith('y'))).toEqual(['y0', 'y1', 'y2']);
    expect(values).toContain('x0');
    expect(errors).toEqual([0]);
  });

  test('(adversarial) omitting onError does not throw when a stream rejects', async () => {
    const values = await collect(
      mergeStreams<string>([throwsAfterOne('a'), labeled('b', 2)]),
    );
    expect(values.filter((v) => v.startsWith('b'))).toEqual(['b0', 'b1']);
    expect(values).toContain('a0');
  });
});
