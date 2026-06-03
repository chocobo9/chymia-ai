// Skill model: definitions and manifest.
// Source: clowder-architecture-design.md §4.7 (Skill).

/**
 * SkillDefinition — 单个 skill 的定义。
 * Source: §4.7.
 */
export interface SkillDefinition {
  id: string;
  description: string;
  triggers: string[]; // 触发关键词
  notFor: string[]; // 排除关键词
  output: string; // 产出契约描述
  next?: string[]; // 链式下一个 skill
  sopStep?: string | null; // 对应的 SOP 阶段
  group?: string; // 分类标签（dev-chain / memory / meta / multi-agent），用于设置页分类
}

/**
 * SkillManifest — skill 清单（id → 定义 的映射）。
 * Source: §4.7.
 */
export interface SkillManifest {
  skills: Record<string, SkillDefinition>;
}
