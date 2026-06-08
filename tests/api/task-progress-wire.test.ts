// task-progress + session_seal wiring — integration against the REAL engine
// (buildApp, only the CLI faked). Proves:
//   1. a TodoWrite tool_use frame in a turn → a task-progress snapshot is captured
//      (running mid-turn, flipped to completed at turn end), readable via
//      GET /api/tasks/progress.
//   2. session_init sealing the prior active session (auto-seal) → a session_seal
//      AUDIT event is emitted (the P0-6 gap: previously only the explicit seal
//      route emitted it). Also exercises the auto-seal-in-transaction path.

import Database from 'better-sqlite3';
import { describe, it, expect, afterEach } from 'vitest';
import type { AgentMessage, AuditEvent, TaskProgressSnapshot } from '@choco/shared';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { CLAUDE } from './helpers.js';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function makeApp(scripts: AgentMessage[][]): BuiltApp {
  const db = new Database(':memory:');
  const app = buildApp({ db, agentServices: { 'claude-opus': new FakeAgentService(scripts) } });
  cleanups.push(app.close);
  return app;
}

async function postMention(app: BuiltApp, threadId: string): Promise<void> {
  await app.api.inject({
    method: 'POST',
    url: `/api/threads/${threadId}/messages`,
    payload: { content: '@claude 干活', userId: 'user-x' },
  });
}

/** A turn that reports a TodoWrite plan mid-stream. */
function todoTurn(sessionId: string): AgentMessage[] {
  return [
    { type: 'session_init', agentId: CLAUDE, content: sessionId, timestamp: 1 },
    {
      type: 'tool_use',
      agentId: CLAUDE,
      toolName: 'TodoWrite',
      toolUseId: 't1',
      toolInput: { todos: [{ content: 'step one', status: 'in_progress' }, { content: 'step two', status: 'pending' }] },
      timestamp: 2,
    },
    { type: 'text', agentId: CLAUDE, content: '在做了', timestamp: 3 },
    { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: 4 },
  ];
}

/** A plain turn that opens `sessionId`. */
function plainTurn(sessionId: string): AgentMessage[] {
  return [
    { type: 'session_init', agentId: CLAUDE, content: sessionId, timestamp: 1 },
    { type: 'text', agentId: CLAUDE, content: 'ok', timestamp: 2 },
    { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: 3 },
  ];
}

describe('task-progress capture from a TodoWrite frame', () => {
  it('captures the agent plan and flips it to completed at turn end', async () => {
    const app = makeApp([todoTurn('sess-tp')]);
    await postMention(app, 'thread-tp');

    const res = await app.api.inject({ method: 'GET', url: '/api/tasks/progress?threadId=thread-tp' });
    expect(res.statusCode).toBe(200);
    const { snapshots } = res.json<{ snapshots: TaskProgressSnapshot[] }>();
    expect(snapshots).toHaveLength(1);
    const snap = snapshots[0]!;
    expect(snap.agentId).toBe('claude-opus');
    // The turn ended normally → terminal status completed.
    expect(snap.status).toBe('completed');
    expect(snap.tasks.map((t) => t.subject)).toEqual(['step one', 'step two']);
    expect(snap.tasks[0]?.status).toBe('in_progress');
  });

  it('a turn with no TodoWrite frame produces no snapshot', async () => {
    const app = makeApp([plainTurn('sess-none')]);
    await postMention(app, 'thread-none');
    const res = await app.api.inject({ method: 'GET', url: '/api/tasks/progress?threadId=thread-none' });
    expect(res.json<{ snapshots: TaskProgressSnapshot[] }>().snapshots).toEqual([]);
  });
});

describe('session_seal audit event on auto-seal (session_init)', () => {
  it('a second turn with a fresh session_init seals the prior session AND emits session_seal', async () => {
    const app = makeApp([plainTurn('sess-1'), plainTurn('sess-2')]);
    await postMention(app, 'thread-seal'); // opens sess-1 (active)
    await postMention(app, 'thread-seal'); // session_init sess-2 → auto-seal sess-1

    const res = await app.api.inject({ method: 'GET', url: '/api/audit/thread/thread-seal' });
    expect(res.statusCode).toBe(200);
    const { events } = res.json<{ events: AuditEvent[] }>();
    const seal = events.find((e) => e.type === 'session_seal');
    expect(seal).toBeDefined();
    expect(seal?.data).toMatchObject({ sessionId: 'sess-1', agentId: 'claude-opus' });
    // The real event is NOT a derived one (it was engine-emitted via onSeal).
    expect(seal?.data.derived).toBeUndefined();
    // Exactly one session_seal (no double-emit from the explicit-seal route path).
    expect(events.filter((e) => e.type === 'session_seal')).toHaveLength(1);
  });
});
