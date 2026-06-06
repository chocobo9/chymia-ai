// task store — Zustand state for per-thread task lines (任务线 / 毛线球), kept in
// sync by the WorkspaceTasks board (load + optimistic CRUD) and the socket
// listeners (task_created / task_updated / task_deleted from other clients, the
// agent, or 飞书). Immutable updates throughout (CLAUDE.md coding-style).

import { create } from 'zustand';
import type { TaskItem } from '@choco/shared';

interface TaskState {
  /** Task lines per threadId. */
  readonly tasksByThread: Readonly<Record<string, readonly TaskItem[]>>;
  /** Replace a thread's task list (initial load / refetch). */
  setTasks(threadId: string, tasks: readonly TaskItem[]): void;
  /** Insert or replace a task by id (create / update — from API or socket). */
  upsertTask(task: TaskItem): void;
  /** Remove a task by id from its thread (delete — from API or socket). */
  removeTask(threadId: string, taskId: string): void;
}

export const useTaskStore = create<TaskState>((set) => ({
  tasksByThread: {},

  setTasks: (threadId, tasks) =>
    set((state) => ({
      tasksByThread: { ...state.tasksByThread, [threadId]: tasks },
    })),

  upsertTask: (task) =>
    set((state) => {
      const existing = state.tasksByThread[task.threadId] ?? [];
      const idx = existing.findIndex((t) => t.id === task.id);
      const next = idx === -1 ? [...existing, task] : existing.map((t, i) => (i === idx ? task : t));
      return { tasksByThread: { ...state.tasksByThread, [task.threadId]: next } };
    }),

  removeTask: (threadId, taskId) =>
    set((state) => {
      const existing = state.tasksByThread[threadId];
      if (existing === undefined) return {};
      return {
        tasksByThread: {
          ...state.tasksByThread,
          [threadId]: existing.filter((t) => t.id !== taskId),
        },
      };
    }),
}));
