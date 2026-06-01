// M8 message-routes — send a message (drive routing) + fetch history.
//
// Source: clowder-design-supplement.md §C1:
//   POST /api/threads/:id/messages → persist user msg, drive AgentRouter.route(),
//                                    stream agent_event over Socket.io, persist replies
//   GET  /api/threads/:id/messages → history
//
// The core pipeline (ensureThread → persist user msg → route → broadcast +
// accumulate → persist replies + tool-event feed → thread_update) lives in the
// reusable handleThreadMessage (message-handler.ts) so the platform ingress
// (submitPlatformMessage) drives the IDENTICAL flow. This route only owns the
// HTTP boundary: validate params/body, delegate, shape the JSON response. The
// frozen M8 contract (request/response shape, status codes) is unchanged.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '@clowder/api/infrastructure/app-services';
import { handleThreadMessage, DEFAULT_USER_ID } from '@clowder/api/routes/message-handler';

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

/**
 * Register the message routes on `app`.
 */
export function registerMessageRoutes(app: FastifyInstance, services: AppServices): void {
  const { messageStore } = services;

  app.post('/api/threads/:id/messages', async (request, reply) => {
    const params = ThreadParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' });
    }
    const body = SendMessageBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }

    const { userMessage, replies } = await handleThreadMessage(services, {
      threadId: params.data.id,
      userId: body.data.userId ?? DEFAULT_USER_ID,
      content: body.data.content,
    });

    return reply.code(200).send({ userMessage, replies });
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
