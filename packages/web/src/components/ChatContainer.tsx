// M9 ChatContainer — the message transcript for the active thread, rendered in
// the .d-choco design: a scrollable `stream` of centered `stream-inner` content.
// In order: persisted messages (user bubbles + agent replies) then the live
// streaming messages assembled from agent_event frames (G8 incremental render).
//
// User messages render as `.msg-user` bubbles; agent messages (persisted or
// streaming) route through <AgentMessage> with a normalized view. Display name,
// short name (avatar), model badge, and accent come from the roster (agent
// store). When the thread has no messages we show the honest empty state.

import { useCallback, useLayoutEffect, useMemo, useRef, type ReactElement } from 'react';
import type { AgentId, StoredMessage } from '@choco/shared';
import {
  useChatStore,
  type StreamingMessage,
  type StreamingToolBlock,
  type TranscriptNotice,
} from '../stores/chat-store.js';
import { useAgentStore } from '../stores/agent-store.js';
import { AgentMessage, type AgentMessageView } from './AgentMessage.js';
import type { AgentRosterEntry } from '../lib/api.js';
import { modelBadge, shortName } from './choco/primitives.js';
import { IconHash } from './choco/icons.js';

/**
 * Treat the view as "pinned to the bottom" when within this many px of it. Above
 * this gap we assume the user scrolled up to read history and STOP auto-following
 * (so streaming output never yanks them back down).
 */
const BOTTOM_THRESHOLD_PX = 80;

interface AgentDisplay {
  readonly displayName: string;
  readonly avatarName: string;
  readonly color?: string;
  readonly model?: string;
}

/** Look up an agent's display fields from the roster, falling back to the id. */
function agentDisplay(roster: readonly AgentRosterEntry[], agentId: AgentId): AgentDisplay {
  const entry = roster.find((a) => a.id === (agentId as string));
  if (entry === undefined) {
    return { displayName: agentId as string, avatarName: agentId as string };
  }
  return {
    displayName: entry.displayName,
    avatarName: shortName(entry),
    color: entry.color.primary,
    model: modelBadge(entry),
  };
}

/**
 * Recover the tool blocks a completed reply rendered while streaming, from the
 * persisted `extra.toolEvents` bag (backend message-handler writes `tool_use`
 * entries there). Only `tool_use` events become blocks (mirroring the streaming
 * fold). Defensive: returns [] when absent or malformed (never throws / fabricates).
 */
function toolBlocksFromExtra(extra: StoredMessage['extra']): readonly StreamingToolBlock[] {
  const raw = extra?.['toolEvents'];
  if (!Array.isArray(raw)) return [];
  const blocks: StreamingToolBlock[] = [];
  for (const ev of raw) {
    if (typeof ev !== 'object' || ev === null) continue;
    const record = ev as Record<string, unknown>;
    if (record['type'] !== 'tool_use') continue;
    const toolName = typeof record['toolName'] === 'string' ? record['toolName'] : 'tool';
    const toolUseId = typeof record['toolUseId'] === 'string' ? record['toolUseId'] : undefined;
    const toolInput =
      typeof record['toolInput'] === 'object' && record['toolInput'] !== null
        ? (record['toolInput'] as Record<string, unknown>)
        : undefined;
    blocks.push({
      toolName,
      ...(toolUseId !== undefined ? { toolUseId } : {}),
      ...(toolInput !== undefined ? { toolInput } : {}),
    });
  }
  return blocks;
}

/** Recover the persisted reasoning text from `extra.thinking` (defensive). */
function thinkingFromExtra(extra: StoredMessage['extra']): string {
  const raw = extra?.['thinking'];
  return typeof raw === 'string' ? raw : '';
}

