// M9 AgentMessage — renders one agent turn in the .d-choco design: an Avatar +
// head (name / model badge / time) + a bubble containing the rich blocks built
// from REAL data — a Think block (collapsible reasoning), Tool/Diff blocks (one
// per tool_use; Diff when the tool is a file edit), the prose body, and a
// StreamDots indicator while the turn is live. Used for both persisted replies
// and the in-flight streaming message.
//
// Presentational: takes a normalized AgentMessageView so the same render path
// serves a StoredMessage and a StreamingMessage. Preserves the wiring/a11y
// hooks the M9 tests depend on (data-testid="agent-message"/"agent-text"/
// "thinking-block"/"thinking-body"/"tool-use-block"/"tool-use-input"/
// "streaming-indicator", data-agent).

import { type ReactElement } from 'react';
import type { AgentId } from '@clowder/shared';
import type { StreamingToolBlock } from '../stores/chat-store.js';
import { Avatar } from './choco/primitives.js';
import { Think, Tool, Diff } from './choco/blocks.js';
import { renderForToolBlock } from './choco/tool-render.js';

/** Normalized view of one agent turn for rendering. */
export interface AgentMessageView {
  readonly agentId: AgentId;
  readonly displayName: string;
  readonly text: string;
  readonly thinking: string;
  readonly toolBlocks: readonly StreamingToolBlock[];
  /** True while the turn is still streaming (renders a live indicator). */
  readonly isStreaming: boolean;
  /** Agent accent color (roster color.primary) for the name + avatar. */
  readonly color?: string;
  /** Short model badge (e.g. "Opus"); omitted when unknown. */
  readonly model?: string;
  /** Mono initials seed (avatar). Defaults to displayName. */
  readonly avatarName?: string;
}

interface ToolBlockProps {
  readonly block: StreamingToolBlock;
  readonly accent?: string;
  readonly running: boolean;
}

/** Render one tool_use block as a Tool call or a Diff (file edit). */
function ToolBlock({ block, accent, running }: ToolBlockProps): ReactElement {
  const render = renderForToolBlock(block);
  if (render.kind === 'diff') {
    return (
      <Diff file={render.file} added={render.added} removed={render.removed} lines={render.lines} />
    );
  }
  return (
    <Tool toolName={render.toolName} inputJson={render.inputJson} running={running} accent={accent} />
  );
}

export interface AgentMessageProps {
  readonly view: AgentMessageView;
}

/** Render a single agent message (avatar + head + bubble with rich blocks). */
export function AgentMessage({ view }: AgentMessageProps): ReactElement {
  const accent = view.color;
  const avatarSeed = view.avatarName ?? view.displayName;
  return (
    <div
      className="msg-agent"
      data-testid="agent-message"
      data-agent={view.agentId}
      style={accent === undefined ? undefined : ({ '--ac': accent } as React.CSSProperties)}
    >
      <Avatar agentId={view.agentId as string} name={avatarSeed} accent={accent ?? 'var(--brand)'} />
      <div className="msg-col">
        <header className="msg-head agent-message__header">
          <span className="name agent-message__name" style={{ color: accent }}>
            {view.displayName}
          </span>
          {view.model !== undefined && view.model.length > 0 && (
            <span className="model">{view.model}</span>
          )}
          {view.isStreaming && (
            <span className="time agent-message__streaming" data-testid="streaming-indicator">
              正在输出…
            </span>
          )}
        </header>

        <div className="bubble">
          {view.thinking.length > 0 && <Think thinking={view.thinking} accent={accent} />}

          {view.toolBlocks.map((block, i) => (
            <ToolBlock
              key={block.toolUseId ?? `${block.toolName}-${i}`}
              block={block}
              accent={accent}
              running={view.isStreaming}
            />
          ))}

          {view.text.length > 0 && (
            <div className="body agent-message__text" data-testid="agent-text">
              {view.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
