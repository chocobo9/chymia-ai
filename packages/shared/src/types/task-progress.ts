// TaskProgress — an agent's IN-FLIGHT task checklist for a turn (its TodoWrite /
// write_todos snapshot), surfaced live in the 任务 tab so the user sees what a
// long-running agent is doing right now. Distinct from TaskItem (the persisted
// 任务线 board): this is the EPHEMERAL per-turn plan the agent reports, with
// latest-snapshot-wins semantics per (thread, agent).
//
// Aligned to Clowder reference/.../agents/invocation/TaskProgressStore.ts
// (TaskProgressSnapshot / TaskProgressItem). DELIBERATE DEVIATION: agentId (not
// catId); persisted to SQLite (Clowder uses a Redis hash); listByThread returns
// an array (Clowder getThreadSnapshots returns a Record) for friendlier rendering.

import type { AgentId } from './agent.js';

/** Lifecycle of a progress snapshot across a turn. */
export type TaskProgressStatus = 'running' | 'completed' | 'interrupted';

/** One checklist item the agent reported (from a TodoWrite todo). */
export interface TaskProgressItem {
  readonly id: string;
  /** The todo's content/title (capped at the store boundary). */
  readonly subject: string;
  /** Provider-reported state ('pending' | 'in_progress' | 'completed'); kept open. */
  readonly status: string;
  /** Optional in-progress phrasing the provider supplies (e.g. "Reading files"). */
  readonly activeForm?: string;
}

/** The latest task-progress snapshot for one agent in one thread. */
export interface TaskProgressSnapshot {
  readonly threadId: string;
  readonly agentId: AgentId;
  readonly tasks: readonly TaskProgressItem[];
  readonly status: TaskProgressStatus;
  readonly updatedAt: number;
  /** The invocation that produced this snapshot (for correlation). */
  readonly lastInvocationId?: string;
  /** When status==='interrupted', why ('error' | 'aborted'). */
  readonly interruptReason?: string;
}
