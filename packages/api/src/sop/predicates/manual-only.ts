// M12 manual_only predicate — always skipped (human/conversational checks).

import type { SopPredicate } from '@clowder/shared';
import type { PredicateEvalOutcome } from './predicate-types.js';

export function evaluateManualOnly(predicate: Extract<SopPredicate, { type: 'manual_only' }>): PredicateEvalOutcome {
  return { status: 'skipped', reason: predicate.reason };
}
