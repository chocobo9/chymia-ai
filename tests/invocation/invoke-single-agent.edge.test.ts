// tests/invocation/invoke-single-agent.edge.test.ts
// M3 QA (independent) — edge + adversarial coverage for invokeSingleAgent + the
// retry policy as exercised end-to-end through the driver.
//
// Author: QA subagent (did NOT write invoke-single-agent.ts / retry.ts nor the
// dev happy-path tests). Per CLAUDE.md §0.5.3.
//
// Determinism: the dev's shared FakeAgentService (scripted AsyncIterable, one
// script per call, records each call's options in `.calls`) plus a local
// inline ThrowingAgentService (implements the M2 AgentService interface) for the
// provider-crash case; an injected `now` stamps synthesized errors; an in-memory
// better-sqlite3 db backs SessionManager. No wall-clock sleeps/timers. Real
// prompts / agent ids / session ids are used (no "foo"/"test123").
//
// Design conformance note (audit, NOT a deviation): architecture §6.2 + §7.5 say
// "timeout → 清 session 重试" (clear session and retry without a sessionId). The
// product code (retry.ts) matches this — clearSession=true for timeout. These
// tests lock that behavior.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentId, AgentMessage } from '@clowder/shared';
import { createAgentId } from '@clowder/shared';
import type { AgentService, InvokeOptions } from '@clowder/api/providers/base';
import { invokeSingleAgent } from '@clowder/api/invocation/invoke-single-agent';
import { SessionStore } from '@clowder/api/invocation/session-store';
import { SqliteMessageStore } from '@clowder/api/stores/sqlite-message-store';
import { SqliteToolEventLog } from '@clowder/api/stores/sqlite-tool-event-log';
import { SessionMutex } from '@clowder/api/invocation/session-mutex';
import {
  FakeAgentService,
  sessionInit,
  textEvent,
} from './fake-agent-service';

/** Build a fresh (in-memory) SessionStore archive + SessionMutex + fixed clock. */
function harness(): {
  sessionStore: SessionStore;
  sessionMutex: SessionMutex;
  now: () => number;
} {
  const db = new Database(':memory:');
  return {
    sessionStore: new SessionStore(db, {
      messageReader: new SqliteMessageStore(db),
      toolEventReader: new SqliteToolEventLog(db),
      now: () => 1_000,
    }),
    sessionMutex: new SessionMutex(),
    now: () => 1_000,
  };
}

/** Drain a driver run into an array of yielded events. */
async function drain(
  gen: AsyncGenerator<AgentMessage>,
): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const ev of gen) {
    out.push(ev);
  }
  return out;
}

const CLAUDE: AgentId = createAgentId('claude-opus');

/** Build a real `error` AgentMessage (yielded, not thrown). */
function errorEvent(content: string, ts: number): AgentMessage {
  return { type: 'error', agentId: CLAUDE, content, timestamp: ts };
}

/** Build a `tool_use` AgentMessage. */
function toolUseEvent(toolName: string, ts: number): AgentMessage {
  return {
    type: 'tool_use',
    agentId: CLAUDE,
    toolName,
    toolInput: { path: 'todo.ts' },
    timestamp: ts,
  };
}

/**
 * Inline fake that yields a real prefix of events, then THROWS mid-stream — the
 * dev's FakeAgentService cannot model a thrown provider crash, so this local
 * AgentService (implementing the M2 interface) covers that adversarial path.
 */
class ThrowingAgentService implements AgentService {
  readonly calls: { readonly options: InvokeOptions | undefined }[] = [];

  constructor(
    private readonly prefix: readonly AgentMessage[],
    private readonly throwMessage: string,
  ) {}

  invoke(_prompt: string, options?: InvokeOptions): AsyncIterable<AgentMessage> {
    this.calls.push({ options });
    const prefix = this.prefix;
    const throwMessage = this.throwMessage;
    return (async function* (): AsyncIterable<AgentMessage> {
      for (const ev of prefix) {
        yield ev;
      }
      throw new Error(throwMessage);
    })();
  }
}

