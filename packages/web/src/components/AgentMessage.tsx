// M9 AgentMessage — renders one agent turn in the .d-choco design: an Avatar +
// head (name / model badge / time) + a bubble containing the rich blocks built
// from REAL data — a Think block (collapsible reasoning), file-edit Diff blocks
// (shown prominently), the noisy tool_use calls folded into ONE collapsible
// ToolGroup (Clowder-faithful: expanded live while streaming, auto-collapsed
// once done), the prose body, and a streaming indicator while the turn is live.
// Used for both persisted replies and the in-flight streaming message.
//
// Presentational: takes a normalized AgentMessageView so the same render path
// serves a StoredMessage and a StreamingMessage. Preserves the wiring/a11y
// hooks the M9 tests depend on (data-testid="agent-message"/"agent-text"/
// "thinking-block"/"thinking-body"/"tool-use-block"/"tool-use-input"/
// "diff-block"/"streaming-indicator", data-agent).

import { type ReactElement } from 'react';
import type { AgentId } from '@clowder/shared';
import type { StreamingToolBlock } from '../stores/chat-store.js';
import { Avatar } from './choco/primitives.js';
import { Think, Diff, ToolGroup, type ToolRowData, type DiffLine } from './choco/blocks.js';
import { renderForToolBlock, toolDetailPreview } from './choco/tool-render.js';

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

/** A file-edit diff resolved from a tool block, ready for a visible <Diff>. */
interface DiffBlockData {
  readonly key: string;
  readonly file: string;
  readonly added: number;
  readonly removed: number;
  readonly lines: readonly DiffLine[];
}

interface PartitionedBlocks {
  /** File-edit diffs, kept VISIBLE (substantive content the user wants to see). */
  readonly diffs: readonly DiffBlockData[];
  /** Non-diff tool calls, folded into the collapsible ToolGroup. */
  readonly toolRows: readonly ToolRowData[];
}

/**
 * Partition the turn's tool blocks into prominent file-edit diffs vs the noisy
 * tool_use calls. Mirrors Clowder's spirit: diffs render on their own, the rest
 * collapse into one group. Order within each bucket follows source order; a
 * stable key falls back to name+index when toolUseId is absent.
 */
function partitionBlocks(blocks: readonly StreamingToolBlock[]): PartitionedBlocks {
  const diffs: DiffBlockData[] = [];
  const toolRows: ToolRowData[] = [];
  blocks.forEach((block, i) => {
    const key = block.toolUseId ?? `${block.toolName}-${i}`;
    const render = renderForToolBlock(block);
    if (render.kind === 'diff') {
      diffs.push({
        key,
        file: render.file,
        added: render.added,
        removed: render.removed,
        lines: render.lines,
      });
    } else {
      toolRows.push({
        key,
        toolName: render.toolName,
        detail: toolDetailPreview(block),
        inputJson: render.inputJson,
      });
    }
  });
  return { diffs, toolRows };
}

export interface AgentMessageProps {
  readonly view: AgentMessageView;
}

/** Render a single agent message (avatar + head + bubble with rich blocks). */
export function AgentMessage({ view }: AgentMessageProps): ReactElement {
  const accent = view.color;
  const avatarSeed = view.avatarName ?? view.displayName;
  const { diffs, toolRows } = partitionBlocks(view.toolBlocks);
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

          {/* File edits stay prominent — substantive content the user wants to see. */}
          {diffs.map((d) => (
            <Diff key={d.key} file={d.file} added={d.added} removed={d.removed} lines={d.lines} />
          ))}

          {/* The noisy tool_use calls fold into ONE collapsible group (Clowder spirit). */}
          {toolRows.length > 0 && (
            <ToolGroup rows={toolRows} isStreaming={view.isStreaming} accent={accent} />
          )}

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
