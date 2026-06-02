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
import type { AppServices } from '@choco/api/infrastructure/app-services';
import { advanceStageWithEval } from '@choco/api/sop/advance-stage.js';

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
 * Body schema for PATCH /api/threads/:id/sop-stage. `stageId: null` clears the
 * stage (no SOP hint); a non-null stageId must be a KNOWN stage of the SOP
 * definition (validated against the SopService below).
 */
const SetSopStageBodySchema = z
  .object({ stageId: z.string().min(1).nullable() })
  .strict();

/** Body schema for PATCH /api/threads/:id (inline rename): a non-empty title. */
const RenameThreadBodySchema = z.object({ title: z.string().min(1) }).strict();

/**
 * Register Thread CRUD routes on `app` using the wired {@link AppServices}.
 */
export function registerThreadRoutes(app: FastifyInstance, services: AppServices): void {
  const { threadStore, socket, sopService } = services;

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

  // M12 告示牌 (human setter): set or clear a thread's SOP stage. A non-null
  // stageId must be a known stage of the SOP definition (unknown → 400). On
  // success the stage is persisted and a thread_update is broadcast so connected
  // clients refresh, mirroring create/delete.
  app.patch('/api/threads/:id/sop-stage', async (request, reply) => {
    const params = ThreadParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' });
    }
    const body = SetSopStageBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }
    const { stageId } = body.data;
    if (stageId !== null && !sopService.hasStage(stageId)) {
      return reply.code(400).send({ error: 'unknown_sop_stage', stageId });
    }
    const existing = await threadStore.get(params.data.id);
    if (existing === null) {
      return reply.code(404).send({ error: 'thread_not_found' });
    }
    // SOP-Cycle-2: route through the shared advance helper so the OUTGOING stage
    // (the one being left) is evaluated post-hoc and any violation surfaces as an
    // ADVISORY socket/log signal. The transition + this response are unchanged —
    // the eval is additive, advisory ("只提示不拦截"), and best-effort (never throws).
    await advanceStageWithEval(services, params.data.id, stageId);
    const updated = await threadStore.get(params.data.id);
    if (updated !== null) {
      await socket.broadcastThreadUpdate(updated.id, updated);
    }
    return reply.send(updated);
  });

  // Inline rename: set a thread's title. The body must carry a non-empty title
  // (empty/whitespace-only → 400). On success the new title is persisted and a
  // thread_update is broadcast so connected clients refresh, mirroring
  // create/delete/sop-stage. Distinct from PATCH …/sop-stage above.
  app.patch('/api/threads/:id', async (request, reply) => {
    const params = ThreadParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' });
    }
    const body = RenameThreadBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }
    const existing = await threadStore.get(params.data.id);
    if (existing === null) {
      return reply.code(404).send({ error: 'thread_not_found' });
    }
    await threadStore.updateTitle(params.data.id, body.data.title);
    const updated = await threadStore.get(params.data.id);
    if (updated !== null) {
      await socket.broadcastThreadUpdate(updated.id, updated);
    }
    return reply.send(updated);
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