describe('invokeSingleAgent — edge: session_init handling', () => {
  it('persists session from session_init and never re-yields it into the stream', async () => {
    const { sessionStore, sessionMutex, now } = harness();
    const threadId = 'thread-init-suppress';
    const fake = new FakeAgentService([
      [
        sessionInit(CLAUDE, 'sess-cli-7f', 1),
        textEvent(CLAUDE, 'Scaffolding the CRUD routes.', 2),
        { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: 3 },
      ],
    ]);

    const events = await drain(
      invokeSingleAgent({
        agentService: fake,
        sessionStore,
        sessionMutex,
        agentId: CLAUDE,
        threadId,
        prompt: 'Write a TODO API with CRUD endpoints',
        now,
      }),
    );

    // session_init is suppressed; text + done pass through.
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
    expect(events.some((e) => e.type === 'session_init')).toBe(false);
    // Persisted for the next resume.
    expect(sessionStore.getActiveSessionId(CLAUDE, threadId)).toBe('sess-cli-7f');
  });

  it('adversarial: an empty session_init content is NOT persisted (no blank session)', async () => {
    const { sessionStore, sessionMutex, now } = harness();
    const threadId = 'thread-empty-init';
    const fake = new FakeAgentService([
      [
        sessionInit(CLAUDE, '', 1),
        textEvent(CLAUDE, 'Working without a session id.', 2),
      ],
    ]);

    await drain(
      invokeSingleAgent({
        agentService: fake,
        sessionStore,
        sessionMutex,
        agentId: CLAUDE,
        threadId,
        prompt: 'Continue implementation of the DELETE route',
        now,
      }),
    );

    expect(sessionStore.getActiveSessionId(CLAUDE, threadId)).toBeUndefined();
  });
});

