// session-routes — the BROWSER-facing session-chain surface (M8).
//
// The MCP session tools (list_session_chain / read_session_digest /
// read_session_events) serve AGENTS over the callback channel. This serves the
// HUMAN UI: view a thread's session chain + a session's transcript/digest, and
// SEAL a live session (the operable action — force-close it so the next turn for
// that (agent, thread) starts a fresh CLI session). Same SessionStore the engine
// and agents use — one source of truth, no parallel half-store.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '@choco/api/infrastructure/app-services';

const ThreadParamsSchema = z.object({ threadId: z.string().min(1) });
const SessionParamsSchema = z.object({ sessionId: z.string().min(1) });

/**
 * Register the browser-facing session routes on `app`:
 *   GET  /api/threads/:threadId/sessions     → the chain (ascending seq) + a digest each
 *   GET  /api/sessions/:sessionId/transcript  → merged messages + tool events
 *   POST /api/sessions/:sessionId/seal        → seal a LIVE session (force-close)
 */
export function registerSessionRoutes(app: FastifyInstance, services: AppServices): void {
  const { sessionStore } = services;

  app.get('/api/threads/:threadId/sessions', async (request, reply) => {
    const params = ThreadParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
    const records = sessionStore.listByThread(params.data.threadId);
    // A digest per session — sealed → the stored digest; active → freshly computed.
    const sessions = await Promise.all(
      records.map(async (record) => ({
        ...record,
        digest: await sessionStore.getDigest(record.sessionId),
      })),
    );
    return reply.send({ sessions });
  });

  app.get('/api/sessions/:sessionId/transcript', async (request, reply) => {
    const params = SessionParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
    const record = sessionStore.getSession(params.data.sessionId);
    if (record === null) return reply.code(404).send({ error: 'session_not_found' });
    const events = await sessionStore.getTranscript(params.data.sessionId);
    return reply.send({
      sessionId: record.sessionId,
      threadId: record.threadId,
      agentId: record.agentId,
      events,
    });
  });

  app.post('/api/sessions/:sessionId/seal', async (request, reply) => {
    const params = SessionParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
    const record = sessionStore.getSession(params.data.sessionId);
    if (record === null) return reply.code(404).send({ error: 'session_not_found' });
    // Only the live session can be sealed; a sealed one is already archived.
    if (record.status !== 'active') {
      return reply.code(409).send({ error: 'not_active', status: record.status });
    }
    sessionStore.sealActiveSession(record.agentId, record.threadId);
    const sealed = sessionStore.getSession(record.sessionId);
    return reply.send({
      sessionId: record.sessionId,
      status: sealed?.status ?? 'sealed',
      ...(sealed?.digest !== undefined ? { digest: sealed.digest } : {}),
    });
  });

  app.post('/api/sessions/:sessionId/reopen', async (request, reply) => {
    const params = SessionParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
    const record = sessionStore.getSession(params.data.sessionId);
    if (record === null) return reply.code(404).send({ error: 'session_not_found' });
    // Only a sealed session can be reopened; an active one is already the live one.
    if (record.status === 'active') {
      return reply.code(409).send({ error: 'already_active' });
    }
    // Reopening seals whatever is currently active for this (agent, thread) first,
    // keeping the ≤1-active invariant; the reopened session becomes the live one.
    const reopened = sessionStore.reopenSession(record.sessionId);
    return reply.send({ sessionId: reopened.sessionId, status: reopened.status });
  });
}
