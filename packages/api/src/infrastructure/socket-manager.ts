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
import type { AgentMessage, AgentState, Thread } from '@clowder/shared';
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
} as const;

/** Payload shape for the join/leave/cancel client events. */
interface ThreadScopedPayload {
  readonly threadId?: unknown;
}

/**
 * AgentMessage event types that are high-frequency and therefore rate-limited.
 * Terminal/lifecycle events (done/error/a2a_handoff/system_info/session_init)
 * always go through so the client never misses a turn boundary.
 */
const RATE_LIMITED_EVENT_TYPES: ReadonlySet<AgentMessage['type']> = new Set([
  'text',
  'tool_use',
  'tool_result',
  'thinking',
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
  /** Active cancel controllers per thread, so `cancel` can abort a live route. */
  private readonly cancelControllers = new Map<string, Set<AbortController>>();

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
        if (threadId !== undefined) this.fireCancel(threadId);
      });
    });
  }

  /** Abort every live route registered for a thread. */
  private fireCancel(threadId: string): void {
    const set = this.cancelControllers.get(threadId);
    if (set === undefined) return;
    for (const controller of set) {
      controller.abort();
    }
  }
}

/** Narrow an untrusted client payload to a non-empty threadId string. */
function extractThreadId(payload: ThreadScopedPayload): string | undefined {
  const threadId = payload?.threadId;
  return typeof threadId === 'string' && threadId.length > 0 ? threadId : undefined;
}