describe('invokeSingleAgent — edge/adversarial: retry recovery paths', () => {
  it('missing-session error → clears session THEN retries WITHOUT a sessionId, succeeds', async () => {
    const { sessionStore, sessionMutex, now } = harness();
    const threadId = 'thread-missing-session';
    // Pre-existing (now invalid) session that the CLI rejects.
    sessionStore.startSession(CLAUDE, threadId, 'stale-sess-dead');

    const fake = new FakeAgentService([
      // Attempt 1: CLI rejects the resumed session.
      [errorEvent('No conversation found with session id stale-sess-dead', 1)],
      // Attempt 2: fresh session established + real output.
      [
        sessionInit(CLAUDE, 'sess-fresh-9a', 2),
        textEvent(CLAUDE, 'Recovered and continuing.', 3),
      ],
    ]);

    const events = await drain(
      invokeSingleAgent({
        agentService: fake,
        sessionStore,
        sessionMutex,
        agentId: CLAUDE,
        threadId,
        prompt: 'Add DELETE endpoint to the TODO API',
        now,
      }),
    );

    // First attempt resumed the stale session; second attempt invoked WITHOUT one.
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.options?.sessionId).toBe('stale-sess-dead');
    expect(fake.calls[1]?.options?.sessionId).toBeUndefined();
    // Final state: the fresh session is persisted, output surfaced, no error event.
    expect(sessionStore.getActiveSessionId(CLAUDE, threadId)).toBe('sess-fresh-9a');
    expect(events.map((e) => e.type)).toEqual(['text']);
    expect(events[0]?.content).toBe('Recovered and continuing.');
  });

  it('prompt-limit error → same clear-then-retry recovery', async () => {
    const { sessionStore, sessionMutex, now } = harness();
    const threadId = 'thread-prompt-limit';
    sessionStore.startSession(CLAUDE, threadId, 'sess-overloaded');

    const fake = new FakeAgentService([
      [errorEvent('prompt is too long: maximum context length exceeded', 1)],
      [
        sessionInit(CLAUDE, 'sess-trimmed-3', 2),
        textEvent(CLAUDE, 'Retried with a fresh context.', 3),
      ],
    ]);

    const events = await drain(
      invokeSingleAgent({
        agentService: fake,
        sessionStore,
        sessionMutex,
        agentId: CLAUDE,
        threadId,
        prompt: 'Summarize the entire repository architecture',
        now,
      }),
    );

    expect(fake.calls[1]?.options?.sessionId).toBeUndefined();
    expect(sessionStore.getActiveSessionId(CLAUDE, threadId)).toBe('sess-trimmed-3');
    expect(events.map((e) => e.type)).toEqual(['text']);
  });

  it('transient error → retries WITHOUT clearing the session (sessionId preserved across the retry)', async () => {
    const { sessionStore, sessionMutex, now } = harness();
    const threadId = 'thread-transient';
    sessionStore.startSession(CLAUDE, threadId, 'sess-keepme-55');

    const fake = new FakeAgentService([
      [errorEvent('connection reset by peer', 1)],
      [textEvent(CLAUDE, 'Reconnected, work done.', 2)],
    ]);

    const events = await drain(
      invokeSingleAgent({
        agentService: fake,
        sessionStore,
        sessionMutex,
        agentId: CLAUDE,
        threadId,
        prompt: 'Run the test suite and report results',
        now,
      }),
    );

    // Transient must NOT clear: both attempts resume the same session id.
    expect(fake.calls[0]?.options?.sessionId).toBe('sess-keepme-55');
    expect(fake.calls[1]?.options?.sessionId).toBe('sess-keepme-55');
    expect(sessionStore.getActiveSessionId(CLAUDE, threadId)).toBe('sess-keepme-55');
    expect(events.map((e) => e.type)).toEqual(['text']);
  });

  it('timeout error → clears the session before retrying (per §6.2/§7.5: timeout → 清 session 重试)', async () => {
    // Conformance: retry.ts classifies timeout with clearSession=true, matching
    // the design ("timeout 无输出 → 无 session 重试"). The retry invokes WITHOUT
    // a sessionId.
    const { sessionStore, sessionMutex, now } = harness();
    const threadId = 'thread-timeout';
    sessionStore.startSession(CLAUDE, threadId, 'sess-before-timeout');

    const fake = new FakeAgentService([
      [errorEvent('request timed out after 600s (deadline exceeded)', 1)],
      [
        sessionInit(CLAUDE, 'sess-after-timeout', 2),
        textEvent(CLAUDE, 'Completed on retry.', 3),
      ],
    ]);

    await drain(
      invokeSingleAgent({
        agentService: fake,
        sessionStore,
        sessionMutex,
        agentId: CLAUDE,
        threadId,
        prompt: 'Build and benchmark the project',
        now,
      }),
    );

    // timeout cleared the session, so attempt 2 had no sessionId (started fresh).
    expect(fake.calls[1]?.options?.sessionId).toBeUndefined();
    expect(sessionStore.getActiveSessionId(CLAUDE, threadId)).toBe('sess-after-timeout');
  });
});

