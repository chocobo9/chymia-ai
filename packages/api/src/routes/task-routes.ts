// task-routes — /api/tasks CRUD for the 任务线 (毛线球) board.
//
// 对齐 Clowder reference/.../routes/tasks.ts (POST/GET/PATCH/DELETE + socket
// broadcast). choco port: persists via SqliteTaskStore (services.taskStore) and
// broadcasts task_created/task_updated/task_deleted into the thread room so live
// web clients sync the board without a reload. The #320 pr_tracking/kind surface
// is out of scope (alignment note) — this is the work-task CRUD only.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentId, CreateTaskInput, UpdateTaskInput } from '@choco/shared';
import { TASK_TITLE_MAX, TASK_WHY_MAX } from '@choco/shared';
import type { AppServices } from '@choco/api/infrastructure/app-services';

const VALID_STATUSES = ['todo', 'doing', 'blocked', 'done'] as const;

/** createdBy: the owner ('user'), the engine ('system'), or an agent id (any non-empty string). */
const createdBySchema = z.string().min(1);

const createSchema = z.object({
  threadId: z.string().min(1),
  title: z.string().min(1).max(TASK_TITLE_MAX),
  why: z.string().max(TASK_WHY_MAX).default(''),
  createdBy: createdBySchema,
  ownerCatId: z.string().min(1).nullable().optional(),
});

const updateSchema = z
  .object({
    title: z.string().min(1).max(TASK_TITLE_MAX).optional(),
    why: z.string().max(TASK_WHY_MAX).optional(),
    status: z.enum(VALID_STATUSES).optional(),
    ownerCatId: z.string().min(1).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

/** Bridge zod output → CreateTaskInput (string→AgentId branded cast at the boundary). */
function toCreateInput(data: z.infer<typeof createSchema>): CreateTaskInput {
  const base: CreateTaskInput = {
    threadId: data.threadId,
    title: data.title,
    why: data.why,
    createdBy: data.createdBy === 'user' || data.createdBy === 'system'
      ? data.createdBy
      : (data.createdBy as AgentId),
  };
  if (data.ownerCatId !== undefined) {
    return { ...base, ownerCatId: data.ownerCatId === null ? null : (data.ownerCatId as AgentId) };
  }
  return base;
}

/** Bridge zod output → UpdateTaskInput (filters undefined; branded cast). */
function toUpdateInput(data: z.infer<typeof updateSchema>): UpdateTaskInput {
  return {
    ...(data.title !== undefined ? { title: data.title } : {}),
    ...(data.why !== undefined ? { why: data.why } : {}),
    ...(data.status !== undefined ? { status: data.status } : {}),
    ...(data.ownerCatId !== undefined
      ? { ownerCatId: data.ownerCatId === null ? null : (data.ownerCatId as AgentId) }
      : {}),
  };
}

/** Register POST/GET/PATCH/DELETE /api/tasks. */
export function registerTaskRoutes(app: FastifyInstance, services: AppServices): void {
  const { taskStore, socket } = services;

  // POST /api/tasks → create (201)
  app.post('/api/tasks', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.issues });
    }
    const task = await taskStore.create(toCreateInput(parsed.data));
    void socket.broadcastTaskCreated(task.threadId, task);
    return reply.code(201).send(task);
  });

  // GET /api/tasks?threadId=... → list a thread's task lines
  app.get('/api/tasks', async (request, reply) => {
    const { threadId } = request.query as { threadId?: string };
    if (threadId === undefined || threadId.length === 0) {
      return reply.code(400).send({ error: 'missing_threadId' });
    }
    const tasks = await taskStore.listByThread(threadId);
    return reply.send({ tasks });
  });

  // GET /api/tasks/progress?threadId=... → a thread's LIVE per-agent task-progress
  // snapshots (each agent's latest TodoWrite plan). Static path registered before
  // /api/tasks/:id so it never matches the param route.
  app.get('/api/tasks/progress', async (request, reply) => {
    const { threadId } = request.query as { threadId?: string };
    if (threadId === undefined || threadId.length === 0) {
      return reply.code(400).send({ error: 'missing_threadId' });
    }
    const snapshots = services.taskProgressStore.listByThread(threadId);
    return reply.send({ snapshots });
  });

  // GET /api/tasks/:id → single task / 404
  app.get('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const task = await taskStore.get(id);
    if (task === null) return reply.code(404).send({ error: 'not_found' });
    return reply.send(task);
  });

  // PATCH /api/tasks/:id → update status/title/why/owner
  app.patch('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.issues });
    }
    const updated = await taskStore.update(id, toUpdateInput(parsed.data));
    if (updated === null) return reply.code(404).send({ error: 'not_found' });
    void socket.broadcastTaskUpdated(updated.threadId, updated);
    return reply.send(updated);
  });

  // DELETE /api/tasks/:id → remove (204)
  app.delete('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    // Read first so the delete broadcast can name the thread room.
    const existing = await taskStore.get(id);
    const deleted = await taskStore.delete(id);
    if (!deleted || existing === null) return reply.code(404).send({ error: 'not_found' });
    void socket.broadcastTaskDeleted(existing.threadId, id);
    return reply.code(204).send();
  });
}
