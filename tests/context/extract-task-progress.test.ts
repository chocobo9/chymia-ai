// extract-task-progress — pure mapping of a TodoWrite/write_todos tool_use frame
// to a task-progress item list (or null when it is not a task tool). Aligned to
// Clowder invoke-helpers extractTaskProgress.

import { describe, it, expect } from 'vitest';
import { extractTaskProgress } from '@choco/api/context/extract-task-progress';

describe('extractTaskProgress', () => {
  it('maps a TodoWrite todos[] to task-progress items (id/subject/status/activeForm)', () => {
    const items = extractTaskProgress('TodoWrite', {
      todos: [
        { content: 'Read files', status: 'in_progress', activeForm: 'Reading files' },
        { content: 'Fix bug', status: 'pending' },
        { content: 'Wrote test', status: 'completed' },
      ],
    });
    expect(items).toEqual([
      { id: 'task-0', subject: 'Read files', status: 'in_progress', activeForm: 'Reading files' },
      { id: 'task-1', subject: 'Fix bug', status: 'pending' },
      { id: 'task-2', subject: 'Wrote test', status: 'completed' },
    ]);
  });

  it('matches the write_todos / lowercase variants too', () => {
    expect(extractTaskProgress('write_todos', { todos: [{ content: 'x', status: 'pending' }] })).toHaveLength(1);
    expect(extractTaskProgress('todowrite', { todos: [] })).toEqual([]);
  });

  it('returns null for a non-task tool or missing input', () => {
    expect(extractTaskProgress('Bash', { command: 'ls' })).toBeNull();
    expect(extractTaskProgress(undefined, undefined)).toBeNull();
    expect(extractTaskProgress('TodoWrite', { foo: 1 })).toBeNull(); // no todos[]
  });

  it('normalizes an unknown status to pending and caps the subject at 120 chars', () => {
    const long = 'x'.repeat(200);
    const items = extractTaskProgress('TodoWrite', { todos: [{ content: long, status: 'weird' }] });
    expect(items?.[0]?.status).toBe('pending');
    expect(items?.[0]?.subject.length).toBe(120);
  });

  it('maps "done" → completed and "active" → in_progress', () => {
    const items = extractTaskProgress('TodoWrite', {
      todos: [{ content: 'a', status: 'done' }, { content: 'b', status: 'active' }],
    });
    expect(items?.[0]?.status).toBe('completed');
    expect(items?.[1]?.status).toBe('in_progress');
  });
});
