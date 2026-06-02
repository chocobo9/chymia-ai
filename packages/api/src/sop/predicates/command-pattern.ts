// M12 command_pattern — require/forbid command regexes in the session trace.

import type { SopPredicate } from '@choco/shared';
import type { PredicateEvalOutcome, SopTraceContext } from './predicate-types.js';

function anyCommandMatches(commands: readonly string[], pattern: string): boolean {
  const alternatives = pattern.split('|').map((p) => p.trim()).filter((p) => p.length > 0);
  return commands.some((cmd) => alternatives.some((alt) => new RegExp(alt).test(cmd)));
}

export function evaluateCommandPattern(
  predicate: Extract<SopPredicate, { type: 'command_pattern' }>,
  trace: SopTraceContext,
): PredicateEvalOutcome {
  if (!anyCommandMatches(trace.commands, predicate.mustMatch)) {
    return {
      status: 'violation',
      message: `required command pattern "${predicate.mustMatch}" not found`,
    };
  }
  return { status: 'pass' };
}
