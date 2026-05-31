// M12 trace evaluator — post-hoc SOP rule evaluation entry point.
// Source: clowder-architecture-design.md §5.6 evaluateTrace + supplement §B3.

import type { AgentId, SopDefinition, SopPredicate, SopRule } from '@clowder/shared';
import { evaluateCommandPattern } from './predicates/command-pattern.js';
import { evaluateGitState } from './predicates/git-state.js';
import { evaluateHandleCheck } from './predicates/handle-check.js';
import { evaluateManualOnly } from './predicates/manual-only.js';
import type { PredicateEvalOutcome, SopTraceContext } from './predicates/predicate-types.js';

/** Design §5.6 SopTraceInput (commands/git/reviewer fields supplied via {@link SopTraceContext}). */
export interface SopTraceInput {
  agentId: AgentId;
  threadId: string;
  responseContent: string;
  context: SopTraceContext;
}

/** Design §5.6 SopEvalResult. */
export interface SopEvalResult {
  violations: Array<{ ruleId: string; text: string; severity: 'blocker' | 'warn' }>;
  passed: Array<{ ruleId: string }>;
  skipped: Array<{ ruleId: string; reason: string }>;
}

function evaluatePredicate(predicate: SopPredicate, trace: SopTraceContext): PredicateEvalOutcome {
  switch (predicate.type) {
    case 'manual_only':
      return evaluateManualOnly(predicate);
    case 'git_state_predicate':
      return evaluateGitState(predicate, trace);
    case 'command_pattern':
      return evaluateCommandPattern(predicate, trace);
    case 'handle_check':
      return evaluateHandleCheck(predicate, trace);
  }
}

function evaluateRule(rule: SopRule, trace: SopTraceContext): PredicateEvalOutcome {
  return evaluatePredicate(rule.predicate, trace);
}

function collectRules(definition: SopDefinition, stageId: string): SopRule[] {
  const stage = definition.stages.find((s) => s.id === stageId);
  if (stage === undefined) return [];
  return [...stage.hardRules, ...stage.pitfalls];
}

/** Evaluate all rules for a stage against a trace. Fail-open skips manual_only rules. */
export function evaluateTrace(stageId: string, trace: SopTraceInput, definition: SopDefinition): SopEvalResult {
  const rules = collectRules(definition, stageId);
  const violations: SopEvalResult['violations'] = [];
  const passed: SopEvalResult['passed'] = [];
  const skipped: SopEvalResult['skipped'] = [];

  for (const rule of rules) {
    const outcome = evaluateRule(rule, trace.context);
    if (outcome.status === 'violation') {
      violations.push({ ruleId: rule.id, text: rule.text, severity: rule.severity });
    } else if (outcome.status === 'pass') {
      passed.push({ ruleId: rule.id });
    } else {
      skipped.push({ ruleId: rule.id, reason: outcome.reason });
    }
  }

  return { violations, passed, skipped };
}
