// M8 SocketManager — Socket.io room management + ordered, rate-limited broadcast.
//
// Source: clowder-design-supplement.md §C2 (Socket.io protocol):
//   Client → Server: join_thread / leave_thread / cancel ({ threadId })
//   Server → Client (room = threadId): agent_event / thread_update /
//                                      agent_status / error
//
// Rooms isolate threads (a client only receives events for threads it joined).
// Outbound broadcasts are funnelled through the ThreadSequencer (in-order per
// thread) and gated by the BroadcastRateMonitor (high-frequency events only;
// terminal/lifecycle events bypass the limiter). `cancel` fires a per-thread
// AbortSignal that message-routes wires into AgentRouter.route(). DI everything
// (supplement D) — the Server + helpers are injected, nothing global.

import type { Server as SocketIoServer, Socket } from 'socket.io';
import type { AgentMessage, AgentState, SopViolationPayload, Thread } from '@choco/shared';
import { ThreadSequencer } from './thread-sequencer.js';
import { BroadcastRateMonitor } from './broadcast-rate-monitor.js';

/** Client→server event names (§C2). */
export const CLIENT_EVENTS = {
  joinThread: 'join_thread',
  leaveThread: 'leave_thread',
  cancel: 'cancel',
} as const;

/** Server→client event names (§C2). */
export const SERVER_EVENTS = {
  agentEvent: 'agent_event',
  threadUpdate: 'thread_update',
  agentStatus: 'agent_status',
  error: 'error',
  /** M12 SOP-Cycle-2 advisory: a thread left a stage with open SOP violations. */
  sopViolation: 'sop_violation',
} as const;

/**
 * Payload shape for the join/leave/cancel client events. `agentId` is only
 * meaningful on `cancel`: present → stop just THAT agent (targeted); absent →
 * stop the whole thread (every in-flight agent).
 */
interface ThreadScopedPayload {
  readonly threadId?: unknown;
  readonly agentId?: unknown;
}

/**
 * AgentMessage event types that are high-frequency and therefore rate-limited.
 * ONLY the noisy tool events — a fast agent can fire many tool_use/tool_result
 * frames that each spawn DOM (the original "防止高频 tool_use 事件打爆前端" concern).
 *
 * `text` and `thinking` are DELIBERATELY NOT here: they are the user-visible
 * streaming output. Dropping a throttled text frame is NOT backfilled mid-stream
 * (流式进行中不补发), so rate-limiting text made a non-trivial reply appear only at
 * turn end (via the POST reconcile) — i.e. "streaming didn't work". The token
 * stream from a CLI is naturally paced; we never throttle it.
 */
const RATE_LIMITED_EVENT_TYPES: ReadonlySet<AgentMessage['type']> = new Set([
  'tool_use',
  'tool_result',
]);

export interface SocketManagerOptions {
  /** Ordered-broadcast helper (default: a fresh ThreadSequencer). */
  readonly sequencer?: ThreadSequencer;
  /** Broadcast rate limiter (default: a fresh BroadcastRateMonitor). */
  readonly rateMonitor?: BroadcastRateMonitor;
}

/**
 * SocketManager — wraps a Socket.io Server with thread-room semantics and the
 * ordered/rate-limited broadcast pipeline.
 */
export class SocketManager {
  private readonly io: SocketIoServer;
  private readonly sequencer: ThreadSequencer;
  private readonly rateMonitor: BroadcastRateMonitor;
  /**
   * Per-route BATCH cancel controllers per thread (a Set so the main user route
   * AND a nested A2A post_message fan-out on the same thread each get their own).
   * Aborted by a stop-ALL; also the serial-chain loop guard.
   */
  private readonly cancelControllers = new Map<string, Set<AbortController>>();
  /**
   * Per-(thread, agentId) cancel controllers — the TARGETED-stop registry. Lets a
   * stop abort ONE agent without touching its siblings (the collateral-cancel
   * fix). Populated lazily by the main route's signalForAgent; a stop-all aborts
   * these too, a targeted stop aborts only the named agent's controller.
   */
  private readonly agentCancelControllers = new Map<string, Map<string, AbortController>>();

  constructor(io: SocketIoServer, options?: SocketManagerOptions) {
    this.io = io;
    this.sequencer = options?.sequencer ?? new ThreadSequencer();
    this.rateMonitor = options?.rateMonitor ?? new BroadcastRateMonitor();
    this.registerConnectionHandler();
  }

  /**
   * Register a cancel controller for a thread and return it. The controller's
   * signal aborts when any client emits `cancel` for that thread. Callers MUST
   * call {@link releaseCancelController} in a finally to avoid leaking.
   */
  registerCancel(threadId: string): AbortController {
    const controller = new AbortController();
    const set = this.cancelControllers.get(threadId) ?? new Set<AbortController>();
    set.add(controller);
    this.cancelControllers.set(threadId, set);
    return controller;
  }

  /** Unregister a previously registered cancel controller. */
  releaseCancelController(threadId: string, controller: AbortController): void {
    const set = this.cancelControllers.get(threadId);
    if (set === undefined) return;
    set.delete(controller);
    if (set.size === 0) this.cancelControllers.delete(threadId);
  }

