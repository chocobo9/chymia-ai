// M9 ChatContainer — the message transcript for the active thread, rendered in
// the .d-choco design: a scrollable `stream` of centered `stream-inner` content.
// In order: persisted messages (user bubbles + agent replies) then the live
// streaming messages assembled from agent_event frames (G8 incremental render).
//
// User messages render as `.msg-user` bubbles; agent messages (persisted or
// streaming) route through <AgentMessage> with a normalized view. Display name,
// short name (avatar), model badge, and accent come from the roster (agent
// store). When the thread has no messages we show the honest empty state.

import { useMemo, type ReactElement } from 'react';
import type { AgentId, StoredMessage } from '@clowder/shared';
import { useChatStore, type StreamingMessage, type StreamingToolBlock } from '../stores/chat-store.js';
import { useAgentStore } from '../stores/agent-store.js';
import { AgentMessage, type AgentMessageView } from './AgentMessage.js';
import type { AgentRosterEntry } from '../lib/api.js';
import { modelBadge, shortName } from './choco/primitives.js';
import { IconHash } from './choco/icons.js';

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
    isStreaming: true,
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

/** Render the active thread's transcript (persisted + streaming). */
export function ChatContainer(): ReactElement {
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  const messagesByThread = useChatStore((s) => s.messagesByThread);
  const streamingByThread = useChatStore((s) => s.streamingByThread);
  const roster = useAgentStore((s) => s.roster);

  const messages = useMemo(
    () => (activeThreadId === null ? [] : messagesByThread[activeThreadId] ?? []),
    [activeThreadId, messagesByThread],
  );
  const streaming = useMemo(
    () => (activeThreadId === null ? [] : streamingByThread[activeThreadId] ?? []),
    [activeThreadId, streamingByThread],
  );

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

  const isEmpty = messages.length === 0 && streaming.length === 0;

  return (
    <div className="stream chat-container" data-testid="chat-container">
      <div className="stream-inner">
        {isEmpty && <EmptyThread />}
        {messages.map((message) =>
          message.agentId === null ? (
            <UserBubble key={message.id} message={message} />
          ) : (
            <AgentMessage key={message.id} view={storedToView(message, roster)} />
          ),
        )}
        {streaming.map((stream) => (
          <AgentMessage key={`stream:${stream.key}`} view={streamingToView(stream, roster)} />
        ))}
      </div>
    </div>
  );
}
