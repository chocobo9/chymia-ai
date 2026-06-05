// M9 useSocket — owns the Socket.io connection and wires the four server→client
// events (§C2) into the Zustand stores.
//
//   agent_event   (AgentMessage)  → chatStore.applyAgentEvent / clearStreaming
//   thread_update (Thread)        → chatStore.upsertThread
//   agent_status  (AgentState)    → agentStore.applyAgentStatus
//   error         ({message})     → onError callback (surfaced by the UI)
//
// The client joins exactly one room at a time (the active thread), so an
// incoming agent_event belongs to that room — AgentMessage is flat and carries
// no threadId (the room is the scope). We therefore resolve the thread from a
// `getActiveThreadId` accessor. On the active thread changing we leave the old
// room and join the new one (client→server join_thread / leave_thread).
//
// The socket is created via an injectable connector so tests can pass a mock
// socket.io-client without touching the network.

import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import type { AgentMessage, AgentState, StoredMessage, Thread } from '@choco/shared';
import { webConfig } from '../lib/config.js';
import { useChatStore } from '../stores/chat-store.js';
import { useAgentStore } from '../stores/agent-store.js';

/** Client→server event names (must match M8 SocketManager CLIENT_EVENTS). */
export const CLIENT_EVENTS = {
  joinThread: 'join_thread',
  leaveThread: 'leave_thread',
  cancel: 'cancel',
} as const;

/** Server→client event names (must match M8 SocketManager SERVER_EVENTS). */
export const SERVER_EVENTS = {
  agentEvent: 'agent_event',
  threadUpdate: 'thread_update',
  agentStatus: 'agent_status',
  error: 'error',
  /** An off-web platform (飞书/etc.) USER message to mirror into the transcript. */
  threadMessage: 'thread_message',
} as const;

/** Minimal socket surface the hook depends on (eases mocking). */
export interface SocketLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener?: (...args: unknown[]) => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
  disconnect(): unknown;
}

/** Factory for a socket connection (default: socket.io-client to socketUrl). */
export type SocketConnector = (url: string) => SocketLike;

const defaultConnector: SocketConnector = (url) =>
  io(url, { transports: ['websocket'], autoConnect: true }) as unknown as SocketLike;

/** Default text for an error frame that carried no reason. */
const DEFAULT_ERROR_TEXT = '调用失败';

/** The user-facing text for an error/notice frame (its `content`, or a fallback). */
function noticeText(event: AgentMessage): string {
  const content = event.content;
  if (typeof content === 'string' && content.length > 0) return content;
  return event.type === 'error' ? DEFAULT_ERROR_TEXT : '系统通知';
}

/**
 * Stable id for a notice/error so a re-delivered frame dedupes. Prefers the
 * invocationId (one terminal frame per invocation); else falls back to
 * agent+type+timestamp.
 */
function noticeId(event: AgentMessage): string {
  const inv = event.invocationId;
  if (typeof inv === 'string' && inv.length > 0) {
    return `${event.type}:${inv}`;
  }
  return `${event.type}:${event.agentId as string}:${event.timestamp}`;
}

export interface RegisterListenersOptions {
  /** Returns the thread the events should be scoped to (the joined room). */
  readonly getActiveThreadId: () => string | null;
  readonly onError?: (message: string) => void;
}

/**
 * registerSocketListeners — attach the server→client handlers that dispatch into
 * the stores. Exported so it can be unit-tested directly against a mock socket
 * without React. Returns a disposer that removes the listeners.
 */
