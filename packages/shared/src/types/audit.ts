// Audit timeline types (M8 audit route).
//
// The browser-facing "who did what, when" per-thread activity trail — merged
// chronologically from the tool-event log (each tool call), the agent replies
// (each invocation outcome), and the session boundaries (start / seal). This is
// the QUERYABLE, UI-surfaced audit (distinct from the rolling ops LOG FILE).

import type { AgentId } from './agent.js';

/** Kind of audit entry (discriminator for {@link AuditEntry}). */
export type AuditEntryType = 'reply' | 'tool' | 'session_start' | 'session_seal';

/**
 * AuditEntry — one row of a thread's audit timeline. A flat DTO with a `type`
 * discriminator + per-type optional fields (an API transport shape, not a
 * domain model). `timestamp` is the epoch-ms sort key.
 */
export interface AuditEntry {
  readonly type: AuditEntryType;
  readonly agentId: AgentId;
  readonly timestamp: number;
  /** reply: characters of agent text produced this turn. */
  readonly textChars?: number;
  /** reply: number of tool calls captured for this turn. */
  readonly toolCount?: number;
  /** reply: true for a system/error notice reply (not a normal output). */
  readonly isError?: boolean;
  /** tool: the tool name (Write / Read / Bash / evidence_search / …). */
  readonly toolName?: string;
  /** tool: paired tool_use→tool_result duration, when known. */
  readonly durationMs?: number;
  /** session_start / session_seal: the CLI session id + its 1-based chain index. */
  readonly sessionId?: string;
  readonly sequenceNo?: number;
  /** correlation: the invocation a tool call belongs to, when known. */
  readonly invocationId?: string;
}
