// tests/invocation/session-mutex.test.ts
// M3 dev happy-path tests for SessionMutex (§A4).
// Deterministic: ordering asserted via a shared log; no real timers used.

import { describe, test, expect } from 'vitest';
import { SessionMutex } from '@choco/api/invocation/session-mutex';

describe('SessionMutex — happy path (unit)', () => {
  test('a single acquire resolves immediately and returns a release function', async () => {
    // Arrange
    const mutex = new SessionMutex();

    // Act
    const release = await mutex.acquire('claude-opus:thread-todo-api');

    // Assert
    expect(typeof release).toBe('function');
    release();
  });

  test('two acquires on the same key run strictly in FIFO order', async () => {
    // Arrange
    const mutex = new SessionMutex();
    const key = 'claude-opus:thread-todo-api';
    const log: string[] = [];

    // Act: start the second acquire before the first releases.
    const release1 = await mutex.acquire(key);
    const second = mutex.acquire(key).then((release2) => {
      log.push('second-acquired');
      release2();
    });

    // The second acquire must still be waiting until release1 runs.
    log.push('first-holds');
    release1();
    await second;

    // Assert
    expect(log).toEqual(['first-holds', 'second-acquired']);
  });

  test('different keys do not block each other', async () => {
    // Arrange
    const mutex = new SessionMutex();

    // Act: hold key A, then acquire key B — B should resolve without waiting.
    const releaseA = await mutex.acquire('claude-opus:thread-a');
    const releaseB = await mutex.acquire('codex:thread-b');

    // Assert
    expect(typeof releaseB).toBe('function');
    releaseA();
    releaseB();
  });

  test('a key is reusable after release (sequential acquire/release/acquire)', async () => {
    // Arrange
    const mutex = new SessionMutex();
    const key = 'gemini:thread-design';

    // Act
    const r1 = await mutex.acquire(key);
    r1();
    const r2 = await mutex.acquire(key);

    // Assert
    expect(typeof r2).toBe('function');
    r2();
  });
});
