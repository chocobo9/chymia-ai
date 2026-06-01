// M9 AgentMessage — renders one agent turn: a thinking block (collapsible), any
// tool_use blocks (collapsible, showing tool name + JSON input), and the text
// body. Used for both persisted replies and the in-flight streaming message.
//
// The component is presentational: it takes a normalized AgentMessageView so the
// same render path serves a StoredMessage and a StreamingMessage.

import { useState, type ReactElement } from 'react';
import type { AgentId } from '@clowder/shared';
import type { StreamingToolBlock } from '../stores/chat-store.js';

/** Normalized view of one agent turn for rendering. */
export interface AgentMessageView {
  readonly agentId: AgentId;
  readonly displayName: string;
  readonly text: string;
  readonly thinking: string;
  readonly toolBlocks: readonly StreamingToolBlock[];
  /** True while the turn is still streaming (renders a live indicator). */
  readonly isStreaming: boolean;
  /** Agent accent color for the name badge. */
  readonly color?: string;
}

interface ToolUseBlockProps {
  readonly block: StreamingToolBlock;
}

function ToolUseBlock({ block }: ToolUseBlockProps): ReactElement {
  const [open, setOpen] = useState(false);
  const inputJson =
    block.toolInput === undefined ? '' : JSON.stringify(block.toolInput, null, 2);
  return (
    <div className="agent-tool-use" data-testid="tool-use-block">
      <button
        type="button"
        className="agent-tool-use__toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> 工具调用: {block.toolName}
      </button>
      {open && inputJson.length > 0 && (
        <pre className="agent-tool-use__input" data-testid="tool-use-input">
          {inputJson}
        </pre>
      )}
    </div>
  );
}

interface ThinkingBlockProps {
  readonly thinking: string;
}

function ThinkingBlock({ thinking }: ThinkingBlockProps): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="agent-thinking" data-testid="thinking-block">
      <button
        type="button"
        className="agent-thinking__toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> 思考过程
      </button>
      {open && (
        <pre className="agent-thinking__body" data-testid="thinking-body">
          {thinking}
        </pre>
      )}
    </div>
  );
}

export interface AgentMessageProps {
  readonly view: AgentMessageView;
}

/** Render a single agent message (thinking + tool_use blocks + text). */
export function AgentMessage({ view }: AgentMessageProps): ReactElement {
  return (
    <article className="agent-message" data-testid="agent-message" data-agent={view.agentId}>
      <header className="agent-message__header">
        <span className="agent-message__name" style={{ color: view.color }}>
          {view.displayName}
        </span>
        {view.isStreaming && (
          <span className="agent-message__streaming" data-testid="streaming-indicator">
            正在输出…
          </span>
        )}
      </header>

      {view.thinking.length > 0 && <ThinkingBlock thinking={view.thinking} />}

      {view.toolBlocks.map((block, i) => (
        <ToolUseBlock key={block.toolUseId ?? `${block.toolName}-${i}`} block={block} />
      ))}

      {view.text.length > 0 && (
        <div className="agent-message__text" data-testid="agent-text">
          {view.text}
        </div>
      )}
    </article>
  );
}
