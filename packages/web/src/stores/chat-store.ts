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
// `tool_use` appends a block.
//
// On `done` we SETTLE the streaming buffer in place (mark it `done`, stop the
// "正在输出…" indicator) — we do NOT drop it. Dropping it on `done` made each
// agent's reply VANISH in the gap between its own `done` and the end-of-turn
// POST that persists every agent's reply at once: with multiple agents (or a
// slow sibling) a finished agent showed nothing until the WHOLE turn completed.
// The settled buffer keeps the reply visible immediately; the authoritative
// persisted StoredMessage later REPLACES the settled twin via reconcileReplies
// (matched by agentId+invocationId), giving it a durable id for reloads.

import { create } from 'zustand';
import type { AgentId, AgentMessage, StoredMessage, Thread } from '@choco/shared';

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
  /**
   * True once this turn's `done` frame settled it: the content stays rendered
   * but the live "正在输出…" indicator stops. It remains here (still keyed per
   * turn) until reconcileReplies swaps in the authoritative persisted reply.
   */
  readonly done?: boolean;
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
  /** Drop the ENTIRE thread's streaming buffer (all agents). */
  clearStreaming(threadId: string): void;
  /**
   * Drop ONLY the streaming buffer of the agent/turn that `event` belongs to.
   * Used on a per-agent `error` / `system_info` frame (the turn produced no
   * renderable reply — an error/notice bubble is surfaced instead) so one agent
   * failing does NOT wipe a sibling's still-live stream in a parallel (@all) turn.
   */
  clearStreamingMessage(threadId: string, event: AgentMessage): void;
  /**
   * SETTLE the agent's streaming buffer on its `done` frame: keep the assembled
   * reply visible but stop its live indicator. An empty turn (no text/thinking/
   * tool output) is dropped instead. Unlike {@link clearStreamingMessage} this
   * does NOT remove a reply — that fixed the bug where output vanished between an
   * agent's `done` and the end-of-turn POST. reconcileReplies later replaces the
   * settled twin with the persisted StoredMessage (matched by agentId+invocationId).
   */
  settleStreamingMessage(threadId: string, event: AgentMessage): void;

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

/**
 * The invocationId a persisted reply belongs to, read from its `extra` bag (the
 * backend stamps it there). Lets reconcileReplies drop the settled live twin of
 * the same (agent, invocation) so the authoritative reply doesn't double-render.
 */
function replyInvocationId(reply: StoredMessage): string | undefined {
  const raw = reply.extra?.['invocationId'];
  return typeof raw === 'string' ? raw : undefined;
}

/** A streaming message has renderable content (else its `done` is an empty turn). */
function hasRenderableContent(msg: StreamingMessage): boolean {
  return msg.text.length > 0 || msg.thinking.length > 0 || msg.toolBlocks.length > 0;
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
      const streamingNext: Record<string, readonly StreamingMessage[]> = {
        ...state.streamingByThread,
      };
      let streamingChanged = false;
      for (const reply of replies) {
        const existing = next[reply.threadId] ?? [];
        if (!existing.some((m) => m.id === reply.id)) {
          next[reply.threadId] = [...existing, reply];
        }
        // The persisted reply is authoritative — drop its settled live twin (same
        // agent + invocation) so the turn renders as ONE bubble, now with a durable
        // id. Only the matching turn is pruned; siblings' live streams stay put.
        const inv = replyInvocationId(reply);
        const liveList = streamingNext[reply.threadId];
        if (inv !== undefined && reply.agentId !== null && liveList !== undefined) {
          const pruned = liveList.filter(
            (m) => !(m.agentId === reply.agentId && m.invocationId === inv),
          );
          if (pruned.length !== liveList.length) {
            streamingChanged = true;
            if (pruned.length === 0) delete streamingNext[reply.threadId];
            else streamingNext[reply.threadId] = pruned;
          }
        }
      }
      return streamingChanged
        ? { messagesByThread: next, streamingByThread: streamingNext }
        : { messagesByThread: next };
    }),

  applyAgentEvent: (threadId, event) =>
    set((state) => {
      if (!isStreamingFrame(event.type)) return {};
      const list = state.streamingByThread[threadId] ?? [];
      const key = streamingKey(event);
      const existing = list.find((m) => m.key === key);
      // A stray streaming frame for an already-settled (done) turn must NOT
      // resurrect/mutate it — the turn is over. A genuinely new turn for the same
      // agent carries a fresh invocationId (different key), so it still opens its
      // own buffer below.
      if (existing?.done === true) return {};
      const current = existing ?? emptyStreaming(event);
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

  clearStreamingMessage: (threadId, event) =>
    set((state) => {
      const list = state.streamingByThread[threadId];
      if (list === undefined) return {};
      // Match by agentId, NOT the full agentId:invocationId key: an agent has at
      // most one live stream per turn, and a terminal `done`/`error` frame may carry
      // a different (or absent) invocationId than the text frames. Clearing by agent
      // is robust to that AND still leaves siblings' streams alone.
      const next = list.filter((m) => m.agentId !== event.agentId);
      if (next.length === list.length) return {}; // this agent had no live stream
      if (next.length === 0) {
        const { [threadId]: _emptied, ...streamingByThread } = state.streamingByThread;
        return { streamingByThread };
      }
      return { streamingByThread: { ...state.streamingByThread, [threadId]: next } };
    }),

  settleStreamingMessage: (threadId, event) =>
    set((state) => {
      const list = state.streamingByThread[threadId];
      if (list === undefined) return {};
      // Settle by agentId (one live stream per agent per turn); a terminal `done`
      // may carry a different/absent invocationId than the text frames.
      const idx = list.findIndex((m) => m.agentId === event.agentId);
      if (idx === -1) return {}; // already reconciled/cleared, or never streamed
      const msg = list[idx];
      if (msg === undefined) return {};
      // An empty turn (done with no output) leaves nothing to show → drop it.
      if (!hasRenderableContent(msg)) {
        const next = list.filter((_, i) => i !== idx);
        if (next.length === 0) {
          const { [threadId]: _emptied, ...streamingByThread } = state.streamingByThread;
          return { streamingByThread };
        }
        return { streamingByThread: { ...state.streamingByThread, [threadId]: next } };
      }
      // Content present → keep it visible, flip off the live indicator.
      if (msg.done === true) return {}; // idempotent (re-delivered done)
      const settled: StreamingMessage = { ...msg, done: true };
      return {
        streamingByThread: {
          ...state.streamingByThread,
          [threadId]: list.map((m, i) => (i === idx ? settled : m)),
        },
      };
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
