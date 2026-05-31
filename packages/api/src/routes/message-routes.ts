// M8 message-routes — send a message (drive routing) + fetch history.
//
// Source: clowder-design-supplement.md §C1:
//   POST /api/threads/:id/messages → persist user msg, drive AgentRouter.route(),
//                                    stream agent_event over Socket.io, persist replies
//   GET  /api/threads/:id/messages → history
//
// Message persistence is M8's job (the M4 router explicitly does NOT persist):
//   1. ensureThread (auto-create on first message — ported Clowder idiom)
//   2. append the user message (with parsed mentions) to the MessageStore
//   3. router.route() yields the agent event stream; for each event we
//      broadcast agent_event to the thread room and accumulate per-agent text +
//      tool events, persisting each agent's full reply when its stream ends
//      (tool events under extra.toolEvents per the M7 context-scrub contract)
//   4. updateLastActive + thread_update broadcast
// A per-thread cancel controller (Socket.io `cancel`) aborts the live route.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentId, AgentMessage, StoredMessage, StoredToolEvent } from '@clowder/shared';
import { parseUserMentions } from '@clowder/api/routing/mention-parser';
import type { RouteLogger } from '@clowder/api/routing/agent-router';
import type { AppServices } from '@clowder/api/infrastructure/app-services';
import type { SqliteToolEventLog } from '@clowder/api/stores/sqlite-tool-event-log';

/** Default userId attributed to inbound user messages when none is supplied. */
const DEFAULT_USER_ID = 'user';

/** Body schema for POST /api/threads/:id/messages. */
const SendMessageBodySchema = z
  .object({
    content: z.string().min(1),
    userId: z.string().min(1).optional(),
  })
  .strict();

const ThreadParamsSchema = z.object({ id: z.string().min(1) });

const HistoryQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().optional(),
    before: z.string().min(1).optional(),
  })
  .strict();

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
 * Register the message routes on `app`.
 */
export function registerMessageRoutes(app: FastifyInstance, services: AppServices): void {
  const { router, registry, messageStore, threadStore, toolEventLog, socket, logger, now } =
    services;

  app.post('/api/threads/:id/messages', async (request, reply) => {
    const params = ThreadParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' });
    }
    const body = SendMessageBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }

    const threadId = params.data.id;
    const userId = body.data.userId ?? DEFAULT_USER_ID;
    const content = body.data.content;

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

    // 3. Drive the router; broadcast + accumulate replies.
    const controller = socket.registerCancel(threadId);
    const accumulators = new Map<AgentId, ReplyAccumulator>();
    const participants = new Set<AgentId>();

    try {
      for await (const event of router.route(userId, content, threadId, {
        signal: controller.signal,
      })) {
        await socket.broadcastAgentEvent(threadId, event);
        accumulate(accumulators, participants, event);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await socket.broadcastError(threadId, message);
    } finally {
      socket.releaseCancelController(threadId, controller);
    }

    // Persist each agent's full reply (one StoredMessage per agent).
    const persisted = await persistReplies(messageStore, threadId, userId, accumulators);

    // Durable second sink: append one StoredToolEvent per tool call to the A6
    // ToolEventLog (live-feed). This ADDS to — never replaces — extra.toolEvents
    // (M7 context depends on the latter). Best-effort: a feed failure must not
    // fail the user's request, so it is isolated from the response path.
    await persistToolEvents(toolEventLog, threadId, accumulators, logger);

    // 4. Track participants + bump lastActive, then broadcast the thread update.
    if (participants.size > 0) {
      await threadStore.addParticipants(threadId, [...participants]);
    }
    await threadStore.updateLastActive(threadId);
    const updatedThread = await threadStore.get(threadId);
    if (updatedThread !== null) {
      await socket.broadcastThreadUpdate(threadId, updatedThread);
    }

    return reply.code(200).send({
      userMessage,
      replies: persisted,
    });
  });

  app.get('/api/threads/:id/messages', async (request, reply) => {
    const params = ThreadParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' });
    }
    const query = HistoryQuerySchema.safeParse(request.query ?? {});
    if (!query.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: query.error.issues });
    }

    const { limit, before } = query.data;
    const messages =
      before !== undefined
        ? await messageStore.getByThreadBefore(params.data.id, before, limit)
        : await messageStore.getByThread(params.data.id, limit);
    return reply.send({ messages });
  });
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

/** Derive a short thread title from the first message (auto-create case). */
function deriveTitle(content: string): string {
  const firstLine = content.split('\n')[0]?.trim() ?? '';
  const MAX_TITLE_LEN = 60; // keep titles compact for the sidebar
  return firstLine.length > MAX_TITLE_LEN
    ? `${firstLine.slice(0, MAX_TITLE_LEN)}…`
    : firstLine || '新会话';
}
