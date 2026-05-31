// M12 handle_check — reviewer/author identity constraints (e.g. no self-review).

import type { SopPredicate } from '@clowder/shared';
import type { PredicateEvalOutcome, SopTraceContext } from './predicate-types.js';

export function evaluateHandleCheck(
  predicate: Extract<SopPredicate, { type: 'handle_check' }>,
  trace: SopTraceContext,
): PredicateEvalOutcome {
  if (predicate.constraint === 'reviewer_not_author') {
    if (trace.authorId === undefined || trace.reviewerId === undefined) {
      return { status: 'skipped', reason: 'authorId/reviewerId not present in trace' };
    }
    if (trace.reviewerId === trace.authorId) {
      return { status: 'violation', message: 'reviewer must not be the same agent as author' };
    }
    return { status: 'pass' };
  }
  return { status: 'skipped', reason: `unknown handle_check constraint: ${predicate.constraint}` };
}
