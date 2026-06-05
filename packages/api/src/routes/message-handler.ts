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

import type { AgentId, AgentMessage, AgentState, StoredMessage, StoredToolEvent } from '@choco/shared';
import { parseUserMentions } from '@choco/api/routing/mention-parser';
import type { RouteLogger } from '@choco/api/routing/agent-router';
import {
  buildUnavailableNotice,
  noticeToAgentEvent,
  type UnavailableNotice,
} from '@choco/api/routing/unavailable-notice';
import type { AppServices } from '@choco/api/infrastructure/app-services';
import type { SqliteToolEventLog } from '@choco/api/stores/sqlite-tool-event-log';
import {
  checkReplyNotDuplicated,
  checkToolWritePathInside,
} from '@choco/api/infrastructure/invariants';

/** Default userId attributed to inbound user messages when none is supplied. */
export const DEFAULT_USER_ID = 'user';

/** Input to {@link handleThreadMessage} — one inbound user message for a thread. */
export interface HandleThreadMessageInput {
  readonly threadId: string;
  readonly userId: string;
  readonly content: string;
  /**
   * Optional per-agent text-delta sink. When supplied, it is invoked for EVERY
   * streamed `text` event as the route runs (agentId + the delta chunk) — letting
   * a platform adapter drive a live surface (e.g. a 飞书 streaming card) without
   * waiting for the collected replies. Omitted by the HTTP route and the other
   * adapters → behavior is byte-for-byte unchanged (pure increment).
   */
  readonly onTextDelta?: (agentId: AgentId, text: string) => void;
  /**
   * When true, broadcast the inbound USER message over the socket so live web
   * clients render it. Set by the platform ingress (飞书/Telegram/微信) — those
   * users are off-web and no client renders their message otherwise. The HTTP
   * route leaves it false: the web client already shows its own send optimistically.
   */
  readonly broadcastInbound?: boolean;
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
  /** Concatenated `thinking` frame text (reasoning) — persisted under extra.thinking. */
  thinking: string;
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

/** Well-known keys in {@link StoredMessage.extra} for a persisted agent reply. */
const EXTRA_TOOL_EVENTS_KEY = 'toolEvents';
const EXTRA_THINKING_KEY = 'thinking';
/**
 * The turn's invocationId, stamped onto the persisted reply so the web client can
 * match this authoritative StoredMessage to the live streaming bubble of the same
 * (agent, invocation) and replace it — instead of double-rendering the turn.
 */
const EXTRA_INVOCATION_ID_KEY = 'invocationId';

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
  const { threadId, userId, content, onTextDelta, broadcastInbound } = input;
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

  // Mirror an off-web platform (飞书/Telegram/微信) user message into the live
  // transcript: web clients never sent it, so without this it appears only on
  // reload. The HTTP route omits broadcastInbound (the web shows its own send
  // optimistically). Best-effort ordering with the thread's other frames.
  if (broadcastInbound === true) {
    await socket.broadcastThreadMessage(threadId, userMessage);
  }

  // 2b. §C: if the user explicitly @mentioned an UNAVAILABLE agent (its provider
  // CLI is not installed on this system), surface a VISIBLE notice with the
  // available alternatives (Clowder's `cat_disabled` with alternatives) — instead
  // of the silent spawn-fail the dogfooding user hit. The notice is broadcast as a
  // `system_info` agent_event (live transcript) AND persisted as a `system`-origin
  // StoredMessage (survives reload), and returned among the replies. A turn that
  // ALSO mentioned available agents still routes to them below + shows this notice;
  // a turn whose ONLY mention was unavailable shows the notice and routes nowhere.
  const noticeReply = await surfaceUnavailableNotice(services, threadId, userId, content, now);

  // 3. Drive the router; broadcast + accumulate replies; emit agent_status (G7).
  // Cancellation is per-agent (the collateral-cancel fix): `controller` is the
  // thread-wide BATCH gate (stop-all + the serial-chain loop guard), and
  // `signalForAgent` hands each agent a signal that aborts on EITHER its own
  // targeted stop OR the batch — so a stop-all still catches an agent that hadn't
  // started yet when it fired. Stopping ONE agent leaves its siblings running.
  const controller = socket.registerCancel(threadId);
  const registeredAgents = new Set<AgentId>();
  const signalForAgent = (agentId: AgentId): AbortSignal => {
    registeredAgents.add(agentId);
    const perAgent = socket.registerAgentCancel(threadId, agentId);
    return AbortSignal.any([perAgent.signal, controller.signal]);
  };
  const accumulators = new Map<AgentId, ReplyAccumulator>();
  const participants = new Set<AgentId>();
  // Agents currently emitting 'working' so we don't re-emit on every frame and so
  // we can flip every still-working agent to 'idle' once the route ends.
  const working = new Set<AgentId>();

  // Status real-time fix: emit 'working' for the agents about to run UP FRONT,
  // the moment the turn starts — not on each agent's FIRST OUTPUT frame. A
  // non-streaming agent (codex emits its whole reply at the end) otherwise showed
  // 'working' only when it finished. A2A-expanded agents still flip via the
  // per-frame fallback below. Available targets only (unavailable never run).
  const { targets: initialTargets } = await router.resolveRouting(content, threadId);
  for (const agentId of initialTargets) {
    await emitWorkingFor(socket, working, threadId, agentId, now);
  }

