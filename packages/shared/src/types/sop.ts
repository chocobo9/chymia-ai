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

/**
 * SopViolation — 一条被违反的 SOP 规则（后置评估的产物）。
 * Source: §5.6 SopEvalResult.violations。提升到 shared 以便 C2 socket 协议复用
 * 同一形状（advisory `sop_violation` payload），而不是另起一个平行类型。
 */
export interface SopViolation {
  ruleId: string;
  text: string;
  severity: SopRuleSeverity;
}

/**
 * SopViolationPayload — C2 server→client `sop_violation` 事件载荷（M12 SOP-Cycle-2）。
 * Source: clowder-design-supplement.md §C2（server→client 事件）。当一个 thread 离开
 * 某个真实 SOP 阶段时，后置评估若发现非 skipped 的违规，则把它作为 advisory（只提示不
 * 拦截）广播到该 thread 的房间。`stageId` 是被【离开】的阶段。
 */
export interface SopViolationPayload {
  threadId: string;
  stageId: string;
  violations: SopViolation[];
}