describe('invokeSingleAgent — adversarial: give-up paths', () => {
  it('adversarial: retry exhaustion after exactly 2 retries surfaces a terminal error (3 attempts total, no infinite loop)', async () => {
    const { sessionStore, sessionMutex, now } = harness();
    const threadId = 'thread-exhaust';

    // Three failing attempts: initial + 2 retries, then must STOP.
    const fake = new FakeAgentService([
      [errorEvent('connection reset by peer', 1)],
      [errorEvent('connection reset by peer', 2)],
      [errorEvent('connection reset by peer', 3)],
    ]);

    const events = await drain(
      invokeSingleAgent({
        agentService: fake,
        sessionStore,
        sessionMutex,
        agentId: CLAUDE,
        threadId,
        prompt: 'Deploy the service to staging',
        now,
      }),
    );

    // Exactly initial + MAX_RETRIES(2) = 3 invocations, then a single terminal error.
    expect(fake.calls).toHaveLength(3);
    expect(events.map((e) => e.type)).toEqual(['error']);
    expect(events[0]?.content).toContain('connection reset');
  });

  it('adversarial: an unclassified (non-retryable) error is surfaced immediately with no retry (1 attempt only)', async () => {
    const { sessionStore, sessionMutex, now } = harness();
    const threadId = 'thread-unclassified';
    const fake = new FakeAgentService([
      [errorEvent('ENOSPC: no space left on device while writing artifact', 1)],
    ]);

    const events = await drain(
      invokeSingleAgent({
        agentService: fake,
        sessionStore,
        sessionMutex,
        agentId: CLAUDE,
        threadId,
        prompt: 'Save the generated report to disk',
        now,
      }),
    );

    expect(fake.calls).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(['error']);
    expect(events[0]?.content).toContain('no space left on device');
  });

  it('ADVERSARIAL "output already produced": yields content THEN a transient error → must NOT retry, no duplicated output', async () => {
    // The single most important retry guard: once user-visible output streamed,
    // re-invoking would duplicate it. A second scripted attempt exists to PROVE
    // it is never consumed.
    const { sessionStore, sessionMutex, now } = harness();
    const threadId = 'thread-output-then-fail';

    const fake = new FakeAgentService([
      // Real partial output, then a retryable (transient) error.
      [
        sessionInit(CLAUDE, 'sess-partial-1', 1),
        textEvent(CLAUDE, 'Here is the first half of the implementation:', 2),
        toolUseEvent('write_file', 3),
        errorEvent('rate limit exceeded (429)', 4),
      ],
      // This attempt MUST NOT run; if it does, output would be duplicated.
      [textEvent(CLAUDE, 'DUPLICATE OUTPUT — SHOULD NEVER APPEAR', 5)],
    ]);

    const events = await drain(
      invokeSingleAgent({
        agentService: fake,
        sessionStore,
        sessionMutex,
        agentId: CLAUDE,
        threadId,
        prompt: 'Implement the full TODO API in one shot',
        now,
      }),
    );

    // Only ONE attempt consumed despite the error being individually retryable.
    expect(fake.calls).toHaveLength(1);
    // The produced output is forwarded, then the terminal error — and the
    // would-be duplicate never appears.
    expect(events.map((e) => e.type)).toEqual(['text', 'tool_use', 'error']);
    expect(
      events.some((e) => e.content === 'DUPLICATE OUTPUT — SHOULD NEVER APPEAR'),
    ).toBe(false);
    expect(events.filter((e) => e.type === 'text')).toHaveLength(1);
  });

  it('adversarial: a thrown provider crash after output is wrapped as an error event and not swallowed', async () => {
    // Provider throws (not a yielded error event) AFTER producing output → the
    // driver wraps it as an error event; because output was produced, it stops.
    const { sessionStore, sessionMutex, now } = harness();
    const threadId = 'thread-crash';
    const throwing = new ThrowingAgentService(
      [textEvent(CLAUDE, 'Partial answer before crash.', 1)],
      'spawn EPIPE: child process pipe broke unexpectedly',
    );

    const events = await drain(
      invokeSingleAgent({
        agentService: throwing,
        sessionStore,
        sessionMutex,
        agentId: CLAUDE,
        threadId,
        prompt: 'Generate the OpenAPI spec for the TODO service',
        now,
      }),
    );

    expect(throwing.calls).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(['text', 'error']);
    expect(events[1]?.content).toContain('EPIPE');
    // Synthesized error stamped with the injected clock (deterministic).
    expect(events[1]?.timestamp).toBe(1_000);
  });

  it('adversarial: a thrown transient crash with NO prior output is classified and retried', async () => {
    // A thrown (not yielded) transient error before any output must still be
    // classified via decideRetry and retried — proving thrown and yielded errors
    // are handled uniformly.
    const { sessionStore, sessionMutex, now } = harness();
    const threadId = 'thread-crash-retry';
    sessionStore.startSession(CLAUDE, threadId, 'sess-keep-crash');

    // Attempt 1 (throwing) handled by the inline crash fake; attempt 2 cannot be
    // scripted on the same instance, so model recovery by asserting the first
    // attempt's classification surfaces as a retry: use a fresh transient retry
    // through the dev fake instead would change instances. Here we assert the
    // single throwing attempt's behavior: transient + no output → driver retries,
    // and with no second script it re-invokes the same throwing generator, which
    // throws again; after exhaustion a terminal error surfaces.
    const throwing = new ThrowingAgentService(
      [],
      'overloaded_error: service temporarily unavailable',
    );

    const events = await drain(
      invokeSingleAgent({
        agentService: throwing,
        sessionStore,
        sessionMutex,
        agentId: CLAUDE,
        threadId,
        prompt: 'Compile the workspace',
        now,
      }),
    );

    // No output ever produced → transient is retryable; initial + 2 retries = 3.
    expect(throwing.calls).toHaveLength(3);
    expect(events.map((e) => e.type)).toEqual(['error']);
    expect(events[0]?.content).toContain('overloaded_error');
    // transient keeps the session (never cleared).
    expect(sessionStore.getActiveSessionId(CLAUDE, threadId)).toBe('sess-keep-crash');
  });
});

