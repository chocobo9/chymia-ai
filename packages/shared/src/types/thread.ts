// Thread model.
// Source: clowder-architecture-design.md §4.4 (Thread).

import type { AgentId } from './agent.js';

/**
 * ThreadThinkingMode — thinking 展示模式。
 * Source: §4.4 (Thread.thinkingMode)。
 */
export type ThreadThinkingMode = 'debug' | 'play';

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
}
