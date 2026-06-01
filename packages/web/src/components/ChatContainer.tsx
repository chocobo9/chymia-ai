// M9 ChatContainer — the message transcript for the active thread. Renders, in
// order: persisted messages (user bubbles + agent replies) then the live
// streaming messages assembled from agent_event frames (G8 incremental render).
//
// User messages render as plain bubbles; agent messages (persisted or streaming)
// route through <AgentMessage> with a normalized view. The agent display name +
// color come from the roster (agent store).

import { useMemo, type ReactElement } from 'react';
import type { AgentId, StoredMessage } from '@clowder/shared';
import { useChatStore, type StreamingMessage } from '../stores/chat-store.js';
import { useAgentStore } from '../stores/agent-store.js';
import { AgentMessage, type AgentMessageView } from './AgentMessage.js';
import type { AgentRosterEntry } from '../lib/api.js';

/** Look up an agent's display name + color, falling back to the raw id. */
function agentDisplay(
  roster: readonly AgentRosterEntry[],
  agentId: AgentId,
): { displayName: string; color?: string } {
  const entry = roster.find((a) => a.id === (agentId as string));
  return entry === undefined
    ? { displayName: agentId as string }
    : { displayName: entry.displayName, color: entry.color.primary };
}

/** Map a persisted agent StoredMessage to the AgentMessage view. */
function storedToView(
  message: StoredMessage,
  roster: readonly AgentRosterEntry[],
): AgentMessageView {
  const agentId = message.agentId as AgentId;
  const { displayName, color } = agentDisplay(roster, agentId);
  return {
    agentId,
    displayName,
    text: message.content,
    thinking: '',
    toolBlocks: [],
    isStreaming: false,
    color,
  };
}

/** Map a live StreamingMessage to the AgentMessage view. */
function streamingToView(
  stream: StreamingMessage,
  roster: readonly AgentRosterEntry[],
): AgentMessageView {
  const { displayName, color } = agentDisplay(roster, stream.agentId);
  return {
    agentId: stream.agentId,
    displayName,
    text: stream.text,
    thinking: stream.thinking,
    toolBlocks: stream.toolBlocks,
    isStreaming: true,
    color,
  };
}

interface UserBubbleProps {
  readonly message: StoredMessage;
}

function UserBubble({ message }: UserBubbleProps): ReactElement {
  return (
    <div className="chat-message chat-message--user" data-testid="user-message">
      <div className="chat-message__text">{message.content}</div>
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
      <div className="chat-container chat-container--empty" data-testid="chat-container">
        <p>选择或新建一个会话开始对话。</p>
      </div>
    );
  }

  return (
    <div className="chat-container" data-testid="chat-container">
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
  );
}