describe('invokeSingleAgent — adversarial: cancellation', () => {
  it('adversarial: a pre-aborted signal runs no provider attempt (cancellation observable)', async () => {
    const { sessionStore, sessionMutex, now } = harness();
    const threadId = 'thread-aborted';
    const controller = new AbortController();
    controller.abort();

    const fake = new FakeAgentService([
      [textEvent(CLAUDE, 'should not run', 1)],
    ]);

    // A pre-aborted signal makes the mutex acquire reject; the driver is an async
    // generator, so the rejection surfaces when iteration begins.
    let caught: unknown;
    const events: AgentMessage[] = [];
    try {
      for await (const ev of invokeSingleAgent({
        agentService: fake,
        sessionStore,
        sessionMutex,
        agentId: CLAUDE,
        threadId,
        prompt: 'Cancel this invocation immediately',
        signal: controller.signal,
        now,
      })) {
        events.push(ev);
      }
    } catch (err) {
      caught = err;
    }

    // No provider attempt was made regardless of how cancellation surfaces.
    expect(fake.calls).toHaveLength(0);
    // Cancellation is observable: either a yielded error event OR a rejection.
    const sawError = events.some((e) => e.type === 'error');
    expect(sawError || caught !== undefined).toBe(true);
  });
});

describe('invokeSingleAgent — edge: mutex serialization through the driver', () => {
  it('two same-(agent,thread) invocations serialize; the second sees the session the first persisted', async () => {
    // Edge: the driver holds the mutex per (agent,thread); a concurrent second
    // call must wait, then resume the session_init the first call persisted.
    const { sessionStore, sessionMutex, now } = harness();
    const threadId = 'thread-serial';

    const firstFake = new FakeAgentService([
      [
        sessionInit(CLAUDE, 'sess-serial-1', 1),
        textEvent(CLAUDE, 'First invocation output.', 2),
      ],
    ]);
    const secondFake = new FakeAgentService([
      [textEvent(CLAUDE, 'Second invocation output.', 3)],
    ]);

    // Launch both "concurrently"; they share the same mutex + session store.
    const firstRun = drain(
      invokeSingleAgent({
        agentService: firstFake,
        sessionStore,
        sessionMutex,
        agentId: CLAUDE,
        threadId,
        prompt: 'First: establish the session',
        now,
      }),
    );
    const secondRun = drain(
      invokeSingleAgent({
        agentService: secondFake,
        sessionStore,
        sessionMutex,
        agentId: CLAUDE,
        threadId,
        prompt: 'Second: resume the session',
        now,
      }),
    );

    const [firstEvents, secondEvents] = await Promise.all([firstRun, secondRun]);

    expect(firstEvents.map((e) => e.type)).toEqual(['text']);
    expect(secondEvents.map((e) => e.type)).toEqual(['text']);
    // The second call resumed the session the first persisted (serialization proof).
    expect(secondFake.calls[0]?.options?.sessionId).toBe('sess-serial-1');
  });
});