/** Map a persisted agent StoredMessage to the AgentMessage view. */
function storedToView(message: StoredMessage, roster: readonly AgentRosterEntry[]): AgentMessageView {
  const agentId = message.agentId as AgentId;
  const display = agentDisplay(roster, agentId);
  return {
    agentId,
    displayName: display.displayName,
    avatarName: display.avatarName,
    model: display.model,
    text: message.content,
    // Re-show the Think + Tool/Diff blocks the streaming view rendered, recovered
    // from the persisted extra bag — so a completed reply matches its live state.
    thinking: thinkingFromExtra(message.extra),
    toolBlocks: toolBlocksFromExtra(message.extra),
    isStreaming: false,
    color: display.color,
  };
}

/** Map a live StreamingMessage to the AgentMessage view. */
function streamingToView(
  stream: StreamingMessage,
  roster: readonly AgentRosterEntry[],
): AgentMessageView {
  const display = agentDisplay(roster, stream.agentId);
  return {
    agentId: stream.agentId,
    displayName: display.displayName,
    avatarName: display.avatarName,
    model: display.model,
    text: stream.text,
    thinking: stream.thinking,
    toolBlocks: stream.toolBlocks,
    // A settled (done) buffer keeps its content but stops the live indicator,
    // so it reads as a finished reply until reconcileReplies swaps in the
    // persisted copy.
    isStreaming: stream.done !== true,
    color: display.color,
  };
}

interface UserBubbleProps {
  readonly message: StoredMessage;
}

function UserBubble({ message }: UserBubbleProps): ReactElement {
  return (
    <div className="msg-user" data-testid="user-message">
      <div className="ubub chat-message__text">{message.content}</div>
      <div className="umeta">
        <span className="to">@all</span>
      </div>
    </div>
  );
}

interface NoticeBubbleProps {
  readonly notice: TranscriptNotice;
  readonly roster: readonly AgentRosterEntry[];
}

/**
 * §D: a VISIBLE error/notice bubble — what the user sees when an agent turn
 * errors or an explicit @mention hit an unavailable agent (instead of silence).
 * Error frames render with a ⚠ + the agent's display name + the reason; an
 * availability notice renders the notice text (already names the agent + the
 * available alternatives).
 */
function NoticeBubble({ notice, roster }: NoticeBubbleProps): ReactElement {
  const display = agentDisplay(roster, notice.agentId);
  const isError = notice.kind === 'error';
  const text = isError ? `⚠ ${display.displayName} 调用失败：${notice.text}` : notice.text;
  return (
    <div
      className={`msg-notice msg-notice--${notice.kind}`}
      data-testid="transcript-notice"
      data-notice-kind={notice.kind}
      data-agent={notice.agentId}
      // role="status" (polite live region), NOT "alert" — the app-level error
      // banner already owns the single `alert` role; a transcript notice is an
      // inline aside, not an interrupting alert.
      role="status"
    >
      <span className="msg-notice__text">{text}</span>
    </div>
  );
}

/** Honest empty state for a thread with no messages yet. */
function EmptyThread(): ReactElement {
  return (
    <div className="empty-thread" data-testid="empty-thread">
      <div className="empty-mark">
        <IconHash />
      </div>
      <div className="empty-t">新会话已就绪</div>
      <div className="empty-s">下达指令，或 @ 点名某个 agent 开工。</div>
    </div>
  );
}

export interface ChatContainerProps {
  /** Open/reveal a file an edit wrote (forwarded to each agent message's diffs). */
  readonly onRevealFile?: (path: string, action: 'open' | 'reveal') => void;
  /** Load a workspace file's content for the inline HTML preview (forwarded to diffs). */
  readonly onLoadFile?: (path: string) => Promise<string>;
}

