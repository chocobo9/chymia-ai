// Thread model.
// Source: clowder-architecture-design.md §4.4 (Thread).

import type { AgentId } from './agent.js';

/**
 * ThreadThinkingMode — thinking 展示模式。
 * Source: §4.4 (Thread.thinkingMode)。
 */
export type ThreadThinkingMode = 'debug' | 'play';

/**
 * ThreadRoutingScope — the intent/scope a thread routing rule applies to.
 * Source: Clowder ThreadStore.ts ThreadRoutingScope (F042).
 */
export type ThreadRoutingScope = 'review' | 'architecture';

/**
 * ThreadRoutingRule — a per-scope routing preference. `preferCats` are placed
 * first; `avoidCats` are skipped on fallback routing UNLESS explicitly
 * @mentioned; `expiresAt` (epoch ms) lets a rule lapse.
 * Source: Clowder ThreadStore.ts ThreadRoutingRule.
 */
export interface ThreadRoutingRule {
  preferCats?: AgentId[];
  avoidCats?: AgentId[];
  /** Human-readable reason (e.g. "budget"). */
  reason?: string;
  /** Optional expiry (epoch ms). When expired, the rule is ignored. */
  expiresAt?: number;
}

/**
 * ThreadRoutingPolicyV1 — a thread-scoped routing policy keyed by scope.
 * This is NOT global availability — it is a temporary per-thread preference
 * (budget/focus) applied only to FALLBACK routing.
 * Source: Clowder ThreadStore.ts ThreadRoutingPolicyV1 (F042).
 */
export interface ThreadRoutingPolicyV1 {
  v: 1;
  scopes?: Partial<Record<ThreadRoutingScope, ThreadRoutingRule>>;
}

/**
 * Thread — 一个会话线程。
 * Source: §4.4.
 */
export interface Thread {
  id: string; // UUID
  title?: string;
  projectPath?: string; // 关联的项目目录
  createdAt: number; // epoch ms
  lastActiveAt: number; // epoch ms
  participants: AgentId[]; // 参与过的 agent 列表
  sopStageId?: string; // SOP 当前阶段
  thinkingMode: ThreadThinkingMode;
  routingPolicy?: ThreadRoutingPolicyV1; // F042: 线程级 scope 路由偏好（仅 fallback 生效）
}
