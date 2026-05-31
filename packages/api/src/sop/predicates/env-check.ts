// M12 env_check helper — evaluates environment variable constraints.
// Not part of the frozen M1 SopPredicate union; used standalone and by tests.

import type { PredicateEvalOutcome } from './predicate-types.js';

export interface EnvCheckSpec {
  key: string;
  mustInclude?: string;
  mustNotInclude?: string;
}

export function evaluateEnvCheck(
  env: Readonly<Record<string, string | undefined>>,
  spec: EnvCheckSpec,
): PredicateEvalOutcome {
  const value = env[spec.key];
  if (value === undefined || value.length === 0) {
    return { status: 'violation', message: `env ${spec.key} is unset` };
  }
  if (spec.mustInclude !== undefined && !value.includes(spec.mustInclude)) {
    return {
      status: 'violation',
      message: `env ${spec.key} must include ${JSON.stringify(spec.mustInclude)}`,
    };
  }
  if (spec.mustNotInclude !== undefined && value.includes(spec.mustNotInclude)) {
    return {
      status: 'violation',
      message: `env ${spec.key} must not include ${JSON.stringify(spec.mustNotInclude)}`,
    };
  }
  return { status: 'pass' };
}