/** Render the active thread's transcript (persisted + streaming). */
export function ChatContainer({ onRevealFile, onLoadFile }: ChatContainerProps = {}): ReactElement {
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  const messagesByThread = useChatStore((s) => s.messagesByThread);
  const streamingByThread = useChatStore((s) => s.streamingByThread);
  const noticesByThread = useChatStore((s) => s.noticesByThread);
  const roster = useAgentStore((s) => s.roster);

  const messages = useMemo(
    () => (activeThreadId === null ? [] : messagesByThread[activeThreadId] ?? []),
    [activeThreadId, messagesByThread],
  );
  const streaming = useMemo(
    () => (activeThreadId === null ? [] : streamingByThread[activeThreadId] ?? []),
    [activeThreadId, streamingByThread],
  );
  const liveNotices = useMemo(
    () => (activeThreadId === null ? [] : noticesByThread[activeThreadId] ?? []),
    [activeThreadId, noticesByThread],
  );

  // The unavailable-agent notice persists as a `system`-origin StoredMessage AND
  // arrives live as a `system_info` notice. To avoid a double bubble, suppress a
  // live notice whose text matches an already-persisted system message (same
  // agent + text). The live notice still covers the streaming window before the
  // POST reconciles the persisted copy.
  const persistedSystemKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const m of messages) {
      if (m.origin === 'system' && m.agentId !== null) {
        keys.add(`${m.agentId as string}::${m.content}`);
      }
    }
    return keys;
  }, [messages]);

  const visibleNotices = useMemo(
    () => liveNotices.filter((n) => !persistedSystemKeys.has(`${n.agentId as string}::${n.text}`)),
    [liveNotices, persistedSystemKeys],
  );

  // ── Auto-scroll: follow the bottom as messages + streaming tokens arrive, so the
  // live output stays in view (the missing piece that made streaming feel janky).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Start pinned; flips to false when the user scrolls up to read history.
  const pinnedRef = useRef(true);

  const handleScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = distanceFromBottom <= BOTTOM_THRESHOLD_PX;
  }, []);

  // Follow new content ONLY when pinned. useLayoutEffect pins before paint so a
  // streamed token never flashes below the fold before snapping into view.
  useLayoutEffect(() => {
    if (!pinnedRef.current) return;
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, visibleNotices]);

  // Switching threads: jump to the bottom and re-pin (a fresh transcript).
  useLayoutEffect(() => {
    pinnedRef.current = true;
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [activeThreadId]);

  if (activeThreadId === null) {
    return (
      <div className="stream chat-container chat-container--empty" data-testid="chat-container">
        <div className="stream-inner">
          <div className="empty-thread">
            <div className="empty-mark">
              <IconHash />
            </div>
            <div className="empty-t">选择或新建一个会话开始对话。</div>
          </div>
        </div>
      </div>
    );
  }

  const isEmpty =
    messages.length === 0 && streaming.length === 0 && visibleNotices.length === 0;

  return (
    <div
      className="stream chat-container"
      data-testid="chat-container"
      ref={scrollRef}
      onScroll={handleScroll}
    >
      <div className="stream-inner">
        {isEmpty && <EmptyThread />}
        {messages.map((message) =>
          message.agentId === null ? (
            <UserBubble key={message.id} message={message} />
          ) : message.origin === 'system' ? (
            // A persisted unavailable-agent / system notice renders as a notice
            // bubble (not a normal agent reply) so the durable copy matches the
            // live one (§D).
            <NoticeBubble
              key={message.id}
              roster={roster}
              notice={{
                id: message.id,
                agentId: message.agentId as AgentId,
                kind: 'notice',
                text: message.content,
                timestamp: message.timestamp,
              }}
            />
          ) : (
            <AgentMessage
              key={message.id}
              view={storedToView(message, roster)}
              onRevealFile={onRevealFile}
              onLoadFile={onLoadFile}
            />
          ),
        )}
        {streaming.map((stream) => (
          <AgentMessage
            key={`stream:${stream.key}`}
            view={streamingToView(stream, roster)}
            onRevealFile={onRevealFile}
            onLoadFile={onLoadFile}
          />
        ))}
        {visibleNotices.map((notice) => (
          <NoticeBubble key={`notice:${notice.id}`} roster={roster} notice={notice} />
        ))}
      </div>
    </div>
  );
}
