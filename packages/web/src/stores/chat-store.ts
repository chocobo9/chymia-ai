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
 * TranscriptNotice — a VISIBLE error/notice bubble rendered inline in the
 * transcript (§D). Surfaced when an agent turn ERRORS (the agent_event `error`
 * frame, which the socket layer used to silently drop) or when an explicit
 * @mention of an unavailable agent yields a `system_info` notice. A turn that
 * produces ONLY an error/notice must NOT leave the user staring at silence — this
 * entry is what they see instead.
 */
export interface TranscriptNotice {
  /** Stable id for keying + dedupe. */
  readonly id: string;
  /** The agent the notice is about (drives display name/color via the roster). */
  readonly agentId: AgentId;
  /** 'error' = an agent call failed; 'notice' = an availability/system notice. */
  readonly kind: 'error' | 'notice';
  /** The user-facing reason/notice text. */
  readonly text: string;
  readonly timestamp: number;
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
  /** Visible error/notice bubbles per threadId (§D — never silent). */
  readonly noticesByThread: Readonly<Record<string, readonly TranscriptNotice[]>>;
  readonly activeThreadId: string | null;

  // Thread actions.
  setThreads(threads: readonly Thread[]): void;
  upsertThread(thread: Thread): void;
  removeThread(threadId: string): void;
  setActiveThread(threadId: string | null): void;

  // Message actions.
  setMessages(threadId: string, messages: readonly StoredMessage[]): void;
  addMessage(message: StoredMessage): void;
  /**
   * Optimistically insert a user message immediately on send (before the POST
   * resolves) so it shows at once; returns the temp id the caller later passes
   * to {@link replaceOptimisticMessage} / {@link removeMessage}.
   */
  addOptimisticUserMessage(threadId: string, content: string, timestamp: number): string;
  /** Replace an optimistic temp message with the real persisted one (dedupe). */
  replaceOptimisticMessage(threadId: string, tempId: string, real: StoredMessage): void;
  /** Remove a message by id (used to drop a failed optimistic message). */
  removeMessage(threadId: string, messageId: string): void;
  reconcileReplies(replies: readonly StoredMessage[]): void;

  // Streaming actions (driven by agent_event frames).
  applyAgentEvent(threadId: string, event: AgentMessage): void;
  clearStreaming(threadId: string): void;

  // Notice/error actions (§D — render an agent error / availability notice
  // visibly in the transcript instead of dropping it).
  addNotice(threadId: string, notice: TranscriptNotice): void;
}

/** Prefix marking an optimistic (not-yet-persisted) user message's temp id. */
const OPTIMISTIC_ID_PREFIX = 'optimistic-';

/** Mint a unique temp id for an optimistic user message. */
function mintOptimisticId(): string {
  return `${OPTIMISTIC_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
  noticesByThread: {},
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
      const { [threadId]: _removedNotices, ...noticesByThread } = state.noticesByThread;
      const activeThreadId =
        state.activeThreadId === threadId ? null : state.activeThreadId;
      return { threads, messagesByThread, streamingByThread, noticesByThread, activeThreadId };
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

  addOptimisticUserMessage: (threadId, content, timestamp) => {
    const tempId = mintOptimisticId();
    set((state) => {
      const existing = state.messagesByThread[threadId] ?? [];
      const optimistic: StoredMessage = {
        id: tempId,
        threadId,
        userId: 'user',
        agentId: null,
        content,
        mentions: [],
        origin: 'user',
        timestamp,
      };
      return {
        messagesByThread: {
          ...state.messagesByThread,
          [threadId]: [...existing, optimistic],
        },
      };
    });
    return tempId;
  },

  replaceOptimisticMessage: (threadId, tempId, real) =>
    set((state) => {
      const existing = state.messagesByThread[threadId] ?? [];
      // Dedupe: if the real message is already present (e.g. a history refresh
      // raced in), just drop the optimistic placeholder.
      const withoutTemp = existing.filter((m) => m.id !== tempId);
      const next = withoutTemp.some((m) => m.id === real.id)
        ? withoutTemp
        : [...withoutTemp, real];
      return {
        messagesByThread: { ...state.messagesByThread, [threadId]: next },
      };
    }),

  removeMessage: (threadId, messageId) =>
    set((state) => {
      const existing = state.messagesByThread[threadId];
      if (existing === undefined) return {};
      return {
        messagesByThread: {
          ...state.messagesByThread,
          [threadId]: existing.filter((m) => m.id !== messageId),
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

  addNotice: (threadId, notice) =>
    set((state) => {
      const existing = state.noticesByThread[threadId] ?? [];
      // Dedupe by id so a re-delivered notice doesn't double-render.
      if (existing.some((n) => n.id === notice.id)) return {};
      return {
        noticesByThread: {
          ...state.noticesByThread,
          [threadId]: [...existing, notice],
        },
      };
    }),
}));
