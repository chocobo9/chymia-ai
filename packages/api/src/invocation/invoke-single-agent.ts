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

export type InvocationTimingEvent =
  | { readonly type: 'mutex_acquired'; readonly elapsedMs: number }
  | { readonly type: 'attempt_start'; readonly elapsedMs: 0; readonly attempt: number }
  | { readonly type: 'first_provider_event'; readonly elapsedMs: number; readonly attempt: number }
  | { readonly type: 'first_output'; readonly elapsedMs: number; readonly attempt: number }
  | { readonly type: 'attempt_end'; readonly elapsedMs: number; readonly attempt: number };

export type OnInvocationTiming = (event: InvocationTimingEvent) => void;

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
  /** Emits coarse phase timings for observability; ignored by the invoke logic. */
  readonly onTiming?: OnInvocationTiming;
}

/**
 * Event types that count as REAL content output (a retry after these would
 * duplicate model output, so retry is forbidden). Excludes 'thinking' on purpose
 * (Clowder attemptHasContentOutput): a thinking-only (form A) turn produced NO
 * usable content and must stay retryable / relay-able. thinking is still streamed
 * to the user — it simply does not block recovery.
 */
const CONTENT_OUTPUT_TYPES: ReadonlySet<AgentMessage['type']> = new Set([
  'text',
  'tool_use',
  'tool_result',
]);

/** F215: user-visible card shown when the malformed relay kicks in. */
const MALFORMED_RELAY_CARD = '主模型多次输出无效（form A），正在切换备用模型重试……';

/** True when an event is the internal form-A detection signal (system_info). */
function isMalformedDetectedSignal(event: AgentMessage): boolean {
  if (event.type !== 'system_info' || event.content === undefined) {
    return false;
  }
  try {
    return (JSON.parse(event.content) as { type?: unknown }).type === 'malformed_toolcall_detected';
  } catch {
    return false;
  }
}

/**
 * F215 AC-C3/D1: emit the malformed relay sequence after fresh-retry is exhausted —
 * a user-visible card, then the internal `malformed_toolcall_relay_46` signal
 * (route-serial pushes the backup model cat), then an explicit final error.
 */
function* emitMalformedRelay(agentId: AgentId, now: NowFn): Generator<AgentMessage> {
  yield { type: 'text', agentId, content: MALFORMED_RELAY_CARD, timestamp: now() };
  yield {
    type: 'system_info',
    agentId,
    content: JSON.stringify({ type: 'malformed_toolcall_relay_46' }),
    timestamp: now(),
  };
  yield {
    type: 'error',
    agentId,
    content: 'malformed_toolcall: 主模型 fresh-context 重试仍失败，已切换备用模型接力',
    errorCode: 'malformed_toolcall',
    timestamp: now(),
  };
}

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
 * invocation-level hard timeout 倍数。对齐 Clowder invoke-single-cat
 * (INVOCATION_TIMEOUT_MULTIPLIER=2)：invocation 超时 = 基准 timeout × 2，确保它晚于
 * 内层 provider CLI timeout，作为「CLI timeout 也没触发」时的最后兜底，不抢跑。
 */
const INVOCATION_TIMEOUT_MULTIPLIER = 2;

/**
 * params.timeoutMs 未给（或 ≤0）时的 invocation 超时基准（ms）。对齐 Clowder
 * DEFAULT_CLI_TIMEOUT_MS 兜底语义：即便不传/关闭 CLI 超时，invocation 仍有硬上限，
 * 避免卡死的 provider 永久占用 SessionMutex（飞书后续消息卡死的一环）。
 */
const DEFAULT_INVOCATION_TIMEOUT_BASE_MS = 30 * 60 * 1000;

/**
 * 把 async iterator 的 .next() 与 AbortSignal 竞速：signal 先 fire 则 reject（抛出中止
 * 原因），否则返回 iterator 结果。必要原因（对齐 Clowder invoke-single-cat.abortableNext）：
 * `for await` 阻塞在 gen.next() 上无法被中断——provider CLI 卡死（gen 永不 resolve）时，
 * invocation 超时与用户取消都失效，SessionMutex 永久不释放。
 */
