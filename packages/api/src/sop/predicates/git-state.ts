// M12 git_state_predicate — ahead/behind checks before worktree commands.

import type { SopPredicate } from '@choco/shared';
import type { PredicateEvalOutcome, SopTraceContext } from './predicate-types.js';

export function evaluateGitState(
  predicate: Extract<SopPredicate, { type: 'git_state_predicate' }>,
  trace: SopTraceContext,
): PredicateEvalOutcome {
  const ahead = trace.gitAhead ?? 0;
  const behind = trace.gitBehind ?? 0;

  for (const check of predicate.checks) {
    if (check === 'ahead_zero' && ahead !== 0) {
      return { status: 'violation', message: `git ahead=${ahead}, expected 0` };
    }
    if (check === 'behind_zero' && behind !== 0) {
      return { status: 'violation', message: `git behind=${behind}, expected 0` };
    }
  }
  return { status: 'pass' };
}
