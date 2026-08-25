// task-progress store — Zustand state for per-thread, per-agent task-PROGRESS
// snapshots (an agent's live TodoWrite plan), kept in sync by the WorkspaceTasks
// board (initial load via GET /api/tasks/progress) + the socket task_progress
// listener. Latest-wins per agent (one snapshot per agent in a thread).
// Immutable updates throughout (CLAUDE.md coding-style).

import { create } from 'zustand';
import type { TaskProgressSnapshot } from '@choco/shared';

interface TaskProgressState {
  /** Snapshots per threadId (one per agent, latest-wins). */
  readonly snapshotsByThread: Readonly<Record<string, readonly TaskProgressSnapshot[]>>;
  /** Replace a thread's snapshots (initial load / refetch). */
  setSnapshots(threadId: string, snapshots: readonly TaskProgressSnapshot[]): void;
  /** Apply one snapshot (from socket) — replace the same agent's entry, latest-wins. */
  applySnapshot(snapshot: TaskProgressSnapshot): void;
}

export const useTaskProgressStore = create<TaskProgressState>((set) => ({
  snapshotsByThread: {},

  setSnapshots: (threadId, snapshots) =>
    set((state) => ({
      snapshotsByThread: { ...state.snapshotsByThread, [threadId]: snapshots },
    })),

  applySnapshot: (snapshot) =>
    set((state) => {
      const existing = state.snapshotsByThread[snapshot.threadId] ?? [];
      const idx = existing.findIndex((s) => s.agentId === snapshot.agentId);
      const next =
        idx === -1 ? [...existing, snapshot] : existing.map((s, i) => (i === idx ? snapshot : s));
      return { snapshotsByThread: { ...state.snapshotsByThread, [snapshot.threadId]: next } };
    }),
}));
