// Session archive types (M3 session-store, cross-module).
// Source: clowder-design-supplement.md 补充 E (Session 归档模型 — E3.1/E3.2/E3.3).
//
// A session is a first-class ARCHIVED artifact (not a transient resume token):
// it carries a sequence number, a status (active|sealed), and — once sealed — a
// computed digest. Its transcript is the messages + tool_events produced during
// the session, tagged with its session_id (E3.3). These types are cross-module
// (M3 owns the store; M5 tags rows; M8 wires; M10 wraps), so they live in shared
// alongside StoredMessage / StoredToolEvent.

import type { AgentId } from './agent.js';

/**
 * SessionStatus — lifecycle state of an archived session.
 * Source: 补充 E E3.1. Only two states in our native essence (no Clowder
 * 'sealing' transient, no unseal): a session is either the live one for its
 * (agent, thread) or it has been sealed (closed, digest computed, history kept).
 */
export type SessionStatus = 'active' | 'sealed';

/**
 * SessionRecord — one row of the session chain.
 * Source: 补充 E E3.1 schema.
 *
 * `sequenceNo` is 1-based per (threadId, agentId). At most one record per
 * (agentId, threadId) has status='active' (the invariant the store enforces).
 * `sealedAt` and `digest` are populated only at seal time (undefined while active).
 */
export interface SessionRecord {
  readonly sessionId: string; // CLI session id (globally unique; from session_init)
  readonly threadId: string;
  readonly agentId: AgentId;
  readonly sequenceNo: number; // 1-based per (thread, agent)
  readonly status: SessionStatus;
  readonly createdAt: number; // epoch ms
  readonly sealedAt?: number; // epoch ms; set on seal
  readonly digest?: SessionDigest; // computed + stored at seal time
}

/**
 * SessionDigest — extractive summary of a session, computed at seal time from
 * its messages + tool_events.
 * Source: 补充 E E3.2.
 *
 * - messageCount: number of agent messages in the session's transcript.
 * - toolCounts: per-tool-name call counts (e.g. { write_file: 3, run_tests: 1 }).
 * - filesTouched: distinct file paths seen in tool inputs (best-effort extraction).
 * - errorCount: number of error events in the transcript.
 * - durationMs: lastAt − firstAt (0 for an empty/single-event session).
 * - firstAt / lastAt: epoch-ms bounds of the transcript (0 when empty).
 */
export interface SessionDigest {
  readonly messageCount: number;
  readonly toolCounts: Record<string, number>;
  readonly filesTouched: readonly string[];
  readonly errorCount: number;
  readonly durationMs: number;
  readonly firstAt: number;
  readonly lastAt: number;
}

/**
 * SessionEventKind — which sink a transcript event came from.
 * Source: 补充 E E3.3 (transcript = messages + tool_events).
 */
export type SessionEventKind = 'message' | 'tool_event';

/**
 * SessionEvent — one entry of a session transcript, merged from the message
 * store and the tool-event log by timestamp.
 * Source: 补充 E E3.2 getTranscript / E3.3.
 *
 * A `message` event carries the agent reply text in `content`; a `tool_event`
 * carries `toolName` (and optional input/result/duration). `timestamp` is the
 * merge key (epoch ms); `id` is the underlying row id (message id / tool-event id).
 */
export interface SessionEvent {
  readonly kind: SessionEventKind;
  readonly id: string;
  readonly agentId: AgentId;
  readonly timestamp: number; // epoch ms — transcript merge key
  readonly content?: string; // message text
  readonly toolName?: string; // tool_event: tool name
  readonly toolInput?: string; // tool_event: JSON string
  readonly toolResult?: string; // tool_event: result
  readonly durationMs?: number; // tool_event: paired duration
  readonly isError?: boolean; // message flagged as an error reply
}

/**
 * ISessionStore — the session archive interface (升级 A3 ISessionManager).
 * Source: 补充 E E3.2.
 *
 * Resume surface (status-aware replacements for the old resume-token methods):
 * - getActiveSessionId: the live session id for (agent, thread), or undefined.
 * - startSession: seal the prior active session (if any) for (agent, thread),
 *   then insert a new active record at sequenceNo+1.
 * - sealActiveSession: seal (NOT delete) the active session — keep the row,
 *   set status='sealed', compute + store the digest.
 *
 * Archive surface (new):
 * - listByThread: the full session chain for a thread, ascending by sequenceNo.
 * - getSession: a single record by id.
 * - getTranscript: the session's messages + tool_events, merged by timestamp.
 * - getDigest: the stored digest (sealed sessions) or a freshly computed one
 *   (active sessions / sessions missing a stored digest).
 */
export interface ISessionStore {
  getActiveSessionId(agentId: AgentId, threadId: string): string | undefined;
  startSession(agentId: AgentId, threadId: string, sessionId: string): SessionRecord;
  sealActiveSession(agentId: AgentId, threadId: string): void;
  listByThread(threadId: string): SessionRecord[];
  getSession(sessionId: string): SessionRecord | null;
  getTranscript(sessionId: string): Promise<SessionEvent[]>;
  getDigest(sessionId: string): Promise<SessionDigest | null>;
}
