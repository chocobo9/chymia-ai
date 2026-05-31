// M8 thread-routes — Thread CRUD.
//
// Source: clowder-design-supplement.md §C1:
//   POST   /api/threads        → create
//   GET    /api/threads        → list
//   GET    /api/threads/:id     → detail
//   DELETE /api/threads/:id     → delete
//
// Persistence is M8's SqliteThreadStore (A7 minimal surface). On create/delete a
// thread_update is broadcast to the room so connected clients refresh sidebars.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '@clowder/api/infrastructure/app-services';

/** Body schema for POST /api/threads (all fields optional). */
const CreateThreadBodySchema = z
  .object({
    title: z.string().min(1).optional(),
    projectPath: z.string().min(1).optional(),
    thinkingMode: z.enum(['debug', 'play']).optional(),
  })
  .strict();

/** Params schema for the :id routes. */
const ThreadParamsSchema = z.object({ id: z.string().min(1) });

/**
 * Register Thread CRUD routes on `app` using the wired {@link AppServices}.
 */
export function registerThreadRoutes(app: FastifyInstance, services: AppServices): void {
  const { threadStore, socket } = services;

  app.post('/api/threads', async (request, reply) => {
    const parsed = CreateThreadBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const thread = await threadStore.create(parsed.data);
    await socket.broadcastThreadUpdate(thread.id, thread);
    return reply.code(201).send(thread);
  });

  app.get('/api/threads', async (_request, reply) => {
    const threads = await threadStore.list();
    return reply.send({ threads });
  });

  app.get('/api/threads/:id', async (request, reply) => {
    const params = ThreadParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' });
    }
    const thread = await threadStore.get(params.data.id);
    if (thread === null) {
      return reply.code(404).send({ error: 'thread_not_found' });
    }
    return reply.send(thread);
  });

  app.delete('/api/threads/:id', async (request, reply) => {
    const params = ThreadParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' });
    }
    const deleted = await threadStore.delete(params.data.id);
    if (!deleted) {
      return reply.code(404).send({ error: 'thread_not_found' });
    }
    return reply.send({ deleted: true, id: params.data.id });
  });
}
