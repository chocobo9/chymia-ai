// Task (任务线 / 毛线球) — a long-running item tracked across conversation turns,
// kept on the thread instead of buried back in the chat.
//
// Source: clowder-architecture-design.md task system; aligned to Clowder
// reference/.../shared/src/types/task.ts. DELIBERATE DEVIATION: Clowder's #320
// merged PR-tracking INTO the task model (kind/subjectKey/automationState +
// upsert-by-subject). That is the community/automation surface — NOT the
// work-task lines this tab shows — so it is dropped here (YAGNI, coding-style).
// choco keeps the work-task essentials only.

import type { AgentId } from './agent.js';

/** Lifecycle state of a task line. */
export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done';

/** Who created a task: an agent (by id), the owner ('user'), or the engine. */
export type TaskCreatedBy = AgentId | 'user' | 'system';

/** Max lengths enforced at the route boundary (validation). */
export const TASK_TITLE_MAX = 200;
export const TASK_WHY_MAX = 1000;

/** A single task line attached to a thread. */
export interface TaskItem {
  readonly id: string;
  readonly threadId: string;
  readonly title: string;
  /** Why this task exists — shown on expand; injected for blocked tasks. */
  readonly why: string;
  readonly status: TaskStatus;
  /** The agent that owns this task, or null (unassigned). */
  readonly ownerCatId: AgentId | null;
  readonly createdBy: TaskCreatedBy;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Input to create a task. status defaults to 'todo'; timestamps are stamped by the store. */
export interface CreateTaskInput {
  readonly threadId: string;
  readonly title: string;
  readonly why: string;
  readonly createdBy: TaskCreatedBy;
  readonly ownerCatId?: AgentId | null;
}

/** Partial update — at least one field; only provided fields change. */
export interface UpdateTaskInput {
  readonly title?: string;
  readonly why?: string;
  readonly status?: TaskStatus;
  readonly ownerCatId?: AgentId | null;
}
