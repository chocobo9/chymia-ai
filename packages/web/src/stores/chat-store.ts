// M9 chat store — Zustand state for threads, per-thread messages, the active
// thread, and the in-flight streaming message assembled from `agent_event`.
//
// Immutability (CLAUDE.md coding-style): every action returns a NEW state object
// and NEW nested collections — we never mutate arrays/maps in place.
//
// Streaming model (G8): the synchronous POST /messages result is NOT how the UI
// renders the turn. As `text`/`tool_use`/`thinking` frames arrive over the
// socket we fold them into ONE evolving StreamingMessage per (thread, agent,
// invocation). `text` deltas concatenate; `thinking` deltas concatenate; each
// `tool_use` appends a block. On `done` we drop the streaming buffer; the final
// persisted StoredMessage(s) arrive via reconcileReplies (from the POST result)
// or a future history refresh.

import { create } from 'zustand';
import type { AgentId, AgentMessage, StoredMessage, Thread } from '@clowder/shared';

/** A single tool invocation captured while streaming. */
export interface StreamingToolBlock {
  readonly toolUseId?: string;
  readonly toolName: string;
  readonly toolInput?: Record<string, unknown>;
}

/**
 * StreamingMessage — the live, not-yet-persisted message for one agent turn.
 * Keyed per thread by streamingKey() so concurrent (parallel) agents don't
 * clobber each other.
 */
export interface StreamingMessage {
  readonly key: string;
  readonly agentId: AgentId;
  readonly invocationId?: string;
  readonly text: string;
  readonly thinking: string;
  readonly toolBlocks: readonly StreamingToolBlock[];
  readonly startedAt: number;
}

interface ChatState {
  readonly threads: readonly Thread[];
  /** Persisted messages per threadId. */
  readonly messagesByThread: Readonly<Record<string, readonly StoredMessage[]>>;
  /** Live streaming messages per threadId (one per agent turn). */
  readonly streamingByThread: Readonly<Record<string, readonly StreamingMessage[]>>;
  readonly activeThreadId: string | null;

  // Thread actions.
  setThreads(threads: readonly Thread[]): void;
  upsertThread(thread: Thread): void;
  removeThread(threadId: string): void;
  setActiveThread(threadId: string | null): void;

  // Message actions.
  setMessages(threadId: string, messages: readonly StoredMessage[]): void;
  addMessage(message: StoredMessage): void;
  reconcileReplies(replies: readonly StoredMessage[]): void;

  // Streaming actions (driven by agent_event frames).
  applyAgentEvent(threadId: string, event: AgentMessage): void;
  clearStreaming(threadId: string): void;
}

/** Stable per-turn key so parallel agent streams stay separate. */
function streamingKey(event: AgentMessage): string {
  return `${event.agentId as string}:${event.invocationId ?? 'default'}`;
}

function emptyStreaming(event: AgentMessage): StreamingMessage {
  return {
    key: streamingKey(event),
    agentId: event.agentId,
    invocationId: event.invocationId,
    text: '',
    thinking: '',
    toolBlocks: [],
    startedAt: event.timestamp,
  };
}

/** Fold one agent_event into a streaming message, returning a NEW message. */
function foldEvent(current: StreamingMessage, event: AgentMessage): StreamingMessage {
  switch (event.type) {
    case 'text':
      return { ...current, text: current.text + (event.content ?? '') };
    case 'thinking':
      return { ...current, thinking: current.thinking + (event.content ?? '') };
    case 'tool_use':
      return {
        ...current,
        toolBlocks: [
          ...current.toolBlocks,
          {
            toolUseId: event.toolUseId,
            toolName: event.toolName ?? 'tool',
            toolInput: event.toolInput,
          },
        ],
      };
    default:
      return current;
  }
}

/** Append or replace a streaming message by key (immutably). */
function withStreamingMessage(
  list: readonly StreamingMessage[],
  next: StreamingMessage,
): readonly StreamingMessage[] {
  const idx = list.findIndex((m) => m.key === next.key);
  if (idx === -1) return [...list, next];
  return list.map((m, i) => (i === idx ? next : m));
}

/** True for event types that should NOT create/extend a streaming buffer. */
function isStreamingFrame(type: AgentMessage['type']): boolean {
  return type === 'text' || type === 'thinking' || type === 'tool_use';
}

export const useChatStore = create<ChatState>((set) => ({
  threads: [],
  messagesByThread: {},
  streamingByThread: {},
  activeThreadId: null,

  setThreads: (threads) => set({ threads }),

  upsertThread: (thread) =>
    set((state) => {
      const idx = state.threads.findIndex((t) => t.id === thread.id);
      const threads =
        idx === -1
          ? [thread, ...state.threads]
          : state.threads.map((t, i) => (i === idx ? thread : t));
      return { threads };
    }),

  removeThread: (threadId) =>
    set((state) => {
      const threads = state.threads.filter((t) => t.id !== threadId);
      const { [threadId]: _removedMsgs, ...messagesByThread } = state.messagesByThread;
      const { [threadId]: _removedStream, ...streamingByThread } = state.streamingByThread;
      const activeThreadId =
        state.activeThreadId === threadId ? null : state.activeThreadId;
      return { threads, messagesByThread, streamingByThread, activeThreadId };
    }),

  setActiveThread: (threadId) => set({ activeThreadId: threadId }),

  setMessages: (threadId, messages) =>
    set((state) => ({
      messagesByThread: { ...state.messagesByThread, [threadId]: messages },
    })),

  addMessage: (message) =>
    set((state) => {
      const existing = state.messagesByThread[message.threadId] ?? [];
      if (existing.some((m) => m.id === message.id)) return {};
      return {
        messagesByThread: {
          ...state.messagesByThread,
          [message.threadId]: [...existing, message],
        },
      };
    }),

  reconcileReplies: (replies) =>
    set((state) => {
      if (replies.length === 0) return {};
      const next: Record<string, readonly StoredMessage[]> = { ...state.messagesByThread };
      for (const reply of replies) {
        const existing = next[reply.threadId] ?? [];
        if (existing.some((m) => m.id === reply.id)) continue;
        next[reply.threadId] = [...existing, reply];
      }
      return { messagesByThread: next };
    }),

  applyAgentEvent: (threadId, event) =>
    set((state) => {
      if (!isStreamingFrame(event.type)) return {};
      const list = state.streamingByThread[threadId] ?? [];
      const key = streamingKey(event);
      const current = list.find((m) => m.key === key) ?? emptyStreaming(event);
      const updated = foldEvent(current, event);
      return {
        streamingByThread: {
          ...state.streamingByThread,
          [threadId]: withStreamingMessage(list, updated),
        },
      };
    }),

  clearStreaming: (threadId) =>
    set((state) => {
      if (state.streamingByThread[threadId] === undefined) return {};
      const { [threadId]: _cleared, ...streamingByThread } = state.streamingByThread;
      return { streamingByThread };
    }),
}));
