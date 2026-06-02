// tests/invocation/retry.test.ts
// M3 dev happy-path tests for the pure retry policy (§A9 / §6.2).
// One representative real CLI error per class; pure functions, no I/O.

import { describe, test, expect } from 'vitest';
import { classifyError, decideRetry, MAX_RETRIES } from '@choco/api/invocation/retry';

describe('classifyError — one representative per class (unit)', () => {
  test('missing session error → missing_session', () => {
    expect(classifyError('No conversation found with session id abc-123')).toBe('missing_session');
  });

  test('prompt limit error → prompt_limit', () => {
    expect(classifyError('prompt is too long: 250000 tokens')).toBe('prompt_limit');
  });

  test('transient error → transient', () => {
    expect(classifyError('overloaded_error: service temporarily unavailable')).toBe('transient');
  });

  test('timeout error → timeout (wins priority over transient)', () => {
    expect(classifyError('context deadline exceeded')).toBe('timeout');
  });

  test('unrecognized error → unclassified', () => {
    expect(classifyError('SyntaxError: unexpected token at position 4')).toBe('unclassified');
  });
});

describe('decideRetry — strategy per class (unit)', () => {
  test('missing session → retry with clearSession=true', () => {
    const decision = decideRetry({
      errorMessage: 'session not found: rollout missing',
      attempt: 0,
      producedOutput: false,
    });
    expect(decision).toEqual({ action: 'retry', clearSession: true, errorClass: 'missing_session' });
  });

  test('prompt limit → retry with clearSession=true', () => {
    const decision = decideRetry({
      errorMessage: 'context length exceeded',
      attempt: 0,
      producedOutput: false,
    });
    expect(decision).toEqual({ action: 'retry', clearSession: true, errorClass: 'prompt_limit' });
  });

  test('timeout → retry with clearSession=true', () => {
    const decision = decideRetry({
      errorMessage: 'request timed out',
      attempt: 0,
      producedOutput: false,
    });
    expect(decision).toEqual({ action: 'retry', clearSession: true, errorClass: 'timeout' });
  });

  test('transient → retry as-is (clearSession=false)', () => {
    const decision = decideRetry({
      errorMessage: 'ECONNRESET: connection reset by peer',
      attempt: 0,
      producedOutput: false,
    });
    expect(decision).toEqual({ action: 'retry', clearSession: false, errorClass: 'transient' });
  });

  test('output already produced → stop (no duplicate output), even for a retryable class', () => {
    const decision = decideRetry({
      errorMessage: 'overloaded_error',
      attempt: 0,
      producedOutput: true,
    });
    expect(decision).toEqual({ action: 'stop', reason: 'output_produced', errorClass: 'transient' });
  });

  test('unclassified error → stop', () => {
    const decision = decideRetry({
      errorMessage: 'TypeError: cannot read property foo of undefined',
      attempt: 0,
      producedOutput: false,
    });
    expect(decision).toEqual({ action: 'stop', reason: 'unclassified', errorClass: 'unclassified' });
  });

  test('retries exhausted at MAX_RETRIES → stop', () => {
    const decision = decideRetry({
      errorMessage: 'service unavailable',
      attempt: MAX_RETRIES,
      producedOutput: false,
    });
    expect(decision).toEqual({
      action: 'stop',
      reason: 'max_retries_exhausted',
      errorClass: 'transient',
    });
  });
});
