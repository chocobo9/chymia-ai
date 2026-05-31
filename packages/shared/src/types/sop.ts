// SOP (Standard Operating Procedure) model: stages, rules, predicates.
// Source: clowder-architecture-design.md §4.8 (SOP).

/**
 * SopRuleSeverity — SOP 规则严重级别。
 * Source: §4.8 (SopRule.severity)。
 */
export type SopRuleSeverity = 'blocker' | 'warn';

/**
 * SopPredicate — SOP 规则的评估谓词（discriminated union, 按 `type` 判别）。
 * Source: §4.8.
 */
export type SopPredicate =
  | { type: 'manual_only'; reason: string }
  | { type: 'git_state_predicate'; checks: string[] }
  | { type: 'command_pattern'; mustMatch: string }
  | { type: 'handle_check'; constraint: string };

/**
 * SopRule — 单条 SOP 规则。
 * Source: §4.8.
 */
export interface SopRule {
  id: string;
  text: string;
  severity: SopRuleSeverity;
  predicate: SopPredicate;
}

/**
 * SopStage — SOP 的一个阶段。
 * Source: §4.8.
 */
export interface SopStage {
  id: string; // 如 'kickoff', 'impl', 'review'
  label: string;
  suggestedSkill?: string;
  hardRules: SopRule[];
  pitfalls: SopRule[];
}

/**
 * SopDefinition — 完整 SOP 定义。
 * Source: §4.8.
 */
export interface SopDefinition {
  id: string;
  domain: string;
  label: string;
  stages: SopStage[];
}