  /**
   * Register (idempotent) a per-AGENT cancel controller for `(threadId, agentId)`
   * and return it — the targeted-stop handle. Reused across calls within a turn
   * (one controller per agent). Callers release it via {@link releaseAgentCancel}.
   */
  registerAgentCancel(threadId: string, agentId: string): AbortController {
    const byAgent = this.agentCancelControllers.get(threadId) ?? new Map<string, AbortController>();
    let controller = byAgent.get(agentId);
    if (controller === undefined) {
      controller = new AbortController();
      byAgent.set(agentId, controller);
    }
    this.agentCancelControllers.set(threadId, byAgent);
    return controller;
  }

  /** Unregister a per-agent cancel controller (turn end). */
  releaseAgentCancel(threadId: string, agentId: string): void {
    const byAgent = this.agentCancelControllers.get(threadId);
    if (byAgent === undefined) return;
    byAgent.delete(agentId);
    if (byAgent.size === 0) this.agentCancelControllers.delete(threadId);
  }

  /** Broadcast an agent_event to a thread room (ordered; rate-limited if hot). */
  broadcastAgentEvent(threadId: string, message: AgentMessage): Promise<void> {
    if (
      RATE_LIMITED_EVENT_TYPES.has(message.type) &&
      !this.rateMonitor.shouldBroadcast(threadId)
    ) {
      // Throttled: drop this high-frequency frame (the full reply is persisted
      // by message-routes regardless — §C2 "流式进行中的消息不补发").
      return Promise.resolve();
    }
    return this.sequencer.enqueue(threadId, () => {
      this.io.to(threadId).emit(SERVER_EVENTS.agentEvent, message);
    });
  }

  /** Broadcast a thread_update (CRUD / lastActive change) to a thread room. */
  broadcastThreadUpdate(threadId: string, thread: Thread): Promise<void> {
    return this.sequencer.enqueue(threadId, () => {
      this.io.to(threadId).emit(SERVER_EVENTS.threadUpdate, thread);
    });
  }

  /** Broadcast an agent_status change to a thread room. */
  broadcastAgentStatus(threadId: string, state: AgentState): Promise<void> {
    return this.sequencer.enqueue(threadId, () => {
      this.io.to(threadId).emit(SERVER_EVENTS.agentStatus, state);
    });
  }

  /** Broadcast an error to a thread room. */
  broadcastError(threadId: string, message: string): Promise<void> {
    return this.sequencer.enqueue(threadId, () => {
      this.io.to(threadId).emit(SERVER_EVENTS.error, { message });
    });
  }

  /**
   * Broadcast an advisory SOP violation (M12 SOP-Cycle-2) to a thread room. Fired
   * when a thread leaves a stage whose post-hoc trace evaluation found open
   * violations — advisory only ("只提示不拦截"), never a gate. Ordered like the
   * other lifecycle broadcasts (not rate-limited; it is a once-per-transition event).
   */
  broadcastSopViolation(threadId: string, payload: SopViolationPayload): Promise<void> {
    return this.sequencer.enqueue(threadId, () => {
      this.io.to(threadId).emit(SERVER_EVENTS.sopViolation, payload);
    });
  }

  private registerConnectionHandler(): void {
    this.io.on('connection', (socket: Socket) => {
      socket.on(CLIENT_EVENTS.joinThread, (payload: ThreadScopedPayload) => {
        const threadId = extractThreadId(payload);
        if (threadId !== undefined) void socket.join(threadId);
      });

      socket.on(CLIENT_EVENTS.leaveThread, (payload: ThreadScopedPayload) => {
        const threadId = extractThreadId(payload);
        if (threadId !== undefined) void socket.leave(threadId);
      });

      socket.on(CLIENT_EVENTS.cancel, (payload: ThreadScopedPayload) => {
        const threadId = extractThreadId(payload);
        if (threadId === undefined) return;
        const agentId = extractAgentId(payload);
        if (agentId !== undefined) this.cancelAgent(threadId, agentId);
        else this.cancelThread(threadId);
      });
    });
  }

  /**
   * Abort ONE agent's in-flight invocation on a thread (targeted stop) — its
   * siblings keep running. No-op if that agent isn't currently registered.
   */
  private cancelAgent(threadId: string, agentId: string): void {
    this.agentCancelControllers.get(threadId)?.get(agentId)?.abort();
  }

  /**
   * Abort EVERY live route on a thread (stop-all): all batch controllers (so a
   * serial chain stops spawning + a not-yet-started agent never starts) AND every
   * per-agent controller (so all running agents abort).
   */
  private cancelThread(threadId: string): void {
    for (const controller of this.cancelControllers.get(threadId) ?? []) {
      controller.abort();
    }
    for (const controller of (this.agentCancelControllers.get(threadId) ?? new Map()).values()) {
      controller.abort();
    }
  }
}

/** Narrow an untrusted client payload to a non-empty threadId string. */
function extractThreadId(payload: ThreadScopedPayload): string | undefined {
  const threadId = payload?.threadId;
  return typeof threadId === 'string' && threadId.length > 0 ? threadId : undefined;
}

/** Narrow an untrusted cancel payload's optional agentId (targeted stop) to a string. */
function extractAgentId(payload: ThreadScopedPayload): string | undefined {
  const agentId = payload?.agentId;
  return typeof agentId === 'string' && agentId.length > 0 ? agentId : undefined;
}
