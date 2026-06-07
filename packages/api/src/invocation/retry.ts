// packages/api/src/invocation/retry.ts
// M3: pure retry policy for a single agent invocation.
//
// Re-authored from clowder-design-supplement.md §A9 + clowder-architecture-design.md
// §6.2 (retry step). Consumes the FROZEN M2 error classifiers; does NOT
// reimplement them. Kept as pure functions separate from the driver so the
// policy is deterministically unit-testable without spawning a CLI.
//
// Policy (§A9):
//   classification priority: timeout > missing session > prompt limit > context overflow > transient
//   missing session  → clear session, retry WITHOUT sessionId
//   prompt limit     → clear session, retry WITHOUT sessionId
//   context overflow → clear session, retry WITHOUT sessionId
//   timeout          → clear session, retry WITHOUT sessionId
//   transient        → retry AS-IS (keep sessionId)
//   unclassified    → do NOT retry (yield the error)
//   output already produced → do NOT retry (avoid duplicate output)
//   max retries = 2

import {
  isMissingSessionError,
  isPromptLimitError,
  isContextWindowOverflowError,
  isTransientCliError,
  isTimeoutError,
  isMalformedToolCallError,
} from '@choco/api/providers/error-classifier';

/**
 * Maximum number of retries after the initial attempt.
 * Source: clowder-architecture-design.md §6.2 ("最多 2 次") and §A9 ("max retries = 2").
 */
export const MAX_RETRIES = 2;

/**
 * The error class a failure was sorted into, in §A9 priority order.
 * `unclassified` = matched none of the four classifiers.
 */
export type ErrorClass =
  | 'malformed'
  | 'timeout'
  | 'missing_session'
  | 'prompt_limit'
  | 'context_overflow'
  | 'transient'
  | 'unclassified';

/**
 * What the driver should do next, given a classified failure and current state.
 * - `retry`: re-invoke; `clearSession` says whether to drop the persisted
 *   session first (and thus invoke without a sessionId).
 * - `stop`: surface the error; `reason` explains why no retry happens.
 */
export type RetryDecision =
  | { readonly action: 'retry'; readonly clearSession: boolean; readonly errorClass: ErrorClass }
  | {
      readonly action: 'stop';
      readonly reason: 'unclassified' | 'output_produced' | 'max_retries_exhausted';
      readonly errorClass: ErrorClass;
    };

/**
 * Classify an error message into one of the §A9 buckets.
 *
 * Priority is significant and matches §A9: timeout > missing session >
 * prompt limit > transient. Several real CLI errors satisfy more than one
 * classifier (e.g. "deadline exceeded" is both timeout-like and transient-like);
 * the more aggressive recovery (clear session) wins by being checked first.
 *
 * Pure + null/undefined-safe (delegates to the M2 classifiers, which tolerate
 * empty input).
 */
export function classifyError(message: string | null | undefined): ErrorClass {
  // F215 AC-C1: form A malformed tool-call (claude thinking-only 炸毛) is an explicit
  // marker error — classify it first, then clear the session and fresh-context retry
  // (same recovery as overflow, but kept distinct so the route layer can relay on
  // exhaustion).
  if (isMalformedToolCallError(message)) {
    return 'malformed';
  }
  // Pattern from invoke-single-cat.ts: timeout & missing-session both clear the
  // session; here they stay distinct error classes but share clearSession=true.
  if (isTimeoutError(message)) {
    return 'timeout';
  }
  if (isMissingSessionError(message)) {
    return 'missing_session';
  }
  if (isPromptLimitError(message)) {
    return 'prompt_limit';
  }
  // 上下文窗口溢出（多轮累积撑满）：与 prompt_limit 同样清 session 重试，但分开分类
  // 便于诊断。对齐 Clowder invoke-single-cat（context overflow → 清 session 重试）。
  if (isContextWindowOverflowError(message)) {
    return 'context_overflow';
  }
  if (isTransientCliError(message)) {
    return 'transient';
  }
  return 'unclassified';
}

/** Inputs the retry policy needs to decide the next step. */
export interface RetryInput {
  /** The error text from the failed attempt (CLI stderr / result.error). */
  readonly errorMessage: string | null | undefined;
  /** How many retries have already been consumed (0 on the first failure). */
  readonly attempt: number;
  /**
   * Whether the failed attempt already streamed user-visible output
   * (text / tool_use / tool_result). If so we must not retry — re-invoking
   * would duplicate that output.
   */
  readonly producedOutput: boolean;
  /** Override max retries (defaults to {@link MAX_RETRIES}); for tests/config. */
  readonly maxRetries?: number;
}

/**
 * Decide whether and how to retry a failed invocation attempt.
 *
 * Order of checks (each gate is a hard stop per §A9):
 *   1. output already produced → stop (no duplicate output)
 *   2. classify the error
 *   3. unclassified → stop
 *   4. retries exhausted → stop
 *   5. otherwise retry; clearSession for timeout / missing_session / prompt_limit,
 *      retry as-is for transient.
 *
 * Pure function — no I/O, no clock, no mutation of inputs.
 */
export function decideRetry(input: RetryInput): RetryDecision {
  const errorClass = classifyError(input.errorMessage);
  const maxRetries = input.maxRetries ?? MAX_RETRIES;

  // Output already streamed → never retry (avoid duplicate output). Checked
  // before classification because it overrides every error class.
  if (input.producedOutput) {
    return { action: 'stop', reason: 'output_produced', errorClass };
  }

  // Unclassified errors are not retried — surface them directly.
  if (errorClass === 'unclassified') {
    return { action: 'stop', reason: 'unclassified', errorClass };
  }

  // Out of retry budget.
  if (input.attempt >= maxRetries) {
    return { action: 'stop', reason: 'max_retries_exhausted', errorClass };
  }

  // transient → retry keeping the session; the rest → clear the session first.
  const clearSession = errorClass !== 'transient';
  return { action: 'retry', clearSession, errorClass };
}
