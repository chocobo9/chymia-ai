// tests/invocation/invoke-single-agent.test.ts
// M3 dev happy-path tests for the invokeSingleAgent driver (§6.2).
// Deterministic: injected FakeAgentService (scripted AsyncIterable), :memory:
// SessionStore archive, real SessionMutex, injected clock — no CLI, no real timers.

import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentMessage } from '@choco/shared';
import { createAgentId } from '@choco/shared';
import { SessionStore } from '@choco/api/invocation/session-store';
import { SqliteMessageStore } from '@choco/api/stores/sqlite-message-store';
import { SqliteToolEventLog } from '@choco/api/stores/sqlite-tool-event-log';
import { SessionMutex } from '@choco/api/invocation/session-mutex';
import { invokeSingleAgent } from '@choco/api/invocation/invoke-single-agent';
import {
  FakeAgentService,
  sessionInit,
  textEvent,
  doneEvent,
} from './fake-agent-service';

const FIXED_TS = 1_700_000_000_000;
const fixedNow = (): number => FIXED_TS;

/** Build a SessionStore over a fresh in-memory db wired to real transcript readers. */
function makeSessionStore(db: Database.Database): SessionStore {
  return new SessionStore(db, {
    messageReader: new SqliteMessageStore(db),
    toolEventReader: new SqliteToolEventLog(db),
    now: fixedNow,
  });
}

async function drain(gen: AsyncGenerator<AgentMessage>): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

describe('invokeSingleAgent — happy path (unit)', () => {
  test('drains a successful stream and forwards text + done (session_init suppressed)', async () => {
    // Arrange
    const agentId = createAgentId('claude-opus');
    const fake = new FakeAgentService([
      [
        sessionInit(agentId, 'sess-claude-init-01', FIXED_TS),
        textEvent(agentId, 'Here is your TODO API.', FIXED_TS),
        doneEvent(agentId, FIXED_TS),
      ],
    ]);
    const db = new Database(':memory:');
    const sessionStore = makeSessionStore(db);
    const sessionMutex = new SessionMutex();

    // Act
    const events = await drain(
      invokeSingleAgent({
        agentService: fake,
        sessionStore,
        sessionMutex,
        agentId,
        threadId: 'thread-todo-api',
        prompt: '@claude write a TODO API with CRUD endpoints',
        now: fixedNow,
      }),
    );

    // Assert: session_init is not forwarded; text + done are.
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
    expect(events[0]?.content).toBe('Here is your TODO API.');
    db.close();
  });

  test('persists the session id from session_init', async () => {
    // Arrange
    const agentId = createAgentId('codex');
    const fake = new FakeAgentService([
      [
        sessionInit(agentId, 'sess-codex-7b2f', FIXED_TS),
        textEvent(agentId, 'Reviewing the code above.', FIXED_TS),
        doneEvent(agentId, FIXED_TS),
      ],
    ]);
    const db = new Database(':memory:');
    const sessionStore = makeSessionStore(db);
    const sessionMutex = new SessionMutex();

    // Act
    await drain(
      invokeSingleAgent({
        agentService: fake,
        sessionStore,
        sessionMutex,
        agentId,
        threadId: 'thread-review',
        prompt: '@codex review the code above',
        now: fixedNow,
      }),
    );

    // Assert
    expect(sessionStore.getActiveSessionId(agentId, 'thread-review')).toBe('sess-codex-7b2f');
    db.close();
  });

  test('resumes by injecting the persisted sessionId into the provider options', async () => {
    // Arrange
    const agentId = createAgentId('claude-opus');
    const db = new Database(':memory:');
    const sessionStore = makeSessionStore(db);
    sessionStore.startSession(agentId, 'thread-todo-api', 'sess-resume-existing');
    const sessionMutex = new SessionMutex();
    const fake = new FakeAgentService([
      [textEvent(agentId, 'Continuing.', FIXED_TS), doneEvent(agentId, FIXED_TS)],
    ]);

    // Act
    await drain(
      invokeSingleAgent({
        agentService: fake,
        sessionStore,
        sessionMutex,
        agentId,
        threadId: 'thread-todo-api',
        prompt: 'add a DELETE endpoint',
        now: fixedNow,
      }),
    );

    // Assert: the provider was invoked with the resumed sessionId.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.options?.sessionId).toBe('sess-resume-existing');
    db.close();
  });

  test('releases the mutex after completion (next acquire resolves)', async () => {
    // Arrange
    const agentId = createAgentId('gemini');
    const fake = new FakeAgentService([
      [textEvent(agentId, 'done thinking', FIXED_TS), doneEvent(agentId, FIXED_TS)],
    ]);
    const db = new Database(':memory:');
    const sessionStore = makeSessionStore(db);
    const sessionMutex = new SessionMutex();

    // Act
    await drain(
      invokeSingleAgent({
        agentService: fake,
        sessionStore,
        sessionMutex,
        agentId,
        threadId: 'thread-design',
        prompt: 'sketch the architecture',
        now: fixedNow,
      }),
    );

    // Assert: the lock was released, so a fresh acquire on the same key resolves.
    const release = await sessionMutex.acquire('gemini:thread-design');
    expect(typeof release).toBe('function');
    release();
    db.close();
  });
});
