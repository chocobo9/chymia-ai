// SqliteTaskProgressStore — latest-snapshot-wins per (thread, agent), list by
// thread, delete by thread (the thread-delete cascade). Real in-memory SQLite.

import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { SqliteTaskProgressStore } from '@choco/api/stores/sqlite-task-progress-store';
import { createAgentId, type TaskProgressSnapshot, type TaskProgressStatus } from '@choco/shared';

function snap(
  threadId: string,
  agentId: string,
  status: TaskProgressStatus,
  subject: string,
): TaskProgressSnapshot {
  return {
    threadId,
    agentId: createAgentId(agentId),
    tasks: [{ id: 'task-0', subject, status: 'in_progress' }],
    status,
    updatedAt: 1,
  };
}

describe('SqliteTaskProgressStore', () => {
  it('latest-wins: a second setSnapshot for the same (thread, agent) replaces the first', () => {
    const store = new SqliteTaskProgressStore(new Database(':memory:'));
    store.setSnapshot(snap('T', 'claude-opus', 'running', 'first'));
    store.setSnapshot(snap('T', 'claude-opus', 'completed', 'second'));
    const list = store.listByThread('T');
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe('completed');
    expect(list[0]?.tasks[0]?.subject).toBe('second');
  });

  it('keeps a separate snapshot per agent in the same thread', () => {
    const store = new SqliteTaskProgressStore(new Database(':memory:'));
    store.setSnapshot(snap('T', 'claude-opus', 'running', 'a'));
    store.setSnapshot(snap('T', 'codex-gpt', 'running', 'b'));
    expect(store.listByThread('T')).toHaveLength(2);
  });

  it('round-trips the full snapshot (agentId/tasks/status) through JSON', () => {
    const store = new SqliteTaskProgressStore(new Database(':memory:'));
    store.setSnapshot(snap('T', 'claude-opus', 'running', 'hello'));
    const [got] = store.listByThread('T');
    expect(got?.agentId).toBe('claude-opus');
    expect(got?.tasks).toEqual([{ id: 'task-0', subject: 'hello', status: 'in_progress' }]);
  });

  it('deleteByThread removes a thread\'s snapshots and returns the count', () => {
    const store = new SqliteTaskProgressStore(new Database(':memory:'));
    store.setSnapshot(snap('T', 'claude-opus', 'running', 'a'));
    store.setSnapshot(snap('T', 'codex-gpt', 'running', 'b'));
    expect(store.deleteByThread('T')).toBe(2);
    expect(store.listByThread('T')).toHaveLength(0);
  });
});
