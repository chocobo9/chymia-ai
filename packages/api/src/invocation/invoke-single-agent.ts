// packages/api/src/invocation/invoke-single-agent.ts
// M3: invokeSingleAgent — drive ONE agent invocation with session resume + retry.
//
// Re-authored from clowder-architecture-design.md §6.2 (invocation lifecycle)
// and clowder-design-supplement.md §A3/§A4/§A9 + 补充 E. Ties together SessionMutex,
// the SessionStore archive, and the pure retry policy (retry.ts), driving an INJECTED
// AgentService (M2). No CLI is spawned here — the AgentService abstraction owns
// that, so tests inject a fake async-generator service and a fake clock.
//
// Flow (§6.2 + 补充 E E3.4):
//   acquire session mutex (per agent+thread)
//   loop:
//     resolve active sessionId (skip when a prior failure sealed it)
//     invoke AgentService; stream events:
//       session_init → SessionStore.startSession (seal prior active + open new)
//       text/tool_use/tool_result/... → yield (mark producedOutput)
//       error → capture, stop streaming this attempt
//     on failure: decideRetry → seal session &/or retry, else yield error & stop
//   finally: release the mutex
//
// 补充 E note: the old resume-token methods (getSessionId / setSessionId-upsert /
// clearSession-delete) became the status-aware archive methods (getActiveSessionId /
// startSession-seal+open / sealActiveSession-seal-keep). A retry that must start a
// fresh CLI session now SEALS the active session (preserving history + digest)
// rather than deleting it.

import type { AgentId, AgentMessage, ISessionStore } from '@choco/shared';
import type { AgentService, InvokeOptions } from '@choco/api/providers/base';
import type { SessionMutex } from '@choco/api/invocation/session-mutex';
import { decideRetry, MAX_RETRIES } from '@choco/api/invocation/retry';

/** Clock used to stamp synthesized error events (injectable for tests). */
export type NowFn = () => number;

/**
 * Logger for surfacing non-fatal driver notes (retry taken, etc.). Optional;
 * omit it and the driver stays silent. Never console.log per CLAUDE.md §2.1.
 */
export type Logger = (event: {
  readonly level: 'info' | 'warn';
  readonly message: string;
  readonly agentId: AgentId;
  readonly threadId: string;
}) => void;

/**
 * Notified with the active CLI session id for this turn as soon as it is known:
 * on resume (an existing active session) it fires before the first invoke; on a
 * fresh conversation it fires when `session_init` opens the new session. The
 * route layer uses this to stamp the turn's session_id onto persisted replies +
 * tool events (补充 E E3.3). May fire more than once across retries (a sealed
 * resume then a fresh session_init); the latest value wins.
 */
export type OnSessionId = (sessionId: string) => void;

/** Parameters for {@link invokeSingleAgent}. */
export interface InvokeSingleAgentParams {
  /** Injected M2 provider that actually runs the agent (spawns the CLI). */
  readonly agentService: AgentService;
  /** The session archive store (resume + seal-on-retry + open-on-init). */
  readonly sessionStore: ISessionStore;
  /** Serializes concurrent invocations on the same (agentId, threadId). */
  readonly sessionMutex: SessionMutex;
  readonly agentId: AgentId;
  readonly threadId: string;
  readonly prompt: string;
  /** Injected system prompt (identity + context). */
  readonly systemPrompt?: string;
  /** MCP callback env vars forwarded to the provider. */
  readonly callbackEnv?: Record<string, string>;
  /** CLI working directory forwarded to the provider. */
  readonly workingDirectory?: string;
  /** Cancellation: aborts the mutex wait AND the provider invocation. */
  readonly signal?: AbortSignal;
  /** Per-provider invoke timeout forwarded to the provider. */
  readonly timeoutMs?: number;
  /** Clock for synthesized error timestamps. Defaults to Date.now. */
  readonly now?: NowFn;
  /** Optional structured logger; omitted = silent. */
  readonly logger?: Logger;
  /** Override max retries (tests/config). Defaults to retry.ts MAX_RETRIES. */
  readonly maxRetries?: number;
  /** Notified with the active session id for this turn (resume / session_init). */
  readonly onSessionId?: OnSessionId;
}

/** Event types that count as user-visible output (forbid retry once seen). */
const OUTPUT_EVENT_TYPES: ReadonlySet<AgentMessage['type']> = new Set([
  'text',
  'tool_use',
  'tool_result',
  'thinking',
]);

/** Build the per-(agent,thread) mutex/session key. */
function sessionKey(agentId: AgentId, threadId: string): string {
  return `${agentId as string}:${threadId}`;
}

