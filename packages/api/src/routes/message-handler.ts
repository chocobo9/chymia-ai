// G3 message-handler — the reusable "route → persist → collect replies" core.
//
// Extracted (internal refactor, no behavior change) from message-routes.ts so
// BOTH the HTTP POST /api/threads/:id/messages route AND the platform ingress
// (submitPlatformMessage, for M13/M14 adapters) drive the identical pipeline:
//   1. ensureThread (auto-create on first message — ported Clowder idiom)
//   2. append the user message (with parsed mentions) to the MessageStore
//   3. router.route() yields the agent event stream; for each event we broadcast
//      agent_event to the thread room, accumulate per-agent text + tool events,
//      and emit agent_status working→idle as each agent's stream begins/ends (G7)
//   4. persist each agent's full reply + durable tool-event-feed rows
//   5. updateLastActive + thread_update broadcast
//   6. RETURN { userMessage, replies } so an HTTP caller sends them and an adapter
//      sends them back to the platform (platform user is not on the websocket)
//
// Message persistence is M8's job (the M4 router explicitly does NOT persist).
// A per-thread cancel controller (Socket.io `cancel`) aborts the live route.

import type { AgentId, AgentMessage, AgentState, StoredMessage, StoredToolEvent } from '@clowder/shared';
import { parseUserMentions } from '@clowder/api/routing/mention-parser';
import type { RouteLogger } from '@clowder/api/routing/agent-router';
import type { AppServices } from '@clowder/api/infrastructure/app-services';
import type { SqliteToolEventLog } from '@clowder/api/stores/sqlite-tool-event-log';
import {
  checkReplyNotDuplicated,
  checkToolWritePathInside,
} from '@clowder/api/infrastructure/invariants';

/** Default userId attributed to inbound user messages when none is supplied. */
export const DEFAULT_USER_ID = 'user';

/** Input to {@link handleThreadMessage} — one inbound user message for a thread. */
export interface HandleThreadMessageInput {
  readonly threadId: string;
  readonly userId: string;
  readonly content: string;
}

/** Result of {@link handleThreadMessage}: the persisted user message + replies. */
export interface HandleThreadMessageResult {
  readonly userMessage: StoredMessage;
  readonly replies: StoredMessage[];
}

/** Tool-call event captured for an agent reply's extra.toolEvents bag. */
interface CapturedToolEvent {
  readonly type: AgentMessage['type'];
  readonly toolName?: string;
  readonly toolUseId?: string;
  readonly toolInput?: Record<string, unknown>;
  readonly content?: string;
  readonly invocationId?: string;
  readonly timestamp: number;
}

/** Mutable per-agent accumulator while a route streams. */
interface ReplyAccumulator {
  text: string;
  readonly toolEvents: CapturedToolEvent[];
  lastTimestamp: number;
  /** invocationId of the turn that produced this reply (stamped by the invoke seam). */
  invocationId?: string;
  /** sessionId of the turn (补充 E E3.3) — tags the reply + tool events. */
  sessionId?: string;
}

/** Tool-ish event types whose payloads we persist under extra.toolEvents (M7 contract). */
const TOOL_EVENT_TYPES: ReadonlySet<AgentMessage['type']> = new Set([
  'tool_use',
  'tool_result',
]);

/**
 * Run the full message pipeline for one inbound user message and return the
 * persisted user message + agent replies. Shared by the HTTP route and platform
 * ingress so both behave identically.
 */
