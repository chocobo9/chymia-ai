// audit-routes — the BROWSER-facing per-thread audit timeline (M8).
//
// "谁在什么时候做了什么" for a thread, merged chronologically from the data we
// already persist: the tool-event log (each tool call + duration), the agent
// replies (each invocation outcome — text size + tool count, system/error notices
// flagged), and the session boundaries (start / seal). This is the queryable,
// UI-surfaced trail — distinct from the rolling ops LOG FILE. Read-only (a ledger).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuditEntry } from '@choco/shared';
import type { AppServices } from '@choco/api/infrastructure/app-services';

const ThreadParamsSchema = z.object({ threadId: z.string().min(1) });

/** Upper bound on messages scanned for the audit (a thread's full history is small). */
const AUDIT_MESSAGE_LIMIT = 2000;

/** Register GET /api/audit/thread/:threadId — the merged audit timeline. */
export function registerAuditRoutes(app: FastifyInstance, services: AppServices): void {
  const { toolEventLog, messageStore, sessionStore } = services;

  app.get('/api/audit/thread/:threadId', async (request, reply) => {
    const params = ThreadParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
    const threadId = params.data.threadId;

    const [toolEvents, messages] = await Promise.all([
      toolEventLog.readByThread(threadId),
      messageStore.getByThread(threadId, AUDIT_MESSAGE_LIMIT),
    ]);
    const sessions = sessionStore.listByThread(threadId);

    const entries: AuditEntry[] = [];

    // Agent invocation outcomes (one per agent turn output; user messages skipped).
    for (const message of messages) {
      if (message.agentId === null) continue;
      const rawToolEvents = message.extra?.['toolEvents'];
      const toolCount = Array.isArray(rawToolEvents) ? rawToolEvents.length : 0;
      entries.push({
        type: 'reply',
        agentId: message.agentId,
        timestamp: message.timestamp,
        textChars: message.content.length,
        toolCount,
        ...(message.origin === 'system' ? { isError: true } : {}),
      });
    }

    // The granular tool calls.
    for (const event of toolEvents) {
      entries.push({
        type: 'tool',
        agentId: event.agentId,
        timestamp: event.timestamp,
        toolName: event.toolName,
        invocationId: event.invocationId,
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
      });
    }

    // Session lifecycle boundaries.
    for (const session of sessions) {
      entries.push({
        type: 'session_start',
        agentId: session.agentId,
        timestamp: session.createdAt,
        sessionId: session.sessionId,
        sequenceNo: session.sequenceNo,
      });
      if (session.sealedAt !== undefined) {
        entries.push({
          type: 'session_seal',
          agentId: session.agentId,
          timestamp: session.sealedAt,
          sessionId: session.sessionId,
          sequenceNo: session.sequenceNo,
        });
      }
    }

    entries.sort((a, b) => a.timestamp - b.timestamp);
    return reply.send({ entries });
  });
}