/** Wrap a thrown value as a synthesized AgentMessage error event. */
function toErrorEvent(err: unknown, agentId: AgentId, now: NowFn): AgentMessage {
  return {
    type: 'error',
    agentId,
    content: err instanceof Error ? err.message : String(err),
    timestamp: now(),
  };
}

/**
 * Drive one agent invocation to completion, yielding its AgentMessage stream.
 *
 * Acquires the per-(agent,thread) session mutex (so concurrent invocations
 * serialize), resolves+injects the persisted session, drives the injected
 * AgentService, persists the session id from `session_init`, applies the pure
 * retry policy on classified failures, honors `signal`, and always releases the
 * mutex in `finally`.
 *
 * On give-up (unclassified error, retries exhausted, output already produced, or
 * an abort) the captured/synthesized `error` event is yielded, then the
 * generator returns.
 */
export async function* invokeSingleAgent(
  params: InvokeSingleAgentParams,
): AsyncGenerator<AgentMessage> {
  const {
    agentService,
    sessionStore,
    sessionMutex,
    agentId,
    threadId,
    prompt,
  } = params;
  const now: NowFn = params.now ?? Date.now;
  const maxRetries = params.maxRetries ?? MAX_RETRIES;
  const key = sessionKey(agentId, threadId);

  const release = await sessionMutex.acquire(
    key,
    params.signal !== undefined ? { signal: params.signal } : undefined,
  );

  try {
    let attempt = 0;
    // After a failure that sealed the session, the next attempt must invoke
    // without a sessionId (start fresh) even though the prior session row stays
    // sealed in the archive.
    let sealSessionForRetry = false;

    for (;;) {
      // Honor abort between attempts.
      if (params.signal?.aborted === true) {
        yield toErrorEvent(new Error('invocation aborted'), agentId, now);
        return;
      }

      const sessionId = sealSessionForRetry
        ? undefined
        : sessionStore.getActiveSessionId(agentId, threadId);
      // Surface the resumed session id so the route layer can stamp this turn.
      if (sessionId !== undefined) {
        params.onSessionId?.(sessionId);
      }

      const invokeOptions: InvokeOptions = {
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
        ...(params.callbackEnv !== undefined ? { callbackEnv: params.callbackEnv } : {}),
        ...(params.workingDirectory !== undefined
          ? { workingDirectory: params.workingDirectory }
          : {}),
        ...(params.signal !== undefined ? { signal: params.signal } : {}),
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
      };

      let producedOutput = false;
      // Persist the session id from session_init at most once per attempt; the
      // CLI emits it once at the start of a conversation.
      let sessionPersisted = false;
      let caughtError: AgentMessage | undefined;

      try {
        for await (const event of agentService.invoke(prompt, invokeOptions)) {
          if (event.type === 'session_init') {
            if (!sessionPersisted && event.content !== undefined && event.content !== '') {
              // Open a new active session (seals the prior active one for this
              // (agent, thread) + computes its digest — 补充 E E3.4).
              sessionStore.startSession(agentId, threadId, event.content);
              sessionPersisted = true;
              params.onSessionId?.(event.content);
            }
            // session_init is an internal lifecycle signal; do not forward it.
            continue;
          }
          if (event.type === 'error') {
            caughtError = event;
            break;
          }
          if (OUTPUT_EVENT_TYPES.has(event.type)) {
            producedOutput = true;
          }
          yield event;
        }
      } catch (err) {
        // A thrown error (provider crash / abort) becomes an error event so the
        // retry policy can classify it uniformly with yielded error events.
        caughtError = toErrorEvent(err, agentId, now);
      }

      if (caughtError === undefined) {
        return; // success — stream drained cleanly
      }

      const decision = decideRetry({
        errorMessage: caughtError.content,
        attempt,
        producedOutput,
        maxRetries,
      });

      if (decision.action === 'stop') {
        yield caughtError;
        return;
      }

      if (decision.clearSession) {
        // Seal (not delete) the active session before retrying fresh — history +
        // digest are preserved in the archive (补充 E E3.4).
        sessionStore.sealActiveSession(agentId, threadId);
        sealSessionForRetry = true;
      } else {
        // transient → retry as-is, keeping any active session.
        sealSessionForRetry = false;
      }

      attempt += 1;
      params.logger?.({
        level: 'warn',
        message: `retry ${attempt}/${maxRetries} (class=${decision.errorClass}, sealSession=${String(decision.clearSession)})`,
        agentId,
        threadId,
      });
    }
  } finally {
    release();
  }
}