  try {
    for await (const event of router.route(userId, content, threadId, {
      signal: controller.signal,
      signalForAgent,
    })) {
      await socket.broadcastAgentEvent(threadId, event);
      // G7: first event from an agent → it has started its turn (working); a
      // 'done' event → that agent's stream ended (idle). C2/C6 socket protocol:
      // io.to(threadId).emit('agent_status', state: AgentState).
      await emitWorkingIfNew(socket, working, threadId, event, now);
      accumulate(accumulators, participants, event);
      // Phase 2 (飞书 streaming): forward each text delta to the optional sink as
      // it streams. Same predicate as the accumulator's text branch so the adapter
      // sees exactly the chunks that compose the final reply. No-op when unset.
      if (onTextDelta !== undefined && event.type === 'text' && event.content !== undefined) {
        onTextDelta(event.agentId, event.content);
      }
      if (event.type === 'done') {
        await emitIdle(socket, working, threadId, event.agentId, now);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await socket.broadcastError(threadId, message);
  } finally {
    socket.releaseCancelController(threadId, controller);
    for (const agentId of registeredAgents) {
      socket.releaseAgentCancel(threadId, agentId);
    }
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

  // The unavailable-agent notice (if any) is part of the turn's visible output:
  // include it among the replies so an HTTP caller renders it and a platform
  // adapter (M13/M14) sends it back. Ordered before the agent replies (it explains
  // what was skipped) — the persisted timestamps already place it first.
  const replies = noticeReply !== null ? [noticeReply, ...persisted] : persisted;

  return { userMessage, replies };
}

/**
 * §C: detect an explicit @mention of an UNAVAILABLE agent and, if present, make
 * it VISIBLE — broadcast a `system_info` notice (live) + persist a `system`-origin
 * StoredMessage (durable) carrying the notice text with the available
 * alternatives. Returns the persisted notice message (so the caller includes it
 * in the replies), or null when there's nothing to surface (all mentions were
 * available, or it was a no-mention message).
 */
async function surfaceUnavailableNotice(
  services: AppServices,
  threadId: string,
  userId: string,
  content: string,
  now: () => number,
): Promise<StoredMessage | null> {
  const { router, registry, messageStore, socket } = services;
  const { unavailable } = await router.resolveRouting(content, threadId);
  if (unavailable.length === 0) return null;

  const notice: UnavailableNotice | undefined = buildUnavailableNotice({
    unavailable,
    alternatives: router.availableAlternatives(unavailable),
    resolve: (id) => registry.get(id),
  });
  if (notice === undefined) return null;

  // Live: broadcast as a system_info agent_event (never rate-limited).
  await socket.broadcastAgentEvent(threadId, noticeToAgentEvent(notice, now()));

  // Durable: persist as a `system`-origin message so a reload still shows it.
  return messageStore.append({
    threadId,
    userId,
    agentId: notice.agentId,
    content: notice.text,
    mentions: [],
    origin: 'system',
    timestamp: now(),
  });
}

/**
 * Emit agent_status 'working' for an agent if not already marked. Idempotent per
 * agent (the `working` set guards re-emits) — used both up front (for the resolved
 * targets) and as the per-frame fallback for A2A-expanded agents.
 */
async function emitWorkingFor(
  socket: AppServices['socket'],
  working: Set<AgentId>,
  threadId: string,
  agentId: AgentId,
  now: () => number,
): Promise<void> {
  if (working.has(agentId)) return;
  working.add(agentId);
  await socket.broadcastAgentStatus(threadId, buildState(agentId, 'working', threadId, now));
}

/** Emit 'working' the first time we see an event from an agent (per-frame fallback). */
async function emitWorkingIfNew(
  socket: AppServices['socket'],
  working: Set<AgentId>,
  threadId: string,
  event: AgentMessage,
  now: () => number,
): Promise<void> {
  await emitWorkingFor(socket, working, threadId, event.agentId, now);
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
    thinking: '',
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
  } else if (event.type === 'thinking' && event.content !== undefined) {
    // Persist reasoning so a completed reply can re-show its Think block (the
    // streaming view shows it live; without this it vanishes on completion).
    acc.thinking += event.content;
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

/**
 * Build the `extra` bag for a persisted reply from its accumulator: tool events
 * (the M7 context channel) plus the concatenated reasoning under `thinking` so a
 * completed reply can re-show its Think block. Returns undefined when neither is
 * present (keep `extra` absent rather than an empty object).
 */
function buildReplyExtra(acc: ReplyAccumulator): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  if (acc.toolEvents.length > 0) {
    extra[EXTRA_TOOL_EVENTS_KEY] = acc.toolEvents;
  }
  if (acc.thinking.length > 0) {
    extra[EXTRA_THINKING_KEY] = acc.thinking;
  }
  // Carry the turn's invocationId so the client can replace the settled live
  // bubble of the same (agent, invocation) rather than render a duplicate.
  if (acc.invocationId !== undefined) {
    extra[EXTRA_INVOCATION_ID_KEY] = acc.invocationId;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
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
    const extra = buildReplyExtra(acc);
    const stored = await messageStore.append({
      threadId,
      userId,
      agentId,
      content: acc.text,
      mentions: [],
      origin: 'stream',
      timestamp: acc.lastTimestamp,
      ...(extra !== undefined ? { extra } : {}),
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