export function registerSocketListeners(
  socket: SocketLike,
  options: RegisterListenersOptions,
): () => void {
  const { getActiveThreadId, onError } = options;

  const onAgentEvent = (...args: unknown[]): void => {
    const event = args[0] as AgentMessage;
    const threadId = getActiveThreadId();
    if (threadId === null) return;
    const chat = useChatStore.getState();
    // §D: an `error` frame (an agent call failed) or a `system_info` notice (an
    // explicit @mention of an unavailable agent) must NOT be silently dropped —
    // a turn that yields only one of these would otherwise leave the user staring
    // at silence. Clear ONLY THIS agent's live stream (NOT the whole thread — in a
    // parallel @all turn a sibling may still be streaming) AND add a VISIBLE
    // notice/error bubble to the transcript.
    if (event.type === 'error' || event.type === 'system_info') {
      chat.clearStreamingMessage(threadId, event);
      chat.addNotice(threadId, {
        id: noticeId(event),
        agentId: event.agentId,
        kind: event.type === 'error' ? 'error' : 'notice',
        text: noticeText(event),
        timestamp: event.timestamp,
      });
      return;
    }
    // `done` ends ONE agent's turn — SETTLE (don't drop) that agent's stream so
    // its reply stays visible immediately, instead of vanishing until the
    // end-of-turn POST persists every agent's reply at once. A faster sibling
    // finishing first never touches a slower agent's still-live output.
    if (event.type === 'done') {
      chat.settleStreamingMessage(threadId, event);
      return;
    }
    chat.applyAgentEvent(threadId, event);
  };

  const onThreadUpdate = (...args: unknown[]): void => {
    const thread = args[0] as Thread;
    if (thread !== null && typeof thread === 'object' && 'id' in thread) {
      useChatStore.getState().upsertThread(thread);
    }
  };

  // An off-web platform user message (飞书/等) → render it into the transcript.
  // addMessage dedupes by id, so a re-delivered frame is a no-op. The message
  // carries its own threadId; we still scope to the active room (the broadcast
  // only reaches the joined thread anyway).
  const onThreadMessage = (...args: unknown[]): void => {
    const message = args[0] as StoredMessage;
    if (message !== null && typeof message === 'object' && 'id' in message && 'threadId' in message) {
      useChatStore.getState().addMessage(message);
    }
  };

  const onAgentStatus = (...args: unknown[]): void => {
    const state = args[0] as AgentState;
    if (state !== null && typeof state === 'object' && 'id' in state) {
      useAgentStore.getState().applyAgentStatus(state);
    }
  };

  const onErrorEvent = (...args: unknown[]): void => {
    const payload = args[0] as { message?: string };
    onError?.(payload?.message ?? 'socket error');
  };

  socket.on(SERVER_EVENTS.agentEvent, onAgentEvent);
  socket.on(SERVER_EVENTS.threadUpdate, onThreadUpdate);
  socket.on(SERVER_EVENTS.threadMessage, onThreadMessage);
  socket.on(SERVER_EVENTS.agentStatus, onAgentStatus);
  socket.on(SERVER_EVENTS.error, onErrorEvent);

  return () => {
    socket.off(SERVER_EVENTS.agentEvent, onAgentEvent);
    socket.off(SERVER_EVENTS.threadUpdate, onThreadUpdate);
    socket.off(SERVER_EVENTS.threadMessage, onThreadMessage);
    socket.off(SERVER_EVENTS.agentStatus, onAgentStatus);
    socket.off(SERVER_EVENTS.error, onErrorEvent);
  };
}

export interface UseSocketOptions {
  readonly activeThreadId: string | null;
  readonly connector?: SocketConnector;
  readonly url?: string;
  readonly onError?: (message: string) => void;
}

/**
 * useSocket — connect on mount, (re)join the active thread room, dispatch
 * incoming events to the stores, and clean up on unmount. Returns a `cancel`
 * function the UI can call to abort the current turn.
 */
export function useSocket(options: UseSocketOptions): { cancel: (agentId?: string) => void } {
  const { activeThreadId, onError } = options;
  const connector = options.connector ?? defaultConnector;
  const url = options.url ?? webConfig.socketUrl;

  const socketRef = useRef<SocketLike | null>(null);
  const joinedThreadRef = useRef<string | null>(null);
  // Keep the latest active thread readable from the (stable) listeners.
  const activeThreadRef = useRef<string | null>(activeThreadId);
  activeThreadRef.current = activeThreadId;

  // Connect once (per connector/url) and register store-dispatching listeners.
  useEffect(() => {
    const socket = connector(url);
    socketRef.current = socket;
    const dispose = registerSocketListeners(socket, {
      getActiveThreadId: () => activeThreadRef.current,
      onError,
    });
    return () => {
      dispose();
      socket.disconnect();
      socketRef.current = null;
      joinedThreadRef.current = null;
    };
  }, [connector, url, onError]);

  // Join/leave rooms as the active thread changes.
  useEffect(() => {
    const socket = socketRef.current;
    if (socket === null) return;
    const previous = joinedThreadRef.current;
    if (previous !== null && previous !== activeThreadId) {
      socket.emit(CLIENT_EVENTS.leaveThread, { threadId: previous });
    }
    if (activeThreadId !== null && activeThreadId !== previous) {
      socket.emit(CLIENT_EVENTS.joinThread, { threadId: activeThreadId });
    }
    joinedThreadRef.current = activeThreadId;
  }, [activeThreadId]);

  // Stop a turn. With an agentId → stop just that agent (targeted); without →
  // stop every agent on the thread (stop-all). The composer's 停止 button passes
  // the lone working agent's id when exactly one is active, else nothing.
  const cancel = (agentId?: string): void => {
    const socket = socketRef.current;
    const threadId = activeThreadRef.current;
    if (socket !== null && threadId !== null) {
      socket.emit(CLIENT_EVENTS.cancel, agentId !== undefined ? { threadId, agentId } : { threadId });
    }
  };

  return { cancel };
}