export async function handleThreadMessage(
  services: AppServices,
  input: HandleThreadMessageInput,
): Promise<HandleThreadMessageResult> {
  const { router, registry, messageStore, threadStore, toolEventLog, socket, logger, now } =
    services;
  const { threadId, userId, content } = input;
  const { defaultWorkspace } = services;

  // 1. Auto-create the thread on first message (ported ensureThread idiom).
  await threadStore.ensureThread(threadId, deriveTitle(content));

  // 2. Persist the user message with its parsed mentions.
  const mentions = parseUserMentions(content, registry.getMentionEntries());
  const userMessage = await messageStore.append({
    threadId,
    userId,
    agentId: null,
    content,
    mentions,
    origin: 'user',
    timestamp: now(),
  });

  // 3. Drive the router; broadcast + accumulate replies; emit agent_status (G7).
  const controller = socket.registerCancel(threadId);
  const accumulators = new Map<AgentId, ReplyAccumulator>();
  const participants = new Set<AgentId>();
  // Agents currently emitting 'working' so we don't re-emit on every frame and so
  // we can flip every still-working agent to 'idle' once the route ends.
  const working = new Set<AgentId>();

  try {
    for await (const event of router.route(userId, content, threadId, {
      signal: controller.signal,
    })) {
      await socket.broadcastAgentEvent(threadId, event);
      // G7: first event from an agent → it has started its turn (working); a
      // 'done' event → that agent's stream ended (idle). C2/C6 socket protocol:
      // io.to(threadId).emit('agent_status', state: AgentState).
      await emitWorkingIfNew(socket, working, threadId, event, now);
      accumulate(accumulators, participants, event);
      if (event.type === 'done') {
        await emitIdle(socket, working, threadId, event.agentId, now);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await socket.broadcastError(threadId, message);
  } finally {
    socket.releaseCancelController(threadId, controller);
    // G7: any agent that started but never emitted a terminal 'done' (e.g. the
    // route was cancelled or errored mid-stream) is flipped back to idle so the
    // UI never sticks on 'working'.
    for (const agentId of working) {
      await emitIdle(socket, working, threadId, agentId, now);
    }
  }

  // Persist each agent's full reply (one StoredMessage per agent).
  const persisted = await persistReplies(messageStore, threadId, userId, accumulators);

  // Durable second sink: append one StoredToolEvent per tool call to the A6
  // ToolEventLog (live-feed). This ADDS to — never replaces — extra.toolEvents
  // (M7 context depends on the latter). Best-effort: a feed failure must not
  // fail the user's request, so it is isolated from the response path.
  await persistToolEvents(toolEventLog, threadId, accumulators, logger);

  // Operability probes (invariants 2 + 3): inspect each agent's reply for verbatim
  // self-duplication and each tool write for a workspace escape, emitting WARN via
  // the injected logger. Silent in tests (NOOP_LOGGER) unless a logger is injected.
  // The expected workspace is the thread's projectPath when set, else the
  // configured defaultWorkspace.
  const probedThread = await threadStore.get(threadId);
  const workspace = probedThread?.projectPath ?? defaultWorkspace;
  runReplyAndToolProbes(logger, threadId, accumulators, workspace);

  // 4. Track participants + bump lastActive, then broadcast the thread update.
  if (participants.size > 0) {
    await threadStore.addParticipants(threadId, [...participants]);
  }
  await threadStore.updateLastActive(threadId);
  const updatedThread = await threadStore.get(threadId);
  if (updatedThread !== null) {
    await socket.broadcastThreadUpdate(threadId, updatedThread);
  }

  return { userMessage, replies: persisted };
}

/**
 * Emit agent_status 'working' the first time we see an event from an agent in
 * this route. Idempotent per agent (the `working` set guards re-emits).
 */
async function emitWorkingIfNew(
  socket: AppServices['socket'],
  working: Set<AgentId>,
  threadId: string,
  event: AgentMessage,
  now: () => number,
): Promise<void> {
  if (working.has(event.agentId)) return;
  working.add(event.agentId);
  await socket.broadcastAgentStatus(threadId, buildState(event.agentId, 'working', threadId, now));
}

/** Emit agent_status 'idle' for an agent and clear it from the working set. */
async function emitIdle(
  socket: AppServices['socket'],
  working: Set<AgentId>,
  threadId: string,
  agentId: AgentId,
  now: () => number,
): Promise<void> {
  if (!working.has(agentId)) return;
  working.delete(agentId);
  await socket.broadcastAgentStatus(threadId, buildState(agentId, 'idle', threadId, now));
}

/** Build the AgentState payload broadcast on the agent_status event (C2/C6). */
function buildState(
  agentId: AgentId,
  status: AgentState['status'],
  threadId: string,
  now: () => number,
): AgentState {
  return { id: agentId, status, currentThreadId: threadId, lastActiveAt: now() };
}

/** Fold one streamed event into its agent's accumulator. */
function accumulate(
  accumulators: Map<AgentId, ReplyAccumulator>,
  participants: Set<AgentId>,
  event: AgentMessage,
): void {
  participants.add(event.agentId);
  const acc = accumulators.get(event.agentId) ?? {
    text: '',
    toolEvents: [],
    lastTimestamp: event.timestamp,
  };
  acc.lastTimestamp = Math.max(acc.lastTimestamp, event.timestamp);
  // Capture the turn's invocationId (stamped by the invoke seam); first one wins.
  if (acc.invocationId === undefined && event.invocationId !== undefined) {
    acc.invocationId = event.invocationId;
  }
  // Capture the turn's sessionId (补充 E E3.3); the latest non-undefined wins so a
  // fresh session_init after a sealed resume tags the reply with the new session.
  if (event.sessionId !== undefined) {
    acc.sessionId = event.sessionId;
  }

  if (event.type === 'text' && event.content !== undefined) {
    acc.text += event.content;
  } else if (TOOL_EVENT_TYPES.has(event.type)) {
    acc.toolEvents.push({
      type: event.type,
      ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
      ...(event.toolUseId !== undefined ? { toolUseId: event.toolUseId } : {}),
      ...(event.toolInput !== undefined ? { toolInput: event.toolInput } : {}),
      ...(event.content !== undefined ? { content: event.content } : {}),
      ...(event.invocationId !== undefined ? { invocationId: event.invocationId } : {}),
      timestamp: event.timestamp,
    });
  }
  accumulators.set(event.agentId, acc);
}

/** Persist one StoredMessage per agent that produced output. */
async function persistReplies(
  messageStore: AppServices['messageStore'],
  threadId: string,
  userId: string,
  accumulators: Map<AgentId, ReplyAccumulator>,
): Promise<StoredMessage[]> {
  const persisted: StoredMessage[] = [];
  for (const [agentId, acc] of accumulators) {
    // Only persist a reply when the agent produced text or tool activity.
    if (acc.text.length === 0 && acc.toolEvents.length === 0) continue;
    const stored = await messageStore.append({
      threadId,
      userId,
      agentId,
      content: acc.text,
      mentions: [],
      origin: 'stream',
      timestamp: acc.lastTimestamp,
      ...(acc.toolEvents.length > 0 ? { extra: { toolEvents: acc.toolEvents } } : {}),
      ...(acc.sessionId !== undefined ? { sessionId: acc.sessionId } : {}),
    });
    persisted.push(stored);
  }
  return persisted;
}

/**
 * Append one {@link StoredToolEvent} per captured tool_use to the A6 ToolEventLog.
 *
 * Correlation: a tool_use is paired with its tool_result to compute durationMs.
 * Pairing is by tool-use id when the events carry one (the precise correlation);
 * otherwise FIFO per agent within the reply (mirroring the Clowder approach when
 * a provider omits ids). An unpaired tool_use is still appended with durationMs
 * undefined (it is optional). tool_result rows are not persisted on their own —
 * they only enrich their tool_use's row.
 *
 * Best-effort: a per-event append failure must NOT break the user request path
 * (the primary sink, extra.toolEvents, is already persisted), so the failure is
 * NOT rethrown. It is, however, LOGGED through the {@link RouteLogger} seam —
 * never silently swallowed (CLAUDE.md "never silently swallow errors"; mirrors
 * the Clowder ToolEventLog "errors logged, never thrown" contract).
 */
async function persistToolEvents(
  toolEventLog: SqliteToolEventLog,
  threadId: string,
  accumulators: Map<AgentId, ReplyAccumulator>,
  logger: RouteLogger,
): Promise<void> {
  for (const [agentId, acc] of accumulators) {
    if (acc.invocationId === undefined) continue; // no invocation context → skip
    const invocationId = acc.invocationId;
    const results = indexResults(acc.toolEvents);

    for (const ev of acc.toolEvents) {
      if (ev.type !== 'tool_use' || ev.toolName === undefined) continue;
      const result = takeMatchingResult(results, ev);
      const durationMs =
        result !== undefined ? Math.max(0, result.timestamp - ev.timestamp) : undefined;

      const toPersist: Omit<StoredToolEvent, 'id'> = {
        invocationId,
        threadId,
        agentId,
        toolName: ev.toolName,
        ...(ev.toolInput !== undefined ? { toolInput: JSON.stringify(ev.toolInput) } : {}),
        ...(result?.content !== undefined ? { toolResult: result.content } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        timestamp: ev.timestamp,
        ...(acc.sessionId !== undefined ? { sessionId: acc.sessionId } : {}),
      };
      try {
        await toolEventLog.append(toPersist);
      } catch (err) {
        // Durable feed is best-effort: the primary extra.toolEvents sink already
        // captured this call, so we do NOT fail the request on a feed-write error.
        // But the failure is logged (never silently swallowed) so an operator can
        // see the durable sink is degraded.
        const reason = err instanceof Error ? err.message : String(err);
        logger({
          level: 'warn',
          message: `tool-event-feed append failed for tool "${ev.toolName}": ${reason}`,
          threadId,
          agentId,
        });
      }
    }
  }
}

/**
 * Build the lookup of tool_result events for pairing. Keyed by toolUseId when
 * present; an `anon` FIFO queue holds results lacking an id (FIFO fallback).
 */
interface ResultIndex {
  readonly byId: Map<string, CapturedToolEvent>;
  readonly anon: CapturedToolEvent[];
}

function indexResults(events: readonly CapturedToolEvent[]): ResultIndex {
  const byId = new Map<string, CapturedToolEvent>();
  const anon: CapturedToolEvent[] = [];
  for (const ev of events) {
    if (ev.type !== 'tool_result') continue;
    if (ev.toolUseId !== undefined) {
      byId.set(ev.toolUseId, ev);
    } else {
      anon.push(ev);
    }
  }
  return { byId, anon };
}

/**
 * Find (and consume) the tool_result matching a tool_use: by id first, else the
 * next anonymous result FIFO. Consuming prevents one result pairing twice.
 */
function takeMatchingResult(
  results: ResultIndex,
  toolUse: CapturedToolEvent,
): CapturedToolEvent | undefined {
  if (toolUse.toolUseId !== undefined) {
    const byId = results.byId.get(toolUse.toolUseId);
    if (byId !== undefined) {
      results.byId.delete(toolUse.toolUseId);
      return byId;
    }
  }
  return results.anon.shift();
}

/**
 * Tool-input keys that carry a file-write path across our providers' tool
 * vocabularies (Claude `Write`/`Edit` use `file_path`; generic write tools use
 * `path`/`filePath`). The escape probe reads the first present one.
 */
const WRITE_PATH_KEYS: readonly string[] = ['file_path', 'path', 'filePath'];

/** Tool names whose calls write to the filesystem (subject to the escape probe). */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'write_file',
  'edit_file',
  'NotebookEdit',
]);

/** Extract a file-write path string from a tool input bag, if one is present. */
function extractWritePath(toolInput: Record<string, unknown> | undefined): string | undefined {
  if (toolInput === undefined) return undefined;
  for (const key of WRITE_PATH_KEYS) {
    const value = toolInput[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Run the per-reply operability probes (invariants 2 + 3) over the accumulated
 * replies + their captured tool events. Pure dispatch — each probe owns its own
 * check and only emits a WARN through `logger` on violation (silent otherwise).
 */
function runReplyAndToolProbes(
  logger: RouteLogger,
  threadId: string,
  accumulators: Map<AgentId, ReplyAccumulator>,
  workspace: string | undefined,
): void {
  for (const [agentId, acc] of accumulators) {
    const ctx = { threadId, agentId };
    if (acc.text.length > 0) {
      checkReplyNotDuplicated(logger, ctx, acc.text);
    }
    for (const ev of acc.toolEvents) {
      if (ev.type !== 'tool_use' || ev.toolName === undefined) continue;
      if (!WRITE_TOOL_NAMES.has(ev.toolName)) continue;
      const writePath = extractWritePath(ev.toolInput);
      if (writePath !== undefined) {
        checkToolWritePathInside(logger, ctx, writePath, workspace, ev.toolName);
      }
    }
  }
}

/** Derive a short thread title from the first message (auto-create case). */
function deriveTitle(content: string): string {
  const firstLine = content.split('\n')[0]?.trim() ?? '';
  const MAX_TITLE_LEN = 60; // keep titles compact for the sidebar
  return firstLine.length > MAX_TITLE_LEN
    ? `${firstLine.slice(0, MAX_TITLE_LEN)}…`
    : firstLine || '新会话';
}
