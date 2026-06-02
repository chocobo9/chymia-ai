// Tool-event helpers + tool-payload scrubbing for hierarchical context.
//
// Source: clowder-design-supplement.md §B1a ("Tool Payload Scrub": burst 中非最后
// 一条消息的 tool_result 内容被替换为 "<tool_result truncated: {label} executed>";
// 最后一条消息的 tool_result 保留原文).
//
// WHY (research, from Clowder context-transport.ts): the reference reads
// `StoredMessage.toolEvents` directly. Our frozen M1 StoredMessage (§4.3) has no
// `toolEvents` field — it only carries `content` + a free-form `extra` bag
// ("额外结构化数据（cross-post、tracing 等）"). So we read tool events from
// `extra.toolEvents`, which is the structured channel the design reserves for
// exactly this kind of tracing metadata. See DEV report "deviations".

import type { StoredMessage } from '@choco/shared';

/**
 * Minimal tool-event shape consumed by the context layers. Persisted under
 * `StoredMessage.extra.toolEvents` by the routing/invocation layers (M3/M4).
 * Only the fields the context assembly needs are modeled here.
 */
export interface ToolEventLike {
  type: 'tool_use' | 'tool_result';
  /** Human-readable tool label (e.g. 'read_file'); used in the scrub digest. */
  label?: string;
}

/** Key under which tool events live in `StoredMessage.extra`. */
const TOOL_EVENTS_EXTRA_KEY = 'toolEvents';

/** Placeholder substituted for a scrubbed tool_result payload (label-aware). */
function scrubMarker(label: string): string {
  return `<tool_result truncated: ${label} executed>`;
}

/**
 * Read the tool events attached to a message via `extra.toolEvents`.
 * Returns [] when absent or malformed (fail-safe; never throws to callers).
 */
export function getToolEvents(msg: StoredMessage): ToolEventLike[] {
  const raw = msg.extra?.[TOOL_EVENTS_EXTRA_KEY];
  if (!Array.isArray(raw)) return [];
  const events: ToolEventLike[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const type = (entry as { type?: unknown }).type;
    if (type !== 'tool_use' && type !== 'tool_result') continue;
    const label = (entry as { label?: unknown }).label;
    events.push({ type, ...(typeof label === 'string' ? { label } : {}) });
  }
  return events;
}

/** Whether the message carries at least one tool_use event. */
export function hasToolUse(msg: StoredMessage): boolean {
  return getToolEvents(msg).some((e) => e.type === 'tool_use');
}

/** Whether the message carries at least one tool_result event. */
export function hasToolResult(msg: StoredMessage): boolean {
  return getToolEvents(msg).some((e) => e.type === 'tool_result');
}

/**
 * Scrub tool_result payloads from non-terminal messages.
 * The last message's content is preserved verbatim; earlier messages that carry
 * a tool_result have their content replaced with a compact digest line.
 * Returns fresh objects (never mutates the input messages).
 *
 * Pattern from Clowder context-transport.ts scrubToolPayloads (re-authored).
 */
export function scrubToolPayloads(messages: readonly StoredMessage[]): StoredMessage[] {
  if (messages.length === 0) return [];
  const lastIndex = messages.length - 1;
  return messages.map((msg, i) => {
    if (i === lastIndex) return { ...msg };
    if (!hasToolResult(msg)) return { ...msg };
    const label = getToolEvents(msg).find((e) => e.type === 'tool_result')?.label ?? 'tool';
    return { ...msg, content: scrubMarker(label) };
  });
}
