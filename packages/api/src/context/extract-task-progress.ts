// extract-task-progress — turn a tool_use frame into a task-progress item list,
// or null when the tool is not a task-list tool. The captured snapshot is what
// the 任务 tab shows live. Pure (no I/O) so it is unit-tested directly.
//
// Aligned to Clowder invoke-helpers extractTaskProgress + TASK_TOOL_NAMES: an
// agent's TodoWrite/write_todos `todos[]` of `{content, status, activeForm?}`.

import type { TaskProgressItem } from '@choco/shared';

/**
 * Tool names whose output is a task-progress snapshot (compared lowercase, so
 * claude's `TodoWrite` and the `write_todos` variant both match). Aligned to
 * Clowder TASK_TOOL_NAMES = {TodoWrite, write_todos, todowrite}.
 */
const TASK_TOOL_NAMES = new Set(['todowrite', 'write_todos']);

/** Cap a todo's subject so a runaway content string can't bloat the snapshot. */
const SUBJECT_MAX = 120;

/** Normalize a provider todo status to a stable set (unknown → 'pending'). */
function normalizeStatus(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (s === 'in_progress' || s === 'in-progress' || s === 'active') return 'in_progress';
  if (s === 'completed' || s === 'done') return 'completed';
  return 'pending';
}

/**
 * Extract a TaskProgressItem[] from a tool_use frame, or null when `toolName`
 * is not a task-list tool / the input has no `todos[]`. Each todo maps to
 * `{ id: 'task-N', subject, status, activeForm? }`.
 */
export function extractTaskProgress(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
): TaskProgressItem[] | null {
  if (toolName === undefined || !TASK_TOOL_NAMES.has(toolName.toLowerCase())) return null;
  const todos = toolInput?.['todos'];
  if (!Array.isArray(todos)) return null;
  return todos.map((raw, i): TaskProgressItem => {
    const t = (raw ?? {}) as Record<string, unknown>;
    const content = typeof t['content'] === 'string' ? t['content'] : '';
    const activeForm = typeof t['activeForm'] === 'string' ? t['activeForm'] : undefined;
    return {
      id: `task-${i}`,
      subject: content.slice(0, SUBJECT_MAX),
      status: normalizeStatus(t['status']),
      ...(activeForm !== undefined ? { activeForm } : {}),
    };
  });
}