function abortableNext<T>(
  iter: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error('aborted'));
  }
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    iter.next().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
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

  // invocation-level hard timeout（独立于 provider CLI timeout）。倍数兜底 + 活动
  // reset + unref，对齐 Clowder invoke-single-cat。兜住「provider gen 卡死、内层 CLI
  // timeout 也没触发」的情形：否则卡死的 invocation 永不释放 SessionMutex，后续同
  // (agent,thread) 消息全部排队卡死（飞书后续消息卡死的一环）。
  const baseTimeoutMs =
    params.timeoutMs !== undefined && params.timeoutMs > 0
      ? params.timeoutMs
      : DEFAULT_INVOCATION_TIMEOUT_BASE_MS;
  const invocationTimeoutMs = baseTimeoutMs * INVOCATION_TIMEOUT_MULTIPLIER;
  const invocationAc = new AbortController();
  let invocationTimer: ReturnType<typeof setTimeout> | null = null;
  const resetInvocationTimeout = (): void => {
    if (invocationTimer) clearTimeout(invocationTimer);
    const t = setTimeout(() => {
      invocationAc.abort(new Error('invocation_timeout'));
    }, invocationTimeoutMs);
    // unref so the pending timer never keeps the process alive on its own.
    if (typeof t.unref === 'function') t.unref();
    invocationTimer = t;
  };
  resetInvocationTimeout();

  // 合并 caller signal（用户取消）+ invocation timeout —— 任一 fire 都中止本次调用。
  const signal: AbortSignal = params.signal
    ? AbortSignal.any([params.signal, invocationAc.signal])
    : invocationAc.signal;

  let release: (() => void) | undefined;
  try {
    const mutexWaitStartedAt = now();
    release = await sessionMutex.acquire(key, { signal });
    params.onTiming?.({
      type: 'mutex_acquired',
      elapsedMs: Math.max(0, now() - mutexWaitStartedAt),
    });

    let attempt = 0;
    // After a failure that sealed the session, the next attempt must invoke
    // without a sessionId (start fresh) even though the prior session row stays
    // sealed in the archive.
    let sealSessionForRetry = false;

    for (;;) {
      // Honor abort (caller cancel or invocation timeout) between attempts.
      if (signal.aborted) {
        yield toErrorEvent(signal.reason ?? new Error('invocation aborted'), agentId, now);
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
        // 合并 signal（含 invocation timeout）下传 provider，使超时/取消能 kill CLI 子进程。
        signal,
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
      };

      let producedOutput = false;
      // Persist the session id from session_init at most once per attempt; the
      // CLI emits it once at the start of a conversation.
      let sessionPersisted = false;
      let caughtError: AgentMessage | undefined;
      const attemptStartedAt = now();
      let sawFirstProviderEvent = false;
      let sawFirstOutput = false;
      params.onTiming?.({ type: 'attempt_start', elapsedMs: 0, attempt });

      // abortableNext（不是 for await）：for await 阻塞在 gen.next() 上无法中断，
      // provider CLI 卡死时 invocation timeout / 取消都失效。逐个 next 与 signal 竞速。
      const iter = agentService.invoke(prompt, invokeOptions)[Symbol.asyncIterator]();
      try {
        for (;;) {
          const result = await abortableNext(iter, signal);
          if (result.done) break;
          const event = result.value;
          // 任一 provider 事件 = 活动，续期 invocation timeout（持续卡死才会计满）。
          resetInvocationTimeout();
          if (!sawFirstProviderEvent) {
            sawFirstProviderEvent = true;
            params.onTiming?.({
              type: 'first_provider_event',
              elapsedMs: Math.max(0, now() - attemptStartedAt),
              attempt,
            });
          }
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
          // F215 AC-C1/C2: suppress the internal form-A detection signal — it never
          // reaches the user; it only tells us a malformed turn is coming so the
          // error below can drive seal + fresh-retry.
          if (event.type === 'system_info' && isMalformedDetectedSignal(event)) {
            continue;
          }
          if (event.type === 'error') {
            caughtError = event;
            break;
          }
          if (CONTENT_OUTPUT_TYPES.has(event.type)) {
            producedOutput = true;
            if (!sawFirstOutput) {
              sawFirstOutput = true;
              params.onTiming?.({
                type: 'first_output',
                elapsedMs: Math.max(0, now() - attemptStartedAt),
                attempt,
              });
            }
          }
          yield event;
        }
      } catch (err) {
        // A thrown error (provider crash / abort / invocation timeout) becomes an
        // error event so the retry policy can classify it uniformly.
        caughtError = toErrorEvent(err, agentId, now);
      } finally {
        params.onTiming?.({
          type: 'attempt_end',
          elapsedMs: Math.max(0, now() - attemptStartedAt),
          attempt,
        });
      }

      if (caughtError === undefined) {
        return; // success — stream drained cleanly
      }

      // invocation timeout / caller abort → hard stop（不 retry）：已等满硬上限或被
      // 用户主动取消，重试无意义且会再占一轮 mutex。
      if (signal.aborted) {
        yield caughtError;
        return;
      }

      const decision = decideRetry({
        errorMessage: caughtError.content,
        attempt,
        producedOutput,
        maxRetries,
      });

      if (decision.action === 'stop') {
        // F215 AC-C3/D1: malformed retry exhausted → emit the user-visible relay card,
        // the internal relay signal (route-serial pushes the backup model cat), then
        // an explicit final error — NOT a silent give-up nor the raw malformed error.
        if (decision.errorClass === 'malformed') {
          yield* emitMalformedRelay(agentId, now);
          return;
        }
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
  } catch (err) {
    // mutex.acquire 在排队中被 signal 中止（caller 取消 / invocation timeout）→ 干净
    // 收尾：yield 一个 error 事件而非把异常抛给调用方。其它异常照常上抛。
    if (signal.aborted) {
      yield toErrorEvent(signal.reason ?? new Error('invocation aborted'), agentId, now);
      return;
    }
    throw err;
  } finally {
    if (invocationTimer) clearTimeout(invocationTimer);
    release?.();
  }
}
